-- ============================================================================
-- CIVIKO ONE / PADOVA — MATCHER v4 AUTORITATIVO (contendibili)
-- Definizione completa e autoritativa: nessuna evidenza fotografica come
-- prerequisito globale. Le evidenze foto sono SEMPRE in LEFT JOIN.
-- ============================================================================

-- 1) Candidati autoritativi ------------------------------------------------
CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_candidates()
RETURNS TABLE (
  id bigint, url text, fonte text, mq int, locali int, bagni int, prezzo bigint,
  l_last_seen_at timestamptz, lat double precision, lng double precision,
  quartiere text, agency_raw text, agency_key text, via_n text, civico_n text,
  czone_slug text, canonical_listing_id text, piano_k text, tipologia text,
  descr_fp text, identity_key text, is_asta boolean, is_mls boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn_cand$
  WITH base AS (
    SELECT p.id::bigint AS id, p.url, p.fonte, p.mq::int AS mq, p.locali::int AS locali,
           p.bagni::int AS bagni, p.prezzo::bigint AS prezzo,
           p.last_seen_at AS l_last_seen_at,
           CASE WHEN p.lat BETWEEN 45.30 AND 45.50 THEN p.lat END AS lat,
           CASE WHEN p.lng BETWEEN 11.75 AND 12.00 THEN p.lng END AS lng,
           p.quartiere,
           p.agency AS agency_raw,
           COALESCE(
             NULLIF(public.norm_agency(regexp_replace(lower(trim(p.agency)),
               '^(agenzia immobiliare|immobiliare)\s+', '', 'g')), ''),
             public.norm_agency(p.agency)
           ) AS agency_key,
           COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) AS via_n,
           COALESCE(p.ev_civico_norm, '') AS civico_n,
           public.civiko_resolve_commercial_zone_slug(p.quartiere) AS czone_slug,
           public.padova_listing_canonical_id(p.url, p.fonte) AS canonical_listing_id,
           COALESCE(p.ev_piano_key, public.padova_unit_floor_key_v2(p.raw_json)) AS piano_k,
           public.padova_unit_tipologia(p.raw_json) AS tipologia,
           COALESCE(p.ev_descr_fp,
             CASE WHEN length(regexp_replace(lower(COALESCE(p.raw_json->>'description', p.raw_json->>'body','')), '[^a-z0-9]+','','g')) >= 160
                  THEN md5(left(regexp_replace(lower(COALESCE(p.raw_json->>'description', p.raw_json->>'body','')), '[^a-z0-9]+','','g'), 400))
             END) AS descr_fp,
           public.padova_listing_has_auction_evidence(p.raw_json, p.agency) AS is_asta,
           public.padova_listing_has_mls_exclusive_evidence(p.raw_json) AS is_mls
      FROM public.padova_listings p
     WHERE p.expired_at IS NULL
       AND p.url IS NOT NULL
       AND lower(coalesce(p.comune,'')) = 'padova'
       AND p.agency IS NOT NULL
       AND p.agency <> 'Agenzie'
       AND p.mq IS NOT NULL AND p.mq > 0
       AND p.locali IS NOT NULL
       AND p.prezzo IS NOT NULL AND p.prezzo > 0
       AND lower(coalesce(NULLIF(trim(COALESCE(p.raw_json->>'title',
             p.raw_json->'suggestedTexts'->>'title', p.raw_json->>'subject')), ''), ''))
           ~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)'
  ),
  filtered AS (
    SELECT b.*
      FROM base b
     WHERE b.czone_slug IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = b.czone_slug)
       AND coalesce(b.agency_key,'') <> ''
       AND b.canonical_listing_id IS NOT NULL
       AND b.is_asta IS NOT TRUE
       AND b.is_mls IS NOT TRUE
  ),
  dedup AS (
    SELECT f.*, row_number() OVER (
             PARTITION BY f.canonical_listing_id
             ORDER BY f.l_last_seen_at DESC NULLS LAST, f.id DESC) AS rn
      FROM filtered f
  )
  SELECT d.id, d.url, d.fonte, d.mq, d.locali, d.bagni, d.prezzo, d.l_last_seen_at,
         d.lat, d.lng, d.quartiere, d.agency_raw, d.agency_key, d.via_n, d.civico_n,
         d.czone_slug, d.canonical_listing_id, d.piano_k, d.tipologia, d.descr_fp,
         CASE WHEN coalesce(d.civico_n,'') <> ''
              THEN d.czone_slug || '|C:' || d.civico_n || '|L:' || d.locali::text
              WHEN d.via_n IS NOT NULL
              THEN d.czone_slug || '|V:' || d.via_n || '|L:' || d.locali::text
         END AS identity_key,
         d.is_asta, d.is_mls
    FROM dedup d
   WHERE d.rn = 1;
$fn_cand$;

GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_candidates() TO service_role;

-- 2) Coppie autoritative ----------------------------------------------------
-- CONTRATTO: le coppie sono STRUTTURALI e indipendenti dalle foto.
-- Le evidenze fotografiche entrano SOLO in LEFT JOIN (mai INNER JOIN, mai
-- shared_photos >= 1 come prerequisito globale).
CREATE OR REPLACE FUNCTION public.civiko_padova_matcher_v4_pairs()
RETURNS TABLE (
  a_id bigint, b_id bigint, shared_photos int, prezzo_ratio numeric,
  dist_m numeric, geo_unita_testo_ok boolean, pair_kind text, match_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn_pairs$
  WITH c AS (
    SELECT * FROM public.civiko_padova_matcher_v4_candidates()
  ),
  src AS (
    -- fonte 1: coppie suggerite dalle evidenze fotografiche (mai obbligatorie)
    SELECT LEAST(e.listing_a, e.listing_b)::bigint AS a, GREATEST(e.listing_a, e.listing_b)::bigint AS b
      FROM public.civiko_listing_photo_pair_evidence e
     WHERE e.evidence_kind = 'IMAGE_PHASH_V1'
    UNION
    -- fonte 2: coppie strutturali, generate senza alcuna foto
    SELECT x.id, y.id
      FROM c x
      JOIN c y
        ON y.id > x.id
       AND y.czone_slug = x.czone_slug
       AND y.locali = x.locali
       AND y.tipologia = x.tipologia
       AND y.piano_k = x.piano_k
     WHERE x.tipologia IS NOT NULL AND x.piano_k IS NOT NULL
  ),
  pairs AS (
    SELECT s.a AS a_id, s.b AS b_id,
           coalesce(e.shared_photos, 0)::int AS shared_photos,
           (greatest(x.prezzo, y.prezzo)::numeric
              / NULLIF(least(x.prezzo, y.prezzo), 0)::numeric) AS prezzo_ratio,
           CASE WHEN x.lat IS NOT NULL AND x.lng IS NOT NULL
                     AND y.lat IS NOT NULL AND y.lng IS NOT NULL
                THEN public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng)::numeric
           END AS dist_m,
           (
             x.lat IS NOT NULL AND x.lng IS NOT NULL
             AND y.lat IS NOT NULL AND y.lng IS NOT NULL
             AND public.padova_haversine_m(x.lat, x.lng, y.lat, y.lng) <= 30
             AND x.piano_k IS NOT NULL AND y.piano_k IS NOT NULL AND x.piano_k = y.piano_k
             AND x.tipologia IS NOT NULL AND y.tipologia IS NOT NULL AND x.tipologia = y.tipologia
             AND x.descr_fp IS NOT NULL AND y.descr_fp IS NOT NULL AND x.descr_fp = y.descr_fp
           ) AS geo_unita_testo_ok
      FROM src s
      JOIN c x ON x.id = s.a
      JOIN c y ON y.id = s.b
      -- evidenze fotografiche: SEMPRE LEFT JOIN, mai prerequisito
      LEFT JOIN public.civiko_listing_photo_pair_evidence e
        ON e.evidence_kind = 'IMAGE_PHASH_V1'
       AND LEAST(e.listing_a, e.listing_b) = s.a
       AND GREATEST(e.listing_a, e.listing_b) = s.b
     WHERE x.czone_slug = y.czone_slug
       AND x.agency_key <> y.agency_key
       AND x.canonical_listing_id <> y.canonical_listing_id
       -- stessa identita immobiliare non e' contendibile
       AND (x.identity_key IS NULL OR y.identity_key IS NULL OR x.identity_key <> y.identity_key
            OR coalesce(x.civico_n,'') = '' OR coalesce(y.civico_n,'') = ''
            OR x.civico_n <> y.civico_n)
       AND x.locali = y.locali
       AND x.tipologia IS NOT NULL AND y.tipologia IS NOT NULL AND x.tipologia = y.tipologia
       AND x.piano_k IS NOT NULL AND y.piano_k IS NOT NULL AND x.piano_k = y.piano_k
       AND greatest(x.mq, y.mq)::numeric
             <= greatest(least(x.mq, y.mq)::numeric + 5, least(x.mq, y.mq)::numeric * 1.05)
       AND (x.bagni IS NULL OR y.bagni IS NULL OR x.bagni = y.bagni)
  )
  SELECT p.a_id, p.b_id, p.shared_photos, round(p.prezzo_ratio, 4) AS prezzo_ratio,
         p.dist_m, p.geo_unita_testo_ok,
         CASE
           WHEN p.prezzo_ratio <= 1.10 THEN 'STRUTTURALE_10'
           WHEN p.shared_photos >= 2 THEN 'FOTO_PHASH_2'
           ELSE 'GEO_UNITA_TESTO'
         END AS pair_kind,
         'v4'::text AS match_version
    FROM pairs p
   WHERE p.prezzo_ratio IS NOT NULL
     AND (
       p.prezzo_ratio <= 1.10
       OR (p.prezzo_ratio <= 1.15
           AND (p.shared_photos >= 2 OR p.geo_unita_testo_ok))
     );
$fn_pairs$;

GRANT EXECUTE ON FUNCTION public.civiko_padova_matcher_v4_pairs() TO service_role;

-- 3) Recompute autoritativo -------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_match_version constant text := 'v4-unit-certified';
  v_img_match_version constant text := 'v4-unit-certified+image-phash-v1';
  v_pair_match_version constant text := 'v4-unit-certified+geo-unit-text-v4';
  v_img_groups_examined int := 0;
  v_img_cert int := 0;
  v_pair_geo_groups int := 0;
  v_prefilter int;
  v_groups_total int;
  v_cont_before int; v_cont_after int;
  v_mp_before   int; v_mp_after   int;
  v_alta int; v_media int; v_conf int;
  v_3plus int;
  v_quartieri int;
  v_sanitized_bad_coords int := 0;
  v_excluded_bad_title int := 0;
  v_excluded_no_identity int := 0;
  v_excluded_no_zone int := 0;
  v_excluded_not_padova int := 0;
  v_mp_tolerant int := 0;
  v_geo_mp int := 0;
  v_geo_rejected int := 0;
  v_cert int := 0;
  v_quar int := 0;
  v_no_civico int := 0;
  v_dup_canonical int := 0;
  v_bad int;
  v_asta_rows int := 0;
  v_asta_groups int := 0;
  v_mls_rows int := 0;
  v_mls_groups int := 0;
  v_zone_counts int := 0;
  r record;
BEGIN
  SELECT count(*) INTO v_cont_before FROM public.padova_contendibili;
  SELECT count(*) INTO v_mp_before   FROM public.padova_multi_portale;

  CREATE TEMP TABLE _base ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    p.lat, p.lng, p.quartiere, p.indirizzo, p.agency, p.last_seen_at AS l_last_seen_at, p.ev_via_norm, p.ev_civico_norm,
    NULLIF(trim(COALESCE(
      p.raw_json->>'title',
      p.raw_json->'suggestedTexts'->>'title',
      p.raw_json->>'subject'
    )), '') AS titolo_ann,
    CASE
      WHEN p.lat IS NULL AND p.lng IS NULL THEN 'null'
      WHEN p.lat IS NOT NULL AND p.lng IS NOT NULL
           AND p.lat = p.lat AND p.lng = p.lng
           AND p.lat <> 'infinity'::float8 AND p.lat <> '-infinity'::float8
           AND p.lng <> 'infinity'::float8 AND p.lng <> '-infinity'::float8
           AND p.lat BETWEEN 45.30 AND 45.50
           AND p.lng BETWEEN 11.75 AND 12.00
        THEN 'ok'
      ELSE 'bad'
    END AS coord_state,
    public.civiko_resolve_commercial_zone_slug(p.quartiere) AS czone_slug
  FROM public.padova_listings p
  WHERE p.mq IS NOT NULL
    AND p.locali IS NOT NULL
    AND p.agency IS NOT NULL
    AND p.agency <> 'Agenzie'
    AND COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) IS NOT NULL
    AND p.expired_at IS NULL
    AND p.url IS NOT NULL
    AND lower(coalesce(p.comune,'')) = 'padova';

  SELECT count(*) INTO v_excluded_not_padova
    FROM public.padova_listings p
   WHERE p.expired_at IS NULL
     AND lower(coalesce(p.comune,'')) <> 'padova';

  SELECT count(*) INTO v_excluded_bad_title
  FROM _base
  WHERE titolo_ann IS NULL
     OR lower(titolo_ann) !~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)';

  CREATE TEMP TABLE _base_ok ON COMMIT DROP AS
  SELECT * FROM _base
  WHERE titolo_ann IS NOT NULL
    AND lower(titolo_ann) ~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)';

  SELECT count(*) INTO v_excluded_no_zone
    FROM _base_ok WHERE czone_slug IS NULL;

  DELETE FROM _base_ok WHERE czone_slug IS NULL;

  SELECT count(*) INTO v_sanitized_bad_coords
  FROM _base_ok WHERE coord_state = 'bad';

  CREATE TEMP TABLE _cand_all ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    p.l_last_seen_at,
    CASE WHEN p.coord_state = 'ok' THEN p.lat ELSE NULL END AS lat,
    CASE WHEN p.coord_state = 'ok' THEN p.lng ELSE NULL END AS lng,
    p.quartiere, p.indirizzo,
    p.agency AS agency_raw,
    public.norm_agency(
      regexp_replace(lower(trim(p.agency)), '^(agenzia immobiliare|immobiliare)\s+', '', 'g')
    ) AS agency_core,
    public.norm_agency(p.agency) AS agency_n_full,
    COALESCE(p.ev_via_norm, public.padova_via_key(p.indirizzo)) AS via_n,
    regexp_replace(
      lower(coalesce(
        substring(p.indirizzo from ',\s*([0-9]{1,4}[a-zA-Z]?)\s*,'),
        substring(p.indirizzo from '([0-9]+[a-zA-Z]?)\s*$'),
        ''
      )),
      '[^a-z0-9]+', '', 'g'
    ) AS civico_legacy, COALESCE(p.ev_civico_norm, '') AS civico_n,
    p.czone_slug
  FROM _base_ok p;

  CREATE TEMP TABLE _identity ON COMMIT DROP AS
  WITH civic_listings AS (
    SELECT id, czone_slug, czone_slug || '|C:' || civico_n AS identity_key
    FROM _cand_all
    WHERE coalesce(civico_n, '') <> ''
  ),
  no_civic_partitions AS (
    SELECT czone_slug, via_n, locali,
      array_agg(id ORDER BY id) AS ids,
      array_agg(lat ORDER BY id) AS lats,
      array_agg(lng ORDER BY id) AS lngs
    FROM _cand_all
    WHERE coalesce(civico_n, '') = ''
      AND lat IS NOT NULL AND lng IS NOT NULL
    GROUP BY czone_slug, via_n, locali
  ),
  no_civic_with_clusters AS (
    SELECT czone_slug, via_n, locali, ids, public.padova_cluster_points_50m(lats, lngs) AS clusters
    FROM no_civic_partitions
  ),
  no_civic_expanded AS (
    SELECT p.ids[i] AS id, p.czone_slug,
      p.czone_slug || '|G:' || p.via_n || ':' || p.locali::text || ':' || p.clusters[i]::text AS identity_key
    FROM no_civic_with_clusters p,
      LATERAL generate_series(1, array_length(p.ids, 1)) AS i
    WHERE p.clusters[i] > 0
  ),
  covered AS (
    SELECT id FROM civic_listings
    UNION
    SELECT id FROM no_civic_expanded
  ),
  via_fallback AS (
    SELECT c.id, c.czone_slug,
           c.czone_slug || '|V:' || c.via_n || ':' || c.locali::text AS identity_key
    FROM _cand_all c
    WHERE c.id NOT IN (SELECT id FROM covered)
  )
  SELECT id, czone_slug, identity_key FROM civic_listings
  UNION ALL
  SELECT id, czone_slug, identity_key FROM no_civic_expanded
  UNION ALL
  SELECT id, czone_slug, identity_key FROM via_fallback;

  CREATE TEMP TABLE _cand_dup ON COMMIT DROP AS
  SELECT c.*, i.identity_key,
         public.padova_listing_canonical_id(c.url, c.fonte) AS canonical_listing_id
  FROM _cand_all c
  JOIN _identity i USING (id);

  SELECT (SELECT count(*) FROM _cand_all) - (SELECT count(*) FROM _cand_dup)
    INTO v_excluded_no_identity;

  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT z.* FROM (
    SELECT d.*, row_number() OVER (
             PARTITION BY d.canonical_listing_id
             ORDER BY d.l_last_seen_at DESC NULLS LAST, d.id DESC) AS _rn
      FROM _cand_dup d
     WHERE d.canonical_listing_id IS NOT NULL
  ) z
  WHERE z._rn = 1;

  ALTER TABLE _cand DROP COLUMN _rn;

  SELECT (SELECT count(*) FROM _cand_dup) - (SELECT count(*) FROM _cand)
    INTO v_dup_canonical;

  ALTER TABLE _cand ADD COLUMN agency_key text;
  UPDATE _cand
     SET agency_key = CASE WHEN coalesce(agency_core,'') <> '' THEN agency_core ELSE agency_n_full END;

  SELECT count(*) INTO v_prefilter FROM _cand;

  CREATE TEMP TABLE _asta_urls ON COMMIT DROP AS
  SELECT DISTINCT c.url
  FROM _cand c
  JOIN public.padova_listings l ON l.id = c.id
  WHERE public.padova_listing_has_auction_evidence(l.raw_json, c.agency_raw);
  SELECT count(*) INTO v_asta_rows FROM _asta_urls;

  CREATE TEMP TABLE _mls_urls ON COMMIT DROP AS
  SELECT DISTINCT c.url
  FROM _cand c
  JOIN public.padova_listings l ON l.id = c.id
  WHERE public.padova_listing_has_mls_exclusive_evidence(l.raw_json);
  SELECT count(*) INTO v_mls_rows FROM _mls_urls;

  -- ═══════════════════════════════════════════════════════════════════
  -- A) STAGING CONTENDIBILI CERTIFICATI (identità di UNITÀ)
  -- ═══════════════════════════════════════════════════════════════════
  CREATE TEMP TABLE _unit ON COMMIT DROP AS
  SELECT c.id, c.url, c.fonte, c.mq, c.locali, c.bagni, c.prezzo, c.lat, c.lng,
         c.quartiere, c.indirizzo, c.civico_n, c.via_n, c.czone_slug,
         c.agency_key, c.agency_raw, c.l_last_seen_at, c.canonical_listing_id,
         COALESCE(l.ev_piano_key, public.padova_unit_floor_key_v2(l.raw_json)) AS piano_k,
         NULLIF(lower(btrim(COALESCE(
           l.raw_json->>'externalReference',
           l.raw_json->'externalReferences'->>0,
           l.raw_json->>'reference'))), '') AS ref_ext,
         COALESCE(l.ev_descr_fp, CASE WHEN length(regexp_replace(lower(COALESCE(l.raw_json->>'description', l.raw_json->>'body','')), '[^a-z0-9]+','','g')) >= 160
              THEN md5(left(regexp_replace(lower(COALESCE(l.raw_json->>'description', l.raw_json->>'body','')), '[^a-z0-9]+','','g'), 400))
         END) AS descr_fp,
         public.padova_unit_tipologia(l.raw_json) AS tipologia
  FROM _cand c
  JOIN public.padova_listings l ON l.id = c.id
  WHERE coalesce(c.civico_n,'') <> ''
    AND c.prezzo > 0 AND c.mq > 0
    AND coalesce(c.agency_key,'') <> '';

  DELETE FROM _unit WHERE tipologia IS NULL;

  SELECT count(*) INTO v_no_civico
    FROM _cand WHERE coalesce(civico_n,'') = '';

  CREATE TEMP TABLE _unit_ev ON COMMIT DROP AS
  SELECT u.*, e.kind, e.ev
  FROM _unit u,
  LATERAL (VALUES
    ('PIANO', u.piano_k),
    ('REF',   u.ref_ext),
    ('DESCR', u.descr_fp)
  ) e(kind, ev)
  WHERE e.ev IS NOT NULL;

  CREATE TEMP TABLE _unit_grp ON COMMIT DROP AS
  SELECT
    czone_slug, via_n, civico_n, locali, tipologia, kind, ev,
    'U3:' || czone_slug || '|' || via_n || '|' || civico_n || '|' ||
      locali::text || '|' || tipologia || '|' || kind || ':' || ev AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT canonical_listing_id) AS n_annunci_canonici,
    count(DISTINCT agency_key) AS n_agenzie,
    count(DISTINCT fonte) AS n_portali,
    min(mq) AS mq_min, max(mq) AS mq_max,
    min(prezzo) AS prezzo_min, max(prezzo) AS prezzo_max,
    count(DISTINCT bagni) FILTER (WHERE bagni IS NOT NULL) AS n_bagni,
    count(DISTINCT piano_k) FILTER (WHERE piano_k IS NOT NULL) AS n_piani,
    round(avg(mq))::int AS mq_avg,
    (array_agg(bagni) FILTER (WHERE bagni IS NOT NULL))[1] AS bagni_pick,
    array_agg(DISTINCT agency_raw ORDER BY agency_raw) AS agenzie,
    array_agg(DISTINCT fonte ORDER BY fonte) AS fonti,
    array_agg(url) AS urls,
    (array_agg(quartiere) FILTER (WHERE quartiere IS NOT NULL))[1] AS quartiere,
    avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
    avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng,
    max(l_last_seen_at) AS last_seen_at
  FROM _unit_ev
  GROUP BY 1,2,3,4,5,6,7;

  SELECT count(*) INTO v_asta_groups FROM _unit_grp g
   WHERE EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls));
  DELETE FROM _unit_grp g
   WHERE EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = ANY(g.urls));

  SELECT count(*) INTO v_mls_groups FROM _unit_grp g
   WHERE EXISTS (SELECT 1 FROM _mls_urls m WHERE m.url = ANY(g.urls));
  DELETE FROM _unit_grp g
   WHERE EXISTS (SELECT 1 FROM _mls_urls m WHERE m.url = ANY(g.urls));

  CREATE TEMP TABLE _unit_ok ON COMMIT DROP AS
  SELECT * FROM _unit_grp
  WHERE n_agenzie >= 2
    AND n_annunci_canonici >= 2
    AND n_rows BETWEEN 2 AND 8
    AND mq_min > 0
    AND mq_max::numeric <= greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
    AND prezzo_min > 0
    AND prezzo_max::numeric <= prezzo_min::numeric * 1.10
    AND n_bagni <= 1
    AND n_piani <= 1;

  CREATE TEMP TABLE _cert (LIKE _unit_ok) ON COMMIT DROP;
  CREATE TEMP TABLE _cert_urls (url text PRIMARY KEY) ON COMMIT DROP;

  FOR r IN
    SELECT * FROM _unit_ok
    ORDER BY CASE kind WHEN 'PIANO' THEN 1 WHEN 'REF' THEN 2 ELSE 3 END,
             n_agenzie DESC, n_rows DESC, chiave_match
  LOOP
    IF NOT EXISTS (SELECT 1 FROM _cert_urls cu WHERE cu.url = ANY(r.urls)) THEN
      INSERT INTO _cert SELECT * FROM _unit_ok u WHERE u.chiave_match = r.chiave_match;
      INSERT INTO _cert_urls SELECT DISTINCT unnest(r.urls) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_cert FROM _cert;

  -- ═══════════════════════════════════════════════════════════════════
  -- B) MULTI-PORTALE (logica invariata)
  -- ═══════════════════════════════════════════════════════════════════
  CREATE TEMP TABLE _grp ON COMMIT DROP AS
  WITH sorted AS (
    SELECT *,
      LAG(mq) OVER (PARTITION BY via_n, locali, identity_key ORDER BY mq, id) AS mq_prev
    FROM _cand
  ),
  flagged AS (
    SELECT *,
      CASE WHEN mq_prev IS NULL OR mq::numeric > mq_prev::numeric * 1.05 THEN 1 ELSE 0 END AS new_grp
    FROM sorted
  ),
  numbered AS (
    SELECT *,
      SUM(new_grp) OVER (PARTITION BY via_n, locali, identity_key ORDER BY mq, id) AS sub_idx
    FROM flagged
  )
  SELECT czone_slug, via_n, locali, identity_key, sub_idx, id, url, fonte,
         agency_raw, agency_key, mq, bagni, prezzo, lat, lng, quartiere,
         indirizzo, civico_n, l_last_seen_at
  FROM numbered;

  CREATE TEMP TABLE _grp2 ON COMMIT DROP AS
  WITH base AS (
    SELECT g.*, (
      SELECT array_agg(DISTINCT b2.bagni ORDER BY b2.bagni)
      FROM _grp b2
      WHERE b2.via_n=g.via_n AND b2.locali=g.locali
        AND b2.identity_key = g.identity_key AND b2.sub_idx=g.sub_idx
        AND b2.bagni IS NOT NULL
    ) AS bagni_distinct
    FROM _grp g
  )
  SELECT czone_slug, via_n, locali, identity_key, sub_idx,
    CASE
      WHEN bagni IS NOT NULL THEN bagni::text
      WHEN bagni_distinct IS NULL OR array_length(bagni_distinct,1) IS NULL THEN 'X'
      ELSE bagni_distinct[1]::text
    END AS bagni_key,
    id, url, fonte, agency_raw, agency_key, mq, bagni, prezzo, lat, lng,
    quartiere, indirizzo, civico_n, l_last_seen_at, bagni_distinct
  FROM base;

  CREATE TEMP TABLE _agency_display ON COMMIT DROP AS
  SELECT via_n, locali, identity_key, sub_idx, bagni_key, agency_key,
         (array_agg(agency_raw ORDER BY id))[1] AS display
  FROM _grp2
  GROUP BY 1,2,3,4,5,6;

  CREATE TEMP TABLE _fg ON COMMIT DROP AS
  SELECT
    g.czone_slug, g.via_n, g.locali, g.identity_key, g.sub_idx, g.bagni_key,
    g.via_n || '|' || g.locali::text || '|' || g.sub_idx::text || '|' || g.bagni_key
      || '|' || g.identity_key AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT g.agency_key) AS n_agenzie,
    count(DISTINCT g.fonte)      AS n_portali,
    (SELECT array_agg(display ORDER BY display)
       FROM _agency_display d
      WHERE d.via_n=g.via_n AND d.locali=g.locali AND d.identity_key=g.identity_key
        AND d.sub_idx=g.sub_idx AND d.bagni_key=g.bagni_key) AS agenzie,
    array_agg(DISTINCT g.fonte ORDER BY g.fonte) AS fonti,
    min(g.prezzo) AS prezzo_min,
    max(g.prezzo) AS prezzo_max,
    round(avg(g.mq))::int AS mq_avg,
    array_agg(g.url) AS urls,
    (array_agg(g.quartiere) FILTER (WHERE g.quartiere IS NOT NULL))[1] AS quartiere,
    avg(g.lat) FILTER (WHERE g.lat IS NOT NULL) AS lat,
    avg(g.lng) FILTER (WHERE g.lng IS NOT NULL) AS lng,
    max(g.bagni_distinct) AS bagni_distinct_arr,
    (array_agg(g.bagni) FILTER (WHERE g.bagni IS NOT NULL))[1] AS bagni_pick,
    max(g.l_last_seen_at) AS last_seen_at
  FROM _grp2 g
  GROUP BY 1,2,3,4,5,6;

  SELECT count(*) INTO v_groups_total FROM _fg;

  CREATE TEMP TABLE _fg_legacy_cont ON COMMIT DROP AS
    SELECT * FROM _fg WHERE n_agenzie >= 2;
  CREATE TEMP TABLE _fg_mp ON COMMIT DROP AS
    SELECT * FROM _fg WHERE n_portali >= 2 AND n_agenzie < 2;

  CREATE TEMP TABLE _fg_mp_tol ON COMMIT DROP AS
  WITH grouped AS (
    SELECT
      c.czone_slug, c.via_n, c.locali,
      c.czone_slug || '|MPT:' || c.via_n || ':' || c.locali::text AS chiave_match,
      count(*) AS n_rows,
      count(DISTINCT c.agency_key) AS n_agenzie,
      count(DISTINCT c.fonte) AS n_portali,
      array_agg(DISTINCT c.agency_raw ORDER BY c.agency_raw) AS agenzie,
      array_agg(DISTINCT c.fonte ORDER BY c.fonte) AS fonti,
      min(c.prezzo) AS prezzo_min,
      max(c.prezzo) AS prezzo_max,
      round(avg(c.mq))::int AS mq_avg,
      array_agg(c.url) AS urls,
      (array_agg(c.quartiere) FILTER (WHERE c.quartiere IS NOT NULL))[1] AS quartiere,
      avg(c.lat) FILTER (WHERE c.lat IS NOT NULL) AS lat,
      avg(c.lng) FILTER (WHERE c.lng IS NOT NULL) AS lng,
      (array_agg(c.bagni) FILTER (WHERE c.bagni IS NOT NULL))[1] AS bagni_pick,
      max(c.l_last_seen_at) AS last_seen_at
    FROM _cand c
    GROUP BY c.czone_slug, c.via_n, c.locali
    HAVING count(DISTINCT c.fonte) >= 2
       AND count(DISTINCT c.agency_key) < 2
       AND min(c.prezzo) > 0
       AND max(c.prezzo)::numeric <= min(c.prezzo)::numeric * 1.30
  )
  SELECT * FROM grouped g
   WHERE NOT EXISTS (
     SELECT 1 FROM _fg_mp s
      WHERE s.czone_slug = g.czone_slug AND s.via_n = g.via_n AND s.locali = g.locali
   );

  SELECT count(*) INTO v_mp_tolerant FROM _fg_mp_tol;

  CREATE TEMP TABLE _geo_members ON COMMIT DROP AS
  WITH eligible AS (
    SELECT * FROM _cand
     WHERE lat IS NOT NULL AND lng IS NOT NULL
       AND mq IS NOT NULL AND mq > 0
       AND prezzo IS NOT NULL AND prezzo > 0
       AND locali IS NOT NULL
  ),
  parts AS (
    SELECT czone_slug, locali,
           array_agg(id ORDER BY id) AS ids,
           array_agg(lat ORDER BY id) AS lats,
           array_agg(lng ORDER BY id) AS lngs
    FROM eligible
    GROUP BY czone_slug, locali
  ),
  clustered AS (
    SELECT czone_slug, locali, ids, public.padova_cluster_points_50m(lats, lngs) AS clusters
    FROM parts
  ),
  expanded AS (
    SELECT p.ids[i] AS id,
           p.czone_slug,
           p.czone_slug || '|GEO:' || p.locali::text || ':' || p.clusters[i]::text AS geo_key
    FROM clustered p,
         LATERAL generate_series(1, array_length(p.ids, 1)) AS i
    WHERE p.clusters[i] > 0
  )
  SELECT e.geo_key, c.*, a3.k3 AS agency_k3
  FROM expanded e
  JOIN _cand c USING (id)
  LEFT JOIN LATERAL (
    SELECT string_agg(t, '' ORDER BY rn) AS k3
    FROM (
      SELECT tok AS t, row_number() OVER () AS rn
      FROM unnest(regexp_split_to_array(lower(coalesce(c.agency_raw,'')), '[^a-z0-9]+')) AS tok
      WHERE tok <> ''
    ) z
    WHERE z.rn <= 3
  ) a3 ON true;

  CREATE TEMP TABLE _geo_agency ON COMMIT DROP AS
  SELECT m.geo_key, m.id, m.fonte, m.agency_k3,
         (SELECT y.agency_k3
            FROM _geo_members y
           WHERE y.geo_key = m.geo_key
             AND coalesce(y.agency_k3,'') <> ''
             AND m.agency_k3 LIKE y.agency_k3 || '%'
           ORDER BY length(y.agency_k3), y.agency_k3
           LIMIT 1) AS agency_canon
  FROM _geo_members m;

  CREATE TEMP TABLE _geo_stats ON COMMIT DROP AS
  SELECT m.geo_key,
         count(*) AS n_rows,
         count(DISTINCT a.agency_canon) FILTER (
           WHERE m.fonte <> 'subito' AND coalesce(a.agency_canon,'') <> ''
         ) AS n_agenzie,
         count(DISTINCT m.fonte) AS n_portali,
         min(m.mq) AS mq_min, max(m.mq) AS mq_max,
         min(m.prezzo) AS prezzo_min, max(m.prezzo) AS prezzo_max,
         count(DISTINCT m.bagni) FILTER (WHERE m.bagni IS NOT NULL) AS n_bagni
  FROM _geo_members m
  JOIN _geo_agency a ON a.geo_key = m.geo_key AND a.id = m.id
  GROUP BY m.geo_key;

  CREATE TEMP TABLE _geo_valid ON COMMIT DROP AS
  WITH dist AS (
    SELECT a.geo_key,
           max(public.padova_haversine_m(a.lat, a.lng, b.lat, b.lng)) AS max_d
    FROM _geo_members a
    JOIN _geo_members b ON a.geo_key = b.geo_key AND a.id < b.id
    GROUP BY a.geo_key
  )
  SELECT g.geo_key, g.n_agenzie, g.n_portali
  FROM _geo_stats g
  JOIN dist d USING (geo_key)
  WHERE g.n_rows BETWEEN 2 AND 4
    AND d.max_d <= 30
    AND g.mq_min > 0
    AND g.mq_max::numeric <= g.mq_min::numeric * 1.02
    AND g.prezzo_min > 0
    AND g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.05
    AND g.n_bagni <= 1
    AND (g.n_agenzie >= 2 OR g.n_portali >= 2);

  SELECT count(DISTINCT geo_key) - (SELECT count(*) FROM _geo_valid)
    INTO v_geo_rejected
  FROM _geo_members;

  CREATE TEMP TABLE _geo_used_urls ON COMMIT DROP AS
  SELECT DISTINCT u AS url FROM (
    SELECT unnest(urls) AS u FROM _fg_legacy_cont
    UNION ALL SELECT unnest(urls) FROM _fg_mp
    UNION ALL SELECT unnest(urls) FROM _fg_mp_tol
  ) s;

  CREATE TEMP TABLE _fg_geo ON COMMIT DROP AS
  SELECT
    m.czone_slug,
    m.geo_key AS chiave_match,
    count(*) AS n_rows,
    max(v.n_agenzie) AS n_agenzie,
    count(DISTINCT m.fonte) AS n_portali,
    array_agg(DISTINCT m.agency_raw ORDER BY m.agency_raw) AS agenzie,
    array_agg(DISTINCT m.fonte ORDER BY m.fonte) AS fonti,
    min(m.prezzo) AS prezzo_min,
    max(m.prezzo) AS prezzo_max,
    round(avg(m.mq))::int AS mq_avg,
    min(m.locali) AS locali,
    array_agg(m.url) AS urls,
    (array_agg(m.quartiere) FILTER (WHERE m.quartiere IS NOT NULL))[1] AS quartiere,
    avg(m.lat) AS lat,
    avg(m.lng) AS lng,
    (array_agg(m.bagni) FILTER (WHERE m.bagni IS NOT NULL))[1] AS bagni_pick,
    max(m.l_last_seen_at) AS last_seen_at
  FROM _geo_members m
  JOIN _geo_valid v ON v.geo_key = m.geo_key
  WHERE NOT EXISTS (
    SELECT 1 FROM _geo_members m2
     WHERE m2.geo_key = m.geo_key
       AND m2.url IN (SELECT url FROM _geo_used_urls)
  )
  GROUP BY 1,2;

  CREATE TEMP TABLE _fg_geo_mp ON COMMIT DROP AS
    SELECT * FROM _fg_geo WHERE n_portali >= 2 AND n_agenzie < 2;
  SELECT count(*) INTO v_geo_mp FROM _fg_geo_mp;

  -- ═══════════════════════════════════════════════════════════════════
  -- B-bis) MATCHER v4 AUTORITATIVO — coppie strutturali + foto in LEFT JOIN
  -- Le evidenze fotografiche NON sono mai un prerequisito: il ramo
  -- geo + unita/piano + testo forte funziona con zero foto e zero coppie.
  -- Bande: <=10% segnali strutturali; 10-15% solo con >=2 foto condivise
  -- OPPURE geo <=30 m + unita/piano compatibile + fingerprint testo forte;
  -- >15% mai. Via e civico sono segnali positivi, mai veto.
  -- ═══════════════════════════════════════════════════════════════════
  CREATE TEMP TABLE _photo_cand ON COMMIT DROP AS
  SELECT c.*
    FROM public.civiko_padova_matcher_v4_candidates() c
   WHERE NOT EXISTS (SELECT 1 FROM _cert z WHERE c.url = ANY(z.urls))
     AND NOT EXISTS (SELECT 1 FROM _asta_urls a WHERE a.url = c.url)
     AND NOT EXISTS (SELECT 1 FROM _mls_urls m WHERE m.url = c.url);

  CREATE TEMP TABLE _pe ON COMMIT DROP AS
  SELECT p.a_id, p.b_id, p.shared_photos, p.prezzo_ratio, p.dist_m,
         p.geo_unita_testo_ok, p.pair_kind
    FROM public.civiko_padova_matcher_v4_pairs() p
   WHERE EXISTS (SELECT 1 FROM _photo_cand x WHERE x.id = p.a_id)
     AND EXISTS (SELECT 1 FROM _photo_cand y WHERE y.id = p.b_id);

  -- Clique complete di dimensione 2..4 (nessuna transitività).
  CREATE TEMP TABLE _photo_cliques ON COMMIT DROP AS
  SELECT ARRAY[p.a_id, p.b_id] AS ids, 2 AS n_rows,
         p.shared_photos::bigint AS foto_condivise, 1::bigint AS n_pairs,
         (p.geo_unita_testo_ok)::int::bigint AS n_pairs_geo
    FROM _pe p
  UNION ALL
  SELECT ARRAY[p1.a_id, p1.b_id, p2.b_id], 3,
         (p1.shared_photos + p2.shared_photos + p3.shared_photos)::bigint, 3,
         ((p1.geo_unita_testo_ok)::int + (p2.geo_unita_testo_ok)::int
          + (p3.geo_unita_testo_ok)::int)::bigint
    FROM _pe p1
    JOIN _pe p2 ON p2.a_id = p1.a_id AND p2.b_id > p1.b_id
    JOIN _pe p3 ON p3.a_id = p1.b_id AND p3.b_id = p2.b_id
  UNION ALL
  SELECT ARRAY[p1.a_id, p1.b_id, p2.b_id, p3.b_id], 4,
         (p1.shared_photos + p2.shared_photos + p3.shared_photos
          + p4.shared_photos + p5.shared_photos + p6.shared_photos)::bigint, 6,
         ((p1.geo_unita_testo_ok)::int + (p2.geo_unita_testo_ok)::int
          + (p3.geo_unita_testo_ok)::int + (p4.geo_unita_testo_ok)::int
          + (p5.geo_unita_testo_ok)::int + (p6.geo_unita_testo_ok)::int)::bigint
    FROM _pe p1
    JOIN _pe p2 ON p2.a_id = p1.a_id AND p2.b_id > p1.b_id
    JOIN _pe p3 ON p3.a_id = p1.a_id AND p3.b_id > p2.b_id
    JOIN _pe p4 ON p4.a_id = p1.b_id AND p4.b_id = p2.b_id
    JOIN _pe p5 ON p5.a_id = p1.b_id AND p5.b_id = p3.b_id
    JOIN _pe p6 ON p6.a_id = p2.b_id AND p6.b_id = p3.b_id;

  CREATE TEMP TABLE _img_grp ON COMMIT DROP AS
  SELECT 'IMG:' || md5(array_to_string(k.ids, ',')) AS gkey,
         'IMG:' || md5(array_to_string(k.ids, ',')) AS chiave_match,
         k.n_rows, k.n_pairs, k.n_pairs AS n_pairs_ok, k.foto_condivise,
         k.n_pairs_geo,
         bool_or(m.is_asta) AS has_asta,
         bool_or(m.is_mls) AS has_mls,
         min(m.czone_slug) AS czone_slug,
         (array_agg(m.via_n) FILTER (WHERE m.via_n IS NOT NULL))[1] AS via_n,
         min(m.locali) AS locali,
         count(DISTINCT m.canonical_listing_id) AS n_annunci_canonici,
         count(DISTINCT m.agency_key) AS n_agenzie,
         count(DISTINCT m.fonte) AS n_portali,
         count(DISTINCT m.czone_slug) AS n_zone,
         count(DISTINCT m.locali) AS n_locali,
         min(m.mq) AS mq_min, max(m.mq) AS mq_max,
         min(m.prezzo) AS prezzo_min, max(m.prezzo) AS prezzo_max,
         count(DISTINCT m.bagni) FILTER (WHERE m.bagni IS NOT NULL) AS n_bagni,
         count(DISTINCT m.piano_k) FILTER (WHERE m.piano_k IS NOT NULL) AS n_piani,
         count(DISTINCT m.tipologia) FILTER (WHERE m.tipologia IS NOT NULL) AS n_tipologie,
         round(avg(m.mq))::int AS mq_avg,
         (array_agg(m.bagni) FILTER (WHERE m.bagni IS NOT NULL))[1] AS bagni_pick,
         array_agg(DISTINCT m.agency_raw ORDER BY m.agency_raw) AS agenzie,
         array_agg(DISTINCT m.fonte ORDER BY m.fonte) AS fonti,
         array_agg(m.url ORDER BY m.url) AS urls,
         (array_agg(m.quartiere) FILTER (WHERE m.quartiere IS NOT NULL))[1] AS quartiere,
         avg(m.lat) FILTER (WHERE m.lat IS NOT NULL) AS lat,
         avg(m.lng) FILTER (WHERE m.lng IS NOT NULL) AS lng,
         max(m.l_last_seen_at) AS last_seen_at,
         (array_agg(m.piano_k) FILTER (WHERE m.piano_k IS NOT NULL))[1] AS piano_pick
    FROM _photo_cliques k
    JOIN _photo_cand m ON m.id = ANY(k.ids)
   GROUP BY k.ids, k.n_rows, k.n_pairs, k.foto_condivise, k.n_pairs_geo;

  SELECT count(*) INTO v_img_groups_examined FROM _img_grp;

  CREATE TEMP TABLE _img_ok ON COMMIT DROP AS
  SELECT g.*
    FROM _img_grp g
   WHERE g.n_zone = 1
     AND g.has_asta IS NOT TRUE
     AND g.has_mls IS NOT TRUE
     AND g.n_locali = 1
     AND g.n_agenzie >= 2
     AND g.n_annunci_canonici >= 2
     AND g.n_annunci_canonici = g.n_rows
     AND g.n_rows BETWEEN 2 AND 4
     AND g.mq_min > 0
     AND g.mq_max::numeric <= greatest(g.mq_min::numeric + 5, g.mq_min::numeric * 1.05)
     AND g.prezzo_min > 0
     AND g.prezzo_max::numeric <= g.prezzo_min::numeric * 1.15
     AND g.n_bagni <= 1
     AND g.n_piani <= 1
     AND g.n_tipologie <= 1;

  CREATE TEMP TABLE _img_cert (LIKE _img_ok) ON COMMIT DROP;
  CREATE TEMP TABLE _img_cert_urls (url text PRIMARY KEY) ON COMMIT DROP;

  FOR r IN
    SELECT * FROM _img_ok
     ORDER BY n_rows DESC, n_agenzie DESC, foto_condivise DESC, n_pairs_geo DESC, chiave_match
  LOOP
    IF NOT EXISTS (SELECT 1 FROM _img_cert_urls cu WHERE cu.url = ANY(r.urls)) THEN
      INSERT INTO _img_cert SELECT * FROM _img_ok u WHERE u.gkey = r.gkey;
      INSERT INTO _img_cert_urls SELECT DISTINCT unnest(r.urls) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_img_cert FROM _img_cert;
  SELECT count(*) INTO v_pair_geo_groups FROM _img_cert WHERE coalesce(foto_condivise,0) = 0;

  -- ═══════════════════════════════════════════════════════════════════
  -- C) QA SULLO STAGING — nessuna scrittura se un controllo fallisce
  -- ═══════════════════════════════════════════════════════════════════
  SELECT count(*) INTO v_bad FROM _cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2
      OR coalesce(civico_n,'') = ''
      OR tipologia IS NULL
      OR locali IS NULL
      OR prezzo_max::numeric > prezzo_min::numeric * 1.10
      OR mq_max::numeric > greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
      OR n_bagni > 1
      OR n_piani > 1
      OR kind IS NULL
      OR czone_slug IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging contendibili fallita: % gruppi non certificabili', v_bad;
  END IF;

  -- QA coppie v4: NON reimporre soglie fotografiche al ramo geo. Le coppie
  -- geo+unita+testo sono contate esplicitamente e valgono come equivalenti.
  SELECT count(*) INTO v_bad FROM _img_cert
   WHERE n_agenzie < 2
      OR coalesce(n_annunci_canonici, 0) < 2
      OR coalesce(n_pairs, 0) < 1
      OR n_pairs_ok <> n_pairs
      OR has_asta IS TRUE
      OR has_mls IS TRUE
      OR czone_slug IS NULL
      OR (coalesce(foto_condivise, 0) = 0
          AND coalesce(n_pairs_geo, 0) = 0
          AND prezzo_max::numeric > prezzo_min::numeric * 1.10);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging coppie v4 fallita: % gruppi non certificabili', v_bad;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- D) PUBBLICAZIONE (transazionale)
  -- ═══════════════════════════════════════════════════════════════════
  UPDATE _cert c
     SET chiave_match = c.chiave_match || '|K:' || md5(jsonb_build_array(
       c.czone_slug, c.via_n, c.civico_n, c.locali,
       c.tipologia, c.kind, c.ev
     )::text)
   WHERE c.chiave_match IN (
     SELECT d.chiave_match
       FROM _cert d
      GROUP BY d.chiave_match
     HAVING count(*) > 1
   );

  IF EXISTS (
    SELECT 1
      FROM _cert c
     GROUP BY c.chiave_match
    HAVING count(*) > 1
       AND count(DISTINCT to_jsonb(c)) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '21000',
      MESSAGE = 'duplicate divergent contendibili publish key';
  END IF;

  DELETE FROM _cert a
   USING _cert b
   WHERE a.ctid > b.ctid
     AND a.chiave_match = b.chiave_match;
  CREATE UNIQUE INDEX _cert_publish_chiave_match_uq
    ON _cert (chiave_match);
  SELECT count(*) INTO v_cert FROM _cert;

  CREATE TEMP TABLE _mp_publish ON COMMIT DROP AS
  SELECT 1::smallint AS source_rank,
         czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
         prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
         lat, lng, urls, n_rows, last_seen_at
    FROM _fg_mp
  UNION ALL
  SELECT 2::smallint AS source_rank,
         czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
         prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
         lat, lng, urls, n_rows, last_seen_at
    FROM _fg_mp_tol
  UNION ALL
  SELECT 3::smallint AS source_rank,
         czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
         prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
         lat, lng, urls, n_rows, last_seen_at
    FROM _fg_geo_mp;

  UPDATE _mp_publish m
     SET chiave_match = m.chiave_match || '|K:' || md5(jsonb_build_array(
       m.source_rank, m.czone_slug, m.fonti, m.n_agenzie, m.urls
     )::text)
   WHERE m.chiave_match IN (
     SELECT d.chiave_match
       FROM _mp_publish d
      GROUP BY d.chiave_match
     HAVING count(*) > 1
   );

  IF EXISTS (
    SELECT 1
      FROM _mp_publish m
     GROUP BY m.chiave_match
    HAVING count(*) > 1
       AND count(DISTINCT (to_jsonb(m) - 'source_rank')) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '21000',
      MESSAGE = 'duplicate divergent multi_portale publish key';
  END IF;

  DELETE FROM _mp_publish a
   USING _mp_publish b
   WHERE a.ctid > b.ctid
     AND a.chiave_match = b.chiave_match;
  CREATE UNIQUE INDEX _mp_publish_chiave_match_uq
    ON _mp_publish (chiave_match);

  INSERT INTO public.padova_contendibili AS pc
    (chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza,
     prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls,
     n_annunci, portals_seen, agency_count_distinct, agency_count_raw,
     n_portali, last_seen_at, updated_at, commercial_zone_slug,
     match_version, evidence_kind, evidence_ref, match_metrics)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         f.fonti,
         CASE WHEN f.kind = 'PIANO' THEN 'ALTA' ELSE 'MEDIA' END,
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.fonti, f.n_agenzie, f.n_rows, f.n_portali,
         f.last_seen_at, now(), f.czone_slug,
         v_match_version, f.kind, f.ev,
         jsonb_build_object(
           'civico', f.civico_n, 'tipologia', f.tipologia,
           'mq_min', f.mq_min, 'mq_max', f.mq_max,
           'prezzo_ratio', round(f.prezzo_max::numeric / NULLIF(f.prezzo_min,0), 3),
           'n_bagni_distinti', f.n_bagni, 'n_piani_distinti', f.n_piani,
           'urls', to_jsonb(f.urls))
  FROM _cert f
  ON CONFLICT (chiave_match) DO UPDATE
    SET n_agenzie             = EXCLUDED.n_agenzie,
        agenzie               = EXCLUDED.agenzie,
        agencies_normalized   = EXCLUDED.agencies_normalized,
        fonti                 = EXCLUDED.fonti,
        confidenza            = EXCLUDED.confidenza,
        prezzo_min            = EXCLUDED.prezzo_min,
        prezzo_max            = EXCLUDED.prezzo_max,
        mq                    = EXCLUDED.mq,
        locali                = EXCLUDED.locali,
        bagni                 = EXCLUDED.bagni,
        quartiere             = EXCLUDED.quartiere,
        lat                   = EXCLUDED.lat,
        lng                   = EXCLUDED.lng,
        urls                  = EXCLUDED.urls,
        n_annunci             = EXCLUDED.n_annunci,
        portals_seen          = EXCLUDED.portals_seen,
        agency_count_distinct = EXCLUDED.agency_count_distinct,
        agency_count_raw      = EXCLUDED.agency_count_raw,
        n_portali             = EXCLUDED.n_portali,
        last_seen_at          = EXCLUDED.last_seen_at,
        updated_at            = now(),
        commercial_zone_slug  = EXCLUDED.commercial_zone_slug,
        match_version         = EXCLUDED.match_version,
        evidence_kind         = EXCLUDED.evidence_kind,
        evidence_ref          = EXCLUDED.evidence_ref,
        match_metrics         = EXCLUDED.match_metrics;

  -- Pubblicazione dei gruppi certificati dal matcher v4 (foto oppure geo/unita/testo).
  INSERT INTO public.padova_contendibili AS pc
    (chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza,
     prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls,
     n_annunci, portals_seen, agency_count_distinct, agency_count_raw,
     n_portali, last_seen_at, updated_at, commercial_zone_slug,
     match_version, evidence_kind, evidence_ref, match_metrics)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         f.fonti, 'MEDIA',
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.fonti, f.n_agenzie, f.n_rows, f.n_portali,
         f.last_seen_at, now(), f.czone_slug,
         CASE WHEN coalesce(f.foto_condivise,0) > 0
              THEN v_img_match_version ELSE v_pair_match_version END,
         CASE WHEN coalesce(f.foto_condivise,0) > 0
              THEN 'IMAGE_PHASH_V1' ELSE 'UNIT_GEO_TEXT_V4' END,
         CASE WHEN coalesce(f.foto_condivise,0) > 0
              THEN 'phash-dct-8x8-v1' ELSE 'geo30m-unit-descrfp-v4' END,
         jsonb_build_object(
           'via', f.via_n, 'piano', f.piano_pick,
           'mq_min', f.mq_min, 'mq_max', f.mq_max,
           'prezzo_ratio', round(f.prezzo_max::numeric / NULLIF(f.prezzo_min,0), 3),
           'n_annunci_canonici', f.n_annunci_canonici,
           'coppie_cross_agenzia', f.n_pairs,
           'coppie_certificate', f.n_pairs_ok,
           'coppie_geo_unita_testo', f.n_pairs_geo,
           'foto_condivise', f.foto_condivise,
           'match_version', 'v4',
           'prova', CASE WHEN coalesce(f.foto_condivise,0) > 0
                         THEN 'IMAGE_PHASH_V1' ELSE 'UNIT_GEO_TEXT_V4' END,
           'urls', to_jsonb(f.urls))
  FROM _img_cert f
  ON CONFLICT (chiave_match) DO UPDATE
    SET n_agenzie             = EXCLUDED.n_agenzie,
        agenzie               = EXCLUDED.agenzie,
        agencies_normalized   = EXCLUDED.agencies_normalized,
        fonti                 = EXCLUDED.fonti,
        confidenza            = EXCLUDED.confidenza,
        prezzo_min            = EXCLUDED.prezzo_min,
        prezzo_max            = EXCLUDED.prezzo_max,
        mq                    = EXCLUDED.mq,
        locali                = EXCLUDED.locali,
        bagni                 = EXCLUDED.bagni,
        quartiere             = EXCLUDED.quartiere,
        lat                   = EXCLUDED.lat,
        lng                   = EXCLUDED.lng,
        urls                  = EXCLUDED.urls,
        n_annunci             = EXCLUDED.n_annunci,
        portals_seen          = EXCLUDED.portals_seen,
        agency_count_distinct = EXCLUDED.agency_count_distinct,
        agency_count_raw      = EXCLUDED.agency_count_raw,
        n_portali             = EXCLUDED.n_portali,
        last_seen_at          = EXCLUDED.last_seen_at,
        updated_at            = now(),
        commercial_zone_slug  = EXCLUDED.commercial_zone_slug,
        match_version         = EXCLUDED.match_version,
        evidence_kind         = EXCLUDED.evidence_kind,
        evidence_ref          = EXCLUDED.evidence_ref,
        match_metrics         = EXCLUDED.match_metrics;

  -- Quarantena diagnostica: gruppi con >= 2 agenzie non certificati.
  DELETE FROM public.padova_contendibili_quarantena;

  INSERT INTO public.padova_contendibili_quarantena
    (chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max,
     mq, locali, bagni, quartiere, lat, lng, urls, n_annunci, motivo,
     quarantined_at, match_version, motivi, metriche, commercial_zone_slug)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie, f.fonti, 'QUARANTENA',
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         array_to_string(mm.motivi, ','), now(), v_match_version,
         mm.motivi,
         jsonb_build_object(
           'prezzo_ratio', round(f.prezzo_max::numeric / NULLIF(f.prezzo_min,0), 3),
           'mq_min', mm.mq_min, 'mq_max', mm.mq_max,
           'civici_distinti', mm.n_civici,
           'civico_assente', mm.civico_assente,
           'locali_distinti', mm.n_locali,
           'bagni_distinti', mm.n_bagni,
           'piani_distinti', mm.n_piani,
           'urls', to_jsonb(f.urls)),
         f.czone_slug
  FROM _fg_legacy_cont f
  CROSS JOIN LATERAL (
    SELECT
      min(g.mq) AS mq_min, max(g.mq) AS mq_max,
      count(DISTINCT NULLIF(g.civico_n,'')) AS n_civici,
      bool_or(coalesce(g.civico_n,'') = '') AS civico_assente,
      count(DISTINCT g.locali) AS n_locali,
      count(DISTINCT g.bagni) FILTER (WHERE g.bagni IS NOT NULL) AS n_bagni,
      count(DISTINCT public.padova_unit_floor_key(l.raw_json))
        FILTER (WHERE public.padova_unit_floor_key(l.raw_json) IS NOT NULL) AS n_piani,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN bool_or(coalesce(g.civico_n,'') = '') THEN 'CIVICO_ASSENTE' END,
        CASE WHEN count(DISTINCT NULLIF(g.civico_n,'')) > 1 THEN 'CIVICI_DISCORDANTI' END,
        CASE WHEN max(g.prezzo)::numeric > min(g.prezzo)::numeric * 1.35 THEN 'PREZZO_OLTRE_35_PCT' END,
        CASE WHEN max(g.mq)::numeric > greatest(min(g.mq)::numeric + 5, min(g.mq)::numeric * 1.05) THEN 'MQ_INCOMPATIBILI' END,
        CASE WHEN count(DISTINCT g.locali) > 1 THEN 'LOCALI_DISCORDANTI' END,
        CASE WHEN count(DISTINCT g.bagni) FILTER (WHERE g.bagni IS NOT NULL) > 1 THEN 'BAGNI_DISCORDANTI' END,
        CASE WHEN count(DISTINCT public.padova_unit_floor_key(l.raw_json))
                    FILTER (WHERE public.padova_unit_floor_key(l.raw_json) IS NOT NULL) > 1 THEN 'PIANO_DISCORDANTE' END,
        CASE WHEN count(DISTINCT public.padova_unit_tipologia(l.raw_json))
                    FILTER (WHERE public.padova_unit_tipologia(l.raw_json) IS NOT NULL) > 1 THEN 'TIPOLOGIA_INCOMPATIBILE' END,
        CASE WHEN bool_or(public.padova_listing_has_auction_evidence(l.raw_json, g.agency_raw))
             THEN 'ASTA_O_PROCEDURA' END,
        'EVIDENZA_UNITA_ASSENTE'
      ], NULL) AS motivi
    FROM _grp2 g
    JOIN public.padova_listings l ON l.id = g.id
    WHERE g.czone_slug = f.czone_slug AND g.via_n = f.via_n AND g.locali = f.locali
      AND g.identity_key = f.identity_key AND g.sub_idx = f.sub_idx AND g.bagni_key = f.bagni_key
  ) mm
  WHERE NOT EXISTS (
    SELECT 1 FROM _cert c
     WHERE c.urls && f.urls
  )
    AND NOT EXISTS (
    SELECT 1 FROM _img_cert ic
     WHERE ic.urls && f.urls
  );

  SELECT count(*) INTO v_quar FROM public.padova_contendibili_quarantena;

  -- multi-portale invariato
  INSERT INTO public.padova_multi_portale AS mp
    (chiave_match, portals_seen, portal_count, agency_count_distinct,
     agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, bagni,
     quartiere, lat, lng, urls, n_annunci, last_seen_at, updated_at,
     commercial_zone_slug)
  SELECT f.chiave_match, f.fonti, f.n_portali, f.n_agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         COALESCE(f.agenzie, ARRAY[]::text[]),
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.last_seen_at, now(), f.czone_slug
  FROM _mp_publish f
  ON CONFLICT (chiave_match) DO UPDATE
    SET portals_seen          = EXCLUDED.portals_seen,
        portal_count          = EXCLUDED.portal_count,
        agency_count_distinct = EXCLUDED.agency_count_distinct,
        agencies_normalized   = EXCLUDED.agencies_normalized,
        agenzie               = EXCLUDED.agenzie,
        prezzo_min            = EXCLUDED.prezzo_min,
        prezzo_max            = EXCLUDED.prezzo_max,
        mq                    = EXCLUDED.mq,
        locali                = EXCLUDED.locali,
        bagni                 = EXCLUDED.bagni,
        quartiere             = EXCLUDED.quartiere,
        lat                   = EXCLUDED.lat,
        lng                   = EXCLUDED.lng,
        urls                  = EXCLUDED.urls,
        n_annunci             = EXCLUDED.n_annunci,
        last_seen_at          = EXCLUDED.last_seen_at,
        updated_at            = now(),
        commercial_zone_slug  = EXCLUDED.commercial_zone_slug;

  DELETE FROM public.padova_contendibili pc
   WHERE NOT EXISTS (SELECT 1 FROM _cert f WHERE f.chiave_match = pc.chiave_match)
     AND NOT EXISTS (SELECT 1 FROM _img_cert g WHERE g.chiave_match = pc.chiave_match);

  DELETE FROM public.padova_multi_portale mp
   WHERE mp.chiave_match IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM _mp_publish f
         WHERE f.chiave_match = mp.chiave_match
      );

  -- QA post-scrittura (fail-closed, rollback in caso di violazione)
  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili
   WHERE match_version NOT IN (v_match_version, v_img_match_version, v_pair_match_version)
      OR n_agenzie < 2
      OR prezzo_max::numeric > prezzo_min::numeric * 1.15
      OR commercial_zone_slug IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA post-scrittura fallita: % contendibili non conformi', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili pc
   WHERE EXISTS (
     SELECT 1 FROM public.padova_listings l
      WHERE l.url = ANY(pc.urls)
        AND public.padova_listing_has_auction_evidence(l.raw_json, l.agency));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA aste fallita: % contendibili con evidenza asta', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili pc
   WHERE EXISTS (
     SELECT 1 FROM public.padova_listings l
      WHERE l.url = ANY(pc.urls)
        AND public.padova_listing_has_mls_exclusive_evidence(l.raw_json));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA MLS fallita: % contendibili con prova MLS/esclusiva', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili pc
   WHERE pc.commercial_zone_slug IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                      WHERE z.slug = pc.commercial_zone_slug)
      OR EXISTS (
        SELECT 1 FROM public.padova_listings l
         WHERE l.url = ANY(pc.urls)
           AND lower(coalesce(l.comune,'')) <> 'padova');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA perimetro Padova/8 zone fallita: % contendibili fuori perimetro', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili pc
   WHERE (
     SELECT count(DISTINCT public.padova_listing_canonical_id(u, NULL))
       FROM unnest(coalesce(pc.urls, ARRAY[]::text[])) AS u
   ) < 2;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA identita canonica fallita: % contendibili con meno di 2 annunci canonici distinti', v_bad;
  END IF;

  -- QA coppie v4 post-scrittura: vale sia per la prova fotografica sia per
  -- la prova geo+unita+testo; nessuna soglia fotografica sul ramo geo.
  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili pc
   WHERE pc.evidence_kind IN ('IMAGE_PHASH_V1', 'UNIT_GEO_TEXT_V4')
     AND (
       coalesce((pc.match_metrics->>'coppie_cross_agenzia')::int, 0) < 1
       OR coalesce((pc.match_metrics->>'coppie_certificate')::int, -1)
            <> coalesce((pc.match_metrics->>'coppie_cross_agenzia')::int, 0)
       OR coalesce((pc.match_metrics->>'n_annunci_canonici')::int, 0) < 2
       OR (coalesce((pc.match_metrics->>'foto_condivise')::int, 0) = 0
           AND coalesce((pc.match_metrics->>'coppie_geo_unita_testo')::int, 0) = 0
           AND pc.prezzo_max::numeric > pc.prezzo_min::numeric * 1.10)
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA coppie v4 post-scrittura fallita: % contendibili senza prova per coppia', v_bad;
  END IF;

  UPDATE public.civiko_commercial_zones z
     SET contendibili_count = COALESCE(c.n, 0)
    FROM (SELECT s.slug, count(pc.chiave_match) AS n
            FROM public.civiko_commercial_zones s
            LEFT JOIN public.padova_contendibili pc
              ON pc.commercial_zone_slug = s.slug
           GROUP BY s.slug) c
   WHERE c.slug = z.slug
     AND z.contendibili_count IS DISTINCT FROM COALESCE(c.n, 0);
  GET DIAGNOSTICS v_zone_counts = ROW_COUNT;

  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;
  SELECT count(*) INTO v_mp_after   FROM public.padova_multi_portale;
  SELECT count(*) INTO v_alta  FROM public.padova_contendibili WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM public.padova_contendibili WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf  FROM public.padova_contendibili WHERE confidenza='DA_CONFERMARE';
  SELECT count(*) INTO v_3plus FROM public.padova_contendibili WHERE n_agenzie >= 3;
  SELECT count(DISTINCT quartiere) INTO v_quartieri FROM public.padova_contendibili WHERE quartiere IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'aste_annunci_esclusi', v_asta_rows,
    'aste_gruppi_esclusi', v_asta_groups,
    'mls_annunci_esclusi', v_mls_rows,
    'mls_gruppi_esclusi', v_mls_groups,
    'zone_counts_aggiornate', v_zone_counts,
    'match_version', v_match_version,
    'prefilter_rows', v_prefilter,
    'groups_total', v_groups_total,
    'contendibili_before', v_cont_before,
    'contendibili_after',  v_cont_after,
    'certificati', v_cert,
    'image_match_version', v_img_match_version,
    'pair_match_version', v_pair_match_version,
    'image_gruppi_esaminati', v_img_groups_examined,
    'image_certificati', v_img_cert,
    'pair_gruppi_geo', v_pair_geo_groups,
    'quarantinati', v_quar,
    'righe_senza_civico', v_no_civico,
    'duplicati_canonici_rimossi', v_dup_canonical,
    'multi_portale_before', v_mp_before,
    'multi_portale_after',  v_mp_after,
    'mp_tolerant_added', v_mp_tolerant,
    'geo_multi_portale', v_geo_mp,
    'geo_groups_rejected', v_geo_rejected,
    'per_confidenza', jsonb_build_object('ALTA', v_alta, 'MEDIA', v_media, 'DA_CONFERMARE', v_conf),
    'con_3_piu_agenzie', v_3plus,
    'quartieri_coinvolti', v_quartieri,
    'sanitized_bad_coords', v_sanitized_bad_coords,
    'excluded_bad_title', v_excluded_bad_title,
    'excluded_no_identity', v_excluded_no_identity,
    'excluded_no_zone', v_excluded_no_zone,
    'excluded_not_padova', v_excluded_not_padova
  );
END;
$function$;

-- 4) QA STATICA + FIXTURE REALI (rollback automatico in caso di fallimento) --
DO $qa$
DECLARE
  v_def text;
  v_pos int;
  v_neg int;
BEGIN
  v_def := pg_get_functiondef('public.civiko_padova_matcher_v4_pairs()'::regprocedure);

  IF v_def !~ 'LEFT JOIN public\.civiko_listing_photo_pair_evidence' THEN
    RAISE EXCEPTION 'QA statica: le evidenze fotografiche non sono in LEFT JOIN';
  END IF;
  IF v_def ~ 'shared_photos, 0\) >= 1' OR v_def ~ 'shared_photos >= 1' THEN
    RAISE EXCEPTION 'QA statica: prerequisito fotografico globale (>=1) ancora presente';
  END IF;
  IF v_def ~ '\n\s+JOIN public\.civiko_listing_photo_pair_evidence' THEN
    RAISE EXCEPTION 'QA statica: INNER JOIN sulle evidenze fotografiche non ammesso';
  END IF;

  CREATE TEMP TABLE _qa_pairs ON COMMIT DROP AS
    SELECT * FROM public.civiko_padova_matcher_v4_pairs();

  SELECT count(*) INTO v_pos FROM _qa_pairs
   WHERE (a_id, b_id) IN ((44787, 101390), (101390, 44787));
  IF v_pos <> 1 THEN
    RAISE EXCEPTION 'QA fixture: prova positiva 44787/101390 fallita (coppie trovate = %)', v_pos;
  END IF;

  SELECT count(*) INTO v_neg FROM _qa_pairs
   WHERE (a_id, b_id) IN ((2309, 60498), (60498, 2309), (3619, 60735), (60735, 3619));
  IF v_neg <> 0 THEN
    RAISE EXCEPTION 'QA fixture: prove negative rientrate nel matcher (coppie = %)', v_neg;
  END IF;

  RAISE NOTICE 'QA matcher v4 superata: positiva=1, negative=0';
END
$qa$;