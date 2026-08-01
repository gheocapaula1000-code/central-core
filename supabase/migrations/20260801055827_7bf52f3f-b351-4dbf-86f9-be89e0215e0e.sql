
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Helper deterministici per evidenza di unità
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.padova_unit_floor_key(p_raw jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v text;
BEGIN
  IF p_raw IS NULL THEN RETURN NULL; END IF;
  v := NULLIF(btrim(COALESCE(
    p_raw->>'floor',
    (SELECT r->>'value'
       FROM jsonb_array_elements(COALESCE(p_raw->'mainData','[]'::jsonb)) s,
            jsonb_array_elements(COALESCE(s->'rows','[]'::jsonb)) r
      WHERE r->>'label' = 'Piano'
      LIMIT 1),
    p_raw->>'features_floor_label',
    p_raw->'features'->>'floor'
  )), '');
  IF v IS NULL THEN RETURN NULL; END IF;
  v := lower(v);
  IF v ~ 'seminterrat|interrat' THEN RETURN 'S'; END IF;
  IF v ~ 'terra|piano t\b|^t$'   THEN RETURN 'T'; END IF;
  IF v ~ 'rialzat'               THEN RETURN 'R'; END IF;
  IF v ~ 'mansard'               THEN RETURN 'M'; END IF;
  IF v ~ 'attico|ultimo'         THEN RETURN 'A'; END IF;
  IF v ~ '[0-9]' THEN
    RETURN 'P' || (substring(v from '([0-9]{1,2})'));
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.padova_unit_tipologia(p_raw jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE
    WHEN t ~ 'villett'                                   THEN 'villetta'
    WHEN t ~ 'villa'                                     THEN 'villa'
    WHEN t ~ 'attico|penthouse'                          THEN 'attico'
    WHEN t ~ 'mansard'                                   THEN 'mansarda'
    WHEN t ~ 'loft'                                      THEN 'loft'
    WHEN t ~ 'rustico|casale|cascina'                    THEN 'rustico'
    WHEN t ~ 'terren|lotto|edificabil'                   THEN 'terreno'
    WHEN t ~ 'negozio|ufficio|capann|magazz|commercial'  THEN 'commerciale'
    WHEN t ~ 'appartament|bilocal|trilocal|monolocal|quadrilocal|plurilocal|flat|apartment|duplex'
                                                          THEN 'appartamento'
    WHEN t ~ 'casa|house|porzione|villino|familiare'     THEN 'casa'
    ELSE NULL
  END
  FROM (
    SELECT lower(COALESCE(
      NULLIF(btrim(COALESCE(p_raw->>'propertyType', p_raw->>'property_type')), ''),
      NULLIF(btrim(COALESCE(
        p_raw->>'title',
        p_raw->'suggestedTexts'->>'title',
        p_raw->>'subject'
      )), ''),
      ''
    )) AS t
  ) z
$fn$;

REVOKE ALL ON FUNCTION public.padova_unit_floor_key(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.padova_unit_tipologia(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_unit_floor_key(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.padova_unit_tipologia(jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Colonne diagnostiche (idempotenti)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.padova_contendibili
  ADD COLUMN IF NOT EXISTS match_version  text,
  ADD COLUMN IF NOT EXISTS evidence_kind  text,
  ADD COLUMN IF NOT EXISTS evidence_ref   text,
  ADD COLUMN IF NOT EXISTS match_metrics  jsonb;

ALTER TABLE public.padova_contendibili_quarantena
  ADD COLUMN IF NOT EXISTS match_version         text,
  ADD COLUMN IF NOT EXISTS motivi                text[],
  ADD COLUMN IF NOT EXISTS metriche              jsonb,
  ADD COLUMN IF NOT EXISTS commercial_zone_slug  text;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Funzione autoritativa: certificazione unità (fail-closed)
--    La sezione multi-portale resta invariata; cambia solo la produzione
--    dei contendibili, che ora richiede evidenza della stessa unità.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_match_version constant text := 'v3-unit-certified';
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
  v_bad int;
  r record;
BEGIN
  SELECT count(*) INTO v_cont_before FROM public.padova_contendibili;
  SELECT count(*) INTO v_mp_before   FROM public.padova_multi_portale;

  CREATE TEMP TABLE _base ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    p.lat, p.lng, p.quartiere, p.indirizzo, p.agency, p.last_seen_at AS l_last_seen_at,
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
    AND p.indirizzo IS NOT NULL
    AND public.norm_via(p.indirizzo) NOT IN ('','na')
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
    public.norm_via(p.indirizzo) AS via_n,
    regexp_replace(
      lower(coalesce(
        substring(p.indirizzo from ',\s*([0-9]{1,4}[a-zA-Z]?)\s*,'),
        substring(p.indirizzo from '([0-9]+[a-zA-Z]?)\s*$'),
        ''
      )),
      '[^a-z0-9]+', '', 'g'
    ) AS civico_n,
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

  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT c.*, i.identity_key
  FROM _cand_all c
  JOIN _identity i USING (id);

  SELECT (SELECT count(*) FROM _cand_all) - (SELECT count(*) FROM _cand)
    INTO v_excluded_no_identity;

  ALTER TABLE _cand ADD COLUMN agency_key text;
  UPDATE _cand
     SET agency_key = CASE WHEN coalesce(agency_core,'') <> '' THEN agency_core ELSE agency_n_full END;

  SELECT count(*) INTO v_prefilter FROM _cand;

  -- ═══════════════════════════════════════════════════════════════════
  -- A) STAGING CONTENDIBILI CERTIFICATI (identità di UNITÀ)
  -- ═══════════════════════════════════════════════════════════════════
  CREATE TEMP TABLE _unit ON COMMIT DROP AS
  SELECT c.id, c.url, c.fonte, c.mq, c.locali, c.bagni, c.prezzo, c.lat, c.lng,
         c.quartiere, c.indirizzo, c.civico_n, c.via_n, c.czone_slug,
         c.agency_key, c.agency_raw, c.l_last_seen_at,
         public.padova_unit_floor_key(l.raw_json) AS piano_k,
         NULLIF(lower(btrim(COALESCE(
           l.raw_json->>'externalReference',
           l.raw_json->'externalReferences'->>0,
           l.raw_json->>'reference'))), '') AS ref_ext,
         CASE WHEN length(regexp_replace(lower(COALESCE(l.raw_json->>'description', l.raw_json->>'body','')), '[^a-z0-9]+','','g')) >= 160
              THEN md5(left(regexp_replace(lower(COALESCE(l.raw_json->>'description', l.raw_json->>'body','')), '[^a-z0-9]+','','g'), 400))
         END AS descr_fp,
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

  -- Tutti i vincoli sono limiti aggregati min/max: valgono per OGNI coppia
  -- del gruppo, quindi nessuna concatenazione transitiva è possibile.
  CREATE TEMP TABLE _unit_ok ON COMMIT DROP AS
  SELECT * FROM _unit_grp
  WHERE n_agenzie >= 2
    AND n_rows BETWEEN 2 AND 8
    AND mq_min > 0
    AND mq_max::numeric <= greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
    AND prezzo_min > 0
    AND prezzo_max::numeric <= prezzo_min::numeric * 1.35
    AND n_bagni <= 1
    AND n_piani <= 1;

  -- Un annuncio non può appartenere a due gruppi certificati:
  -- preferenza PIANO > REF > DESCR, poi più annunci, poi chiave stabile.
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
  -- C) QA SULLO STAGING — nessuna scrittura se un controllo fallisce
  -- ═══════════════════════════════════════════════════════════════════
  SELECT count(*) INTO v_bad FROM _cert
   WHERE n_agenzie < 2
      OR coalesce(civico_n,'') = ''
      OR tipologia IS NULL
      OR locali IS NULL
      OR prezzo_max::numeric > prezzo_min::numeric * 1.35
      OR mq_max::numeric > greatest(mq_min::numeric + 5, mq_min::numeric * 1.05)
      OR n_bagni > 1
      OR n_piani > 1
      OR kind IS NULL
      OR czone_slug IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA staging contendibili fallita: % gruppi non certificabili', v_bad;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════
  -- D) PUBBLICAZIONE (transazionale)
  -- ═══════════════════════════════════════════════════════════════════
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
  FROM (
    SELECT czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
           prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
           lat, lng, urls, n_rows, last_seen_at FROM _fg_mp
    UNION ALL
    SELECT czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
           prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
           lat, lng, urls, n_rows, last_seen_at FROM _fg_mp_tol
    UNION ALL
    SELECT czone_slug, chiave_match, fonti, n_portali, n_agenzie, agenzie,
           prezzo_min, prezzo_max, mq_avg, locali, bagni_pick, quartiere,
           lat, lng, urls, n_rows, last_seen_at FROM _fg_geo_mp
  ) f
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
   WHERE NOT EXISTS (SELECT 1 FROM _cert f WHERE f.chiave_match = pc.chiave_match);

  DELETE FROM public.padova_multi_portale mp
   WHERE mp.chiave_match IS NULL
      OR (NOT EXISTS (SELECT 1 FROM _fg_mp f      WHERE f.chiave_match = mp.chiave_match)
      AND NOT EXISTS (SELECT 1 FROM _fg_mp_tol f  WHERE f.chiave_match = mp.chiave_match)
      AND NOT EXISTS (SELECT 1 FROM _fg_geo_mp f  WHERE f.chiave_match = mp.chiave_match));

  -- QA post-scrittura (fail-closed, rollback in caso di violazione)
  SELECT count(*) INTO v_bad
    FROM public.padova_contendibili
   WHERE match_version IS DISTINCT FROM v_match_version
      OR n_agenzie < 2
      OR prezzo_max::numeric > prezzo_min::numeric * 1.35
      OR commercial_zone_slug IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'QA post-scrittura fallita: % contendibili non conformi', v_bad;
  END IF;

  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;
  SELECT count(*) INTO v_mp_after   FROM public.padova_multi_portale;
  SELECT count(*) INTO v_alta  FROM public.padova_contendibili WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM public.padova_contendibili WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf  FROM public.padova_contendibili WHERE confidenza='DA_CONFERMARE';
  SELECT count(*) INTO v_3plus FROM public.padova_contendibili WHERE n_agenzie >= 3;
  SELECT count(DISTINCT quartiere) INTO v_quartieri FROM public.padova_contendibili WHERE quartiere IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'match_version', v_match_version,
    'prefilter_rows', v_prefilter,
    'groups_total', v_groups_total,
    'contendibili_before', v_cont_before,
    'contendibili_after',  v_cont_after,
    'certificati', v_cert,
    'quarantinati', v_quar,
    'righe_senza_civico', v_no_civico,
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

COMMIT;
