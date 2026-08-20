CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili_photo_v5()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_match_version constant text := 'v5-photo-mq-price-zone';
  v_evidence_kind constant text := 'IMAGE_PHASH_V1';
  v_algo          constant text := 'phash-dct-8x8-v1';
  v_pair_version  constant text := 'v4-padova-photo-pair';
  v_cand int := 0;
  v_fp_listings int := 0;
  v_pairs int := 0;
  v_groups int := 0;
  v_inserted int := 0;
  v_deleted_legacy int := 0;
  v_changed int;
BEGIN
  CREATE TEMP TABLE _v5_cand ON COMMIT DROP AS
  SELECT * FROM (
    SELECT
      l.id, l.url, l.fonte, l.mq, l.locali, l.bagni, l.prezzo, l.lat, l.lng,
      l.quartiere, l.commercial_zone_slug,
      l.agency AS agency_raw,
      public.norm_agency(
        regexp_replace(lower(btrim(l.agency)), '^(affiliato\s+[^:]{0,40}:\s*|agenzia immobiliare\s+|immobiliare\s+)', '', 'g')
      ) AS agency_key,
      l.last_seen_at,
      public.padova_listing_canonical_id(l.url, l.fonte) AS canonical_listing_id,
      row_number() OVER (
        PARTITION BY public.padova_listing_canonical_id(l.url, l.fonte)
        ORDER BY l.last_seen_at DESC NULLS LAST, l.id DESC
      ) AS _rn
    FROM public.padova_listings l
    WHERE l.expired_at IS NULL
      AND lower(coalesce(l.comune, '')) = 'padova'
      AND l.commercial_zone_slug IS NOT NULL
      AND public.civiko_is_official_zone_slug(l.commercial_zone_slug)
      AND l.prezzo IS NOT NULL AND l.prezzo > 0
      AND l.mq IS NOT NULL AND l.mq > 0
      AND l.agency IS NOT NULL AND btrim(l.agency) <> '' AND l.agency <> 'Agenzie'
      AND COALESCE(l.ev_is_asta, public.padova_listing_has_auction_evidence(l.raw_json, l.agency)) IS NOT TRUE
      AND COALESCE(l.ev_is_mls, public.padova_listing_has_mls_exclusive_evidence(l.raw_json)) IS NOT TRUE
      AND l.url IS NOT NULL
  ) z
  WHERE z._rn = 1
    AND z.canonical_listing_id IS NOT NULL
    AND coalesce(z.agency_key, '') <> '';

  CREATE INDEX ON _v5_cand (id);
  ANALYZE _v5_cand;
  SELECT count(*) INTO v_cand FROM _v5_cand;

  CREATE TEMP TABLE _v5_fp ON COMMIT DROP AS
  SELECT DISTINCT f.listing_id, f.phash
  FROM public.civiko_listing_image_fingerprints f
  JOIN _v5_cand c ON c.id = f.listing_id
  WHERE f.algo = v_algo AND coalesce(f.phash, '') <> '';
  CREATE INDEX ON _v5_fp (phash);
  CREATE INDEX ON _v5_fp (listing_id);
  ANALYZE _v5_fp;
  SELECT count(DISTINCT listing_id) INTO v_fp_listings FROM _v5_fp;

  CREATE TEMP TABLE _v5_pairs ON COMMIT DROP AS
  SELECT a.id AS a_id, b.id AS b_id,
         count(DISTINCT fa.phash)::int AS shared_photos,
         a.agency_key AS agency_a, b.agency_key AS agency_b
  FROM _v5_cand a
  JOIN _v5_cand b
    ON b.id > a.id
   AND b.commercial_zone_slug = a.commercial_zone_slug
   AND b.agency_key <> a.agency_key
   AND b.canonical_listing_id <> a.canonical_listing_id
   AND greatest(a.prezzo, b.prezzo)::numeric <= least(a.prezzo, b.prezzo)::numeric * 1.15
   AND abs(a.mq - b.mq)::numeric <= greatest(a.mq, b.mq)::numeric * 0.05
  JOIN _v5_fp fa ON fa.listing_id = a.id
  JOIN _v5_fp fb ON fb.listing_id = b.id AND fb.phash = fa.phash
  GROUP BY a.id, b.id, a.agency_key, b.agency_key;
  SELECT count(*) INTO v_pairs FROM _v5_pairs;

  DELETE FROM public.civiko_listing_photo_pair_evidence e
   WHERE e.match_version = v_pair_version
     AND NOT EXISTS (SELECT 1 FROM _v5_pairs p WHERE p.a_id = e.listing_a AND p.b_id = e.listing_b);

  INSERT INTO public.civiko_listing_photo_pair_evidence
    (listing_a, listing_b, agency_a, agency_b, shared_photos, distances, algo, soglia, match_version, evidence_kind, computed_at, updated_at)
  SELECT p.a_id, p.b_id, p.agency_a, p.agency_b, p.shared_photos, '[]'::jsonb, v_algo, 0, v_pair_version, v_evidence_kind, now(), now()
  FROM _v5_pairs p
  ON CONFLICT (listing_a, listing_b) DO UPDATE
     SET shared_photos = EXCLUDED.shared_photos,
         agency_a = EXCLUDED.agency_a,
         agency_b = EXCLUDED.agency_b,
         algo = EXCLUDED.algo,
         match_version = EXCLUDED.match_version,
         evidence_kind = EXCLUDED.evidence_kind,
         updated_at = now();

  CREATE TEMP TABLE _v5_lbl ON COMMIT DROP AS
  SELECT DISTINCT id, id AS lbl FROM (
    SELECT a_id AS id FROM _v5_pairs
    UNION SELECT b_id FROM _v5_pairs
  ) s;

  LOOP
    WITH edges AS (
      SELECT a_id AS x, b_id AS y FROM _v5_pairs
      UNION ALL
      SELECT b_id, a_id FROM _v5_pairs
    ),
    best AS (
      SELECT e.x AS id, least(min(l2.lbl), min(l1.lbl)) AS new_lbl
      FROM edges e
      JOIN _v5_lbl l1 ON l1.id = e.x
      JOIN _v5_lbl l2 ON l2.id = e.y
      GROUP BY e.x
    )
    UPDATE _v5_lbl t
       SET lbl = b.new_lbl
      FROM best b
     WHERE b.id = t.id AND b.new_lbl < t.lbl;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    EXIT WHEN v_changed = 0;
  END LOOP;

  CREATE TEMP TABLE _v5_grp ON COMMIT DROP AS
  WITH g AS (
    SELECT l.lbl,
           count(*)::int AS n_rows,
           count(DISTINCT c.agency_key)::int AS n_agenzie,
           count(DISTINCT c.commercial_zone_slug)::int AS n_zone
    FROM _v5_lbl l
    JOIN _v5_cand c ON c.id = l.id
    GROUP BY l.lbl
  ),
  pe AS (
    SELECT la.lbl, count(*)::int AS n_pairs, sum(p.shared_photos)::int AS shared_photos
    FROM _v5_pairs p
    JOIN _v5_lbl la ON la.id = p.a_id
    JOIN _v5_lbl lb ON lb.id = p.b_id AND lb.lbl = la.lbl
    GROUP BY la.lbl
  )
  SELECT g.lbl, g.n_rows, g.n_agenzie, pe.n_pairs, pe.shared_photos
  FROM g
  JOIN pe ON pe.lbl = g.lbl
  WHERE g.n_rows BETWEEN 2 AND 4
    AND g.n_zone = 1
    AND g.n_agenzie >= 2
    AND pe.n_pairs = (g.n_rows * (g.n_rows - 1)) / 2;
  SELECT count(*) INTO v_groups FROM _v5_grp;

  SELECT count(*) INTO v_deleted_legacy
    FROM public.padova_contendibili
   WHERE coalesce(match_version, '') <> v_match_version;

  DELETE FROM public.padova_contendibili;

  INSERT INTO public.padova_contendibili (
    chiave_match, n_agenzie, agenzie, agencies_normalized, agency_count_raw, agency_count_distinct,
    fonti, portals_seen, n_portali, confidenza, prezzo_min, prezzo_max, mq, locali, bagni,
    quartiere, commercial_zone_slug, lat, lng, urls, n_annunci, last_seen_at,
    match_version, evidence_kind, evidence_ref, match_metrics, created_at, updated_at
  )
  SELECT
    v_match_version || ':' || min(c.commercial_zone_slug) || ':' || md5(string_agg(c.id::text, ',' ORDER BY c.id)),
    count(DISTINCT c.agency_key)::int,
    array_agg(DISTINCT c.agency_raw),
    array_agg(DISTINCT c.agency_key),
    count(*)::int,
    count(DISTINCT c.agency_key)::int,
    array_agg(DISTINCT c.fonte),
    array_agg(DISTINCT c.fonte),
    count(DISTINCT c.fonte)::int,
    'ALTA',
    min(c.prezzo)::int,
    max(c.prezzo)::int,
    (avg(c.mq))::int,
    max(c.locali),
    max(c.bagni),
    min(c.quartiere),
    min(c.commercial_zone_slug),
    avg(c.lat),
    avg(c.lng),
    array_agg(DISTINCT c.url),
    count(*)::int,
    max(c.last_seen_at),
    v_match_version,
    v_evidence_kind,
    'photo-pairs:' || min(gg.n_pairs)::text,
    jsonb_build_object(
      'n_pairs', min(gg.n_pairs),
      'shared_photos', min(gg.shared_photos),
      'mq_tol_pct', 5,
      'price_tol_pct', 15,
      'algo', v_algo
    ),
    now(), now()
  FROM _v5_grp gg
  JOIN _v5_lbl l ON l.lbl = gg.lbl
  JOIN _v5_cand c ON c.id = l.id
  GROUP BY gg.lbl
  ON CONFLICT (chiave_match) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'match_version', v_match_version,
    'candidati', v_cand,
    'listing_con_foto', v_fp_listings,
    'coppie_foto', v_pairs,
    'gruppi_validi', v_groups,
    'contendibili_scritti', v_inserted,
    'legacy_eliminati', v_deleted_legacy
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  v := public.recompute_padova_contendibili_photo_v5();
  RETURN jsonb_build_object('ok', true, 'photo_v5', v);
END;
$function$;

DELETE FROM public.padova_contendibili
 WHERE coalesce(match_version, '') <> 'v5-photo-mq-price-zone';