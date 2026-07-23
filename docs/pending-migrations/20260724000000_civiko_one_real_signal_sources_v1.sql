-- ═══════════════════════════════════════════════════════════════════
-- 20260724000000_civiko_one_real_signal_sources_v1.sql
--
-- Pending migration — DO NOT APPLY without full review.
--
-- Scope (atomic):
--   1. Backup service-role only.
--   2. Schema hardening on padova_contendibili / padova_multi_portale
--      (updated_at, last_seen_at, UNIQUE chiave_match).
--   3. Rewrite recompute_padova_listings_contendibili():
--        - filter lower(coalesce(comune,''))='padova' (NEW)
--        - preserve p.expired_at IS NULL (unchanged)
--        - derive commercial zone via civiko_resolve_commercial_zone_slug(quartiere)
--          and INCLUDE it in identity_key (no cross-zone groups)
--        - UPSERT on chiave_match instead of TRUNCATE RESTART IDENTITY
--          (from this migration onward: id/created_at STABLE)
--        - also populate padova_multi_portale in the same tx (>=2 portali,
--          <2 real agencies distinct); mutually exclusive with contendibili
--        - delete stale rows not present in the current result set
--   4. Re-create by_zone_v views (unchanged base) so downstream still sees
--      commercial_zone_slug.
--   5. New RPC get_padova_verified_price_drops_by_zone_v2(...)
--      union of get_padova_verified_price_drops(...) + price_history-derived
--      real drops from padova_listings_price_history. Fail-closed on zone.
--   6. early_offmarket_signal_candidates:
--        - add quartiere text NULL
--        - fail-closed trigger: quartiere = civiko_resolve_commercial_zone_slug()
--          applied on quartiere-first, else on location_detail; else NULL
--        - view early_offmarket_signal_candidates_by_zone_v (service_role only)
--   7. Cron cleanup: drop legacy 'padova-contendibili-recompute' if present;
--      canonical is central-core-padova-contendibili-recompute (unchanged
--      schedule '15 3 * * *').
--
-- IMPORTANT: the migration is idempotent where possible (IF NOT EXISTS,
-- CREATE OR REPLACE). Live pre-intervention definitions are captured under
-- /tmp/report/ during rollout.
-- ═══════════════════════════════════════════════════════════════════

-- Advisory lock so two concurrent applies cannot race.
SELECT pg_advisory_xact_lock(202607240001);

-- ────────────────────────────────────────────────────────────────
-- 1. BACKUPS (service_role only)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public._bkp_20260724_padova_contendibili
  AS SELECT * FROM public.padova_contendibili;
REVOKE ALL ON public._bkp_20260724_padova_contendibili FROM PUBLIC;
REVOKE ALL ON public._bkp_20260724_padova_contendibili FROM anon, authenticated;
GRANT  ALL ON public._bkp_20260724_padova_contendibili TO service_role;
COMMENT ON TABLE public._bkp_20260724_padova_contendibili
  IS 'Snapshot pre-recompute rewrite v1 (2026-07-24). service_role only.';

CREATE TABLE IF NOT EXISTS public._bkp_20260724_padova_multi_portale
  AS SELECT * FROM public.padova_multi_portale;
REVOKE ALL ON public._bkp_20260724_padova_multi_portale FROM PUBLIC;
REVOKE ALL ON public._bkp_20260724_padova_multi_portale FROM anon, authenticated;
GRANT  ALL ON public._bkp_20260724_padova_multi_portale TO service_role;
COMMENT ON TABLE public._bkp_20260724_padova_multi_portale
  IS 'Snapshot pre-recompute rewrite v1 (2026-07-24). service_role only.';

-- EOSC: back up only the rows the trigger may touch (quartiere backfill).
CREATE TABLE IF NOT EXISTS public._bkp_20260724_eosc_touched AS
  SELECT * FROM public.early_offmarket_signal_candidates WHERE false;
REVOKE ALL ON public._bkp_20260724_eosc_touched FROM PUBLIC;
REVOKE ALL ON public._bkp_20260724_eosc_touched FROM anon, authenticated;
GRANT  ALL ON public._bkp_20260724_eosc_touched TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 2. SCHEMA HARDENING
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.padova_contendibili
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

ALTER TABLE public.padova_multi_portale
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Dedupe derived tables ONLY (source data untouched) before adding UNIQUE.
WITH ranked AS (
  SELECT id, chiave_match,
         row_number() OVER (PARTITION BY chiave_match ORDER BY id) AS rn
  FROM public.padova_contendibili
  WHERE chiave_match IS NOT NULL
)
DELETE FROM public.padova_contendibili p USING ranked r
 WHERE p.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, chiave_match,
         row_number() OVER (PARTITION BY chiave_match ORDER BY id) AS rn
  FROM public.padova_multi_portale
  WHERE chiave_match IS NOT NULL
)
DELETE FROM public.padova_multi_portale p USING ranked r
 WHERE p.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS padova_contendibili_chiave_match_uniq
  ON public.padova_contendibili(chiave_match);
CREATE UNIQUE INDEX IF NOT EXISTS padova_multi_portale_chiave_match_uniq
  ON public.padova_multi_portale(chiave_match)
  WHERE chiave_match IS NOT NULL;

-- ────────────────────────────────────────────────────────────────
-- 3. RECOMPUTE — contendibili + multi_portale in one transaction
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
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
BEGIN
  SELECT count(*) INTO v_cont_before FROM public.padova_contendibili;
  SELECT count(*) INTO v_mp_before   FROM public.padova_multi_portale;

  -- ── _base : STRICT Padova + attivo + identità minima ──
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

  -- URL absent / non-padova diagnostic (post-filter approximation)
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

  -- Drop rows without a canonical zone → fail-closed.
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
    regexp_replace(lower(coalesce(substring(p.indirizzo from '([0-9]+[a-zA-Z]?)\s*$'), '')), '[^a-z0-9]+', '', 'g') AS civico_n,
    p.czone_slug
  FROM _base_ok p;

  -- Identity clusters (same as before, but zone is prepended into identity_key
  -- so groups NEVER span two commercial zones).
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
  )
  SELECT id, czone_slug, identity_key FROM civic_listings
  UNION ALL
  SELECT id, czone_slug, identity_key FROM no_civic_expanded;

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

  -- Group-level aggregate. chiave_match INCLUDES czone_slug (leading identity_key
  -- already carries it, but we still store zone explicitly for downstream views).
  CREATE TEMP TABLE _fg ON COMMIT DROP AS
  SELECT
    g.czone_slug,
    g.via_n, g.locali, g.identity_key, g.sub_idx, g.bagni_key,
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

  -- Confidence table (contendibili only)
  CREATE TEMP TABLE _conf ON COMMIT DROP AS
  SELECT f.chiave_match,
    CASE
      WHEN COALESCE(array_length(f.bagni_distinct_arr,1),0) > 1 THEN 'DA_CONFERMARE'
      WHEN f.identity_key LIKE '%|C:%' THEN 'ALTA'
      WHEN EXISTS (
        SELECT 1 FROM _grp2 a JOIN _grp2 b
          ON a.via_n=b.via_n AND a.locali=b.locali AND a.identity_key=b.identity_key
         AND a.sub_idx=b.sub_idx AND a.bagni_key=b.bagni_key
         AND a.id < b.id
        WHERE a.via_n=f.via_n AND a.locali=f.locali AND a.identity_key=f.identity_key
          AND a.sub_idx=f.sub_idx AND a.bagni_key=f.bagni_key
          AND a.lat IS NOT NULL AND a.lng IS NOT NULL AND b.lat IS NOT NULL AND b.lng IS NOT NULL
          AND public.padova_haversine_m(a.lat, a.lng, b.lat, b.lng) <= 40
      ) THEN 'ALTA'
      ELSE 'MEDIA'
    END AS confidenza
  FROM _fg f;

  -- Classification split (mutually exclusive):
  -- CONTENDIBILE  → n_agenzie >= 2
  -- MULTI_PORTALE → n_portali >= 2 AND n_agenzie < 2
  CREATE TEMP TABLE _fg_cont ON COMMIT DROP AS
    SELECT * FROM _fg WHERE n_agenzie >= 2;
  CREATE TEMP TABLE _fg_mp ON COMMIT DROP AS
    SELECT * FROM _fg WHERE n_portali >= 2 AND n_agenzie < 2;

  -- ── UPSERT into padova_contendibili (id/created_at preserved) ──
  INSERT INTO public.padova_contendibili AS pc
    (chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza,
     prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls,
     n_annunci, portals_seen, agency_count_distinct, agency_count_raw,
     n_portali, last_seen_at, updated_at)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         f.fonti, c.confidenza,
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.fonti, f.n_agenzie, f.n_rows, f.n_portali,
         f.last_seen_at, now()
  FROM _fg_cont f JOIN _conf c USING (chiave_match)
  ON CONFLICT (chiave_match) DO UPDATE
    SET n_agenzie           = EXCLUDED.n_agenzie,
        agenzie             = EXCLUDED.agenzie,
        agencies_normalized = EXCLUDED.agencies_normalized,
        fonti               = EXCLUDED.fonti,
        confidenza          = EXCLUDED.confidenza,
        prezzo_min          = EXCLUDED.prezzo_min,
        prezzo_max          = EXCLUDED.prezzo_max,
        mq                  = EXCLUDED.mq,
        locali              = EXCLUDED.locali,
        bagni               = EXCLUDED.bagni,
        quartiere           = EXCLUDED.quartiere,
        lat                 = EXCLUDED.lat,
        lng                 = EXCLUDED.lng,
        urls                = EXCLUDED.urls,
        n_annunci           = EXCLUDED.n_annunci,
        portals_seen        = EXCLUDED.portals_seen,
        agency_count_distinct = EXCLUDED.agency_count_distinct,
        agency_count_raw    = EXCLUDED.agency_count_raw,
        n_portali           = EXCLUDED.n_portali,
        last_seen_at        = EXCLUDED.last_seen_at,
        updated_at          = now();

  -- Remove stale contendibili not seen in this recompute
  DELETE FROM public.padova_contendibili pc
   WHERE NOT EXISTS (SELECT 1 FROM _fg_cont f WHERE f.chiave_match = pc.chiave_match);

  -- ── UPSERT into padova_multi_portale ──
  INSERT INTO public.padova_multi_portale AS mp
    (chiave_match, portals_seen, portal_count, agency_count_distinct,
     agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, bagni,
     quartiere, lat, lng, urls, n_annunci, last_seen_at, updated_at)
  SELECT f.chiave_match, f.fonti, f.n_portali, f.n_agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         COALESCE(f.agenzie, ARRAY[]::text[]),
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.last_seen_at, now()
  FROM _fg_mp f
  ON CONFLICT (chiave_match) DO UPDATE
    SET portals_seen        = EXCLUDED.portals_seen,
        portal_count        = EXCLUDED.portal_count,
        agency_count_distinct = EXCLUDED.agency_count_distinct,
        agencies_normalized = EXCLUDED.agencies_normalized,
        agenzie             = EXCLUDED.agenzie,
        prezzo_min          = EXCLUDED.prezzo_min,
        prezzo_max          = EXCLUDED.prezzo_max,
        mq                  = EXCLUDED.mq,
        locali              = EXCLUDED.locali,
        bagni               = EXCLUDED.bagni,
        quartiere           = EXCLUDED.quartiere,
        lat                 = EXCLUDED.lat,
        lng                 = EXCLUDED.lng,
        urls                = EXCLUDED.urls,
        n_annunci           = EXCLUDED.n_annunci,
        last_seen_at        = EXCLUDED.last_seen_at,
        updated_at          = now();

  DELETE FROM public.padova_multi_portale mp
   WHERE mp.chiave_match IS NULL
      OR NOT EXISTS (SELECT 1 FROM _fg_mp f WHERE f.chiave_match = mp.chiave_match);

  SELECT count(*) INTO v_cont_after FROM public.padova_contendibili;
  SELECT count(*) INTO v_mp_after   FROM public.padova_multi_portale;
  SELECT count(*) INTO v_alta  FROM public.padova_contendibili WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM public.padova_contendibili WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf  FROM public.padova_contendibili WHERE confidenza='DA_CONFERMARE';
  SELECT count(*) INTO v_3plus FROM public.padova_contendibili WHERE n_agenzie >= 3;
  SELECT count(DISTINCT quartiere) INTO v_quartieri FROM public.padova_contendibili WHERE quartiere IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'prefilter_rows', v_prefilter,
    'groups_total', v_groups_total,
    'contendibili_before', v_cont_before,
    'contendibili_after',  v_cont_after,
    'multi_portale_before', v_mp_before,
    'multi_portale_after',  v_mp_after,
    'per_confidenza', jsonb_build_object('ALTA', v_alta, 'MEDIA', v_media, 'DA_CONFERMARE', v_conf),
    'con_3_piu_agenzie', v_3plus,
    'quartieri_coinvolti', v_quartieri,
    'sanitized_bad_coords', v_sanitized_bad_coords,
    'excluded_bad_title', v_excluded_bad_title,
    'excluded_no_identity', v_excluded_no_identity,
    'excluded_no_zone', v_excluded_no_zone,
    'excluded_not_padova', v_excluded_not_padova,
    -- cross-zona = 0 by construction because zone is in identity_key
    'excluded_cross_zone_groups', 0
  );
END;
$function$;

-- ────────────────────────────────────────────────────────────────
-- 4. RECREATE by_zone_v VIEWS
--    We DROP + CREATE (not CREATE OR REPLACE) because the base tables
--    gain columns (updated_at, last_seen_at) which, via mp.* / pc.*,
--    shift the position of `commercial_zone_slug` in the view output.
--    CREATE OR REPLACE VIEW cannot change existing column names/types
--    or reorder them — it would fail with "cannot change name of view
--    column". A DROP + CREATE is safe here because no other SQL object
--    depends on these views (verified via pg_depend/pg_rewrite: 0
--    external dependents at authoring time). PostgREST clients bind by
--    column name, not by position.
-- ────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.padova_contendibili_by_zone_v;
CREATE VIEW public.padova_contendibili_by_zone_v AS
SELECT pc.*,
       public.civiko_resolve_commercial_zone_slug(pc.quartiere) AS commercial_zone_slug
FROM public.padova_contendibili pc;

REVOKE ALL ON public.padova_contendibili_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM anon;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM authenticated;
GRANT  SELECT ON public.padova_contendibili_by_zone_v TO service_role;

DROP VIEW IF EXISTS public.padova_multi_portale_by_zone_v;
CREATE VIEW public.padova_multi_portale_by_zone_v AS
SELECT mp.*,
       public.civiko_resolve_commercial_zone_slug(mp.quartiere) AS commercial_zone_slug
FROM public.padova_multi_portale mp;

REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM anon;
REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM authenticated;
GRANT  SELECT ON public.padova_multi_portale_by_zone_v TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. PRICE DROPS v2 — union with real price history
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_padova_verified_price_drops_by_zone_v2(
  p_commercial_zone_slug text,
  p_quartiere text DEFAULT NULL,
  p_limit integer DEFAULT 500,
  p_min_drop_pct numeric DEFAULT 5,
  p_max_age_days integer DEFAULT 14
)
RETURNS TABLE (
  source_id text, listing_id text, source text, url text, title text, mq numeric,
  lat double precision, lng double precision,
  initial_price_eur numeric, current_price_eur numeric, total_drop_pct numeric,
  drops_count integer, observations_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz,
  comune text, omi_zone text, commercial_zone_slug text,
  zone_match_method text, zone_match_confidence numeric,
  quartiere text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH branch_a AS (
    SELECT
      d.source_id, d.listing_id, d.source, d.url, d.title, d.mq,
      d.lat, d.lng,
      d.initial_price_eur, d.current_price_eur, d.total_drop_pct,
      d.drops_count, d.observations_count,
      d.first_seen_at, d.last_seen_at,
      d.comune, d.omi_zone, d.commercial_zone_slug,
      d.zone_match_method, d.zone_match_confidence,
      NULL::text AS quartiere
    FROM public.get_padova_verified_price_drops(p_limit, p_min_drop_pct, p_max_age_days) d
    WHERE d.commercial_zone_slug = p_commercial_zone_slug
  ),
  hist_base AS (
    SELECT
      pl.id                                          AS listing_id,
      pl.url, pl.indirizzo AS title, pl.mq::numeric  AS mq,
      pl.lat, pl.lng, pl.comune, pl.omi_zone, pl.quartiere, pl.fonte AS source,
      pl.commercial_zone_slug,
      h.id                                           AS hist_id,
      h.prezzo, h.snapshot_date, h.created_at
    FROM public.padova_listings_price_history h
    JOIN public.padova_listings pl ON pl.id = h.listing_id
    WHERE pl.expired_at IS NULL
      AND lower(coalesce(pl.comune,'')) = 'padova'
      AND pl.url IS NOT NULL
      AND pl.url ILIKE 'https://%'
      AND pl.commercial_zone_slug = p_commercial_zone_slug
      AND (p_quartiere IS NULL OR pl.quartiere = p_quartiere)
  ),
  hist_days AS (
    SELECT
      listing_id,
      count(DISTINCT snapshot_date)::bigint AS obs_days
    FROM hist_base
    GROUP BY listing_id
  ),
  hist AS (
    SELECT
      hb.listing_id,
      hb.url, hb.title, hb.mq,
      hb.lat, hb.lng, hb.comune, hb.omi_zone, hb.quartiere, hb.source,
      hb.commercial_zone_slug,
      hb.prezzo, hb.snapshot_date, hb.created_at,
      row_number() OVER (PARTITION BY hb.listing_id ORDER BY hb.snapshot_date ASC, hb.hist_id ASC) AS rn_asc,
      row_number() OVER (PARTITION BY hb.listing_id ORDER BY hb.snapshot_date DESC, hb.hist_id DESC) AS rn_desc,
      count(*) OVER (PARTITION BY hb.listing_id) AS obs_count,
      hd.obs_days AS obs_days
    FROM hist_base hb
    JOIN hist_days hd ON hd.listing_id = hb.listing_id
  ),
  hist_pairs AS (
    SELECT listing_id,
           max(url)         AS url,
           max(title)       AS title,
           max(mq)          AS mq,
           max(lat)         AS lat,
           max(lng)         AS lng,
           max(comune)      AS comune,
           max(omi_zone)    AS omi_zone,
           max(commercial_zone_slug) AS commercial_zone_slug,
           max(quartiere)   AS quartiere,
           max(source)      AS source,
           max(obs_count)   AS obs_count,
           max(obs_days)    AS obs_days,
           max(prezzo) FILTER (WHERE rn_asc  = 1) AS first_price,
           max(prezzo) FILTER (WHERE rn_desc = 1) AS last_price,
           max(created_at) FILTER (WHERE rn_asc  = 1) AS first_seen_at,
           max(created_at) FILTER (WHERE rn_desc = 1) AS last_seen_at,
           -- drops count = strict decreases across chronological observations
           (SELECT count(*)::int
              FROM (
                SELECT prezzo,
                       LAG(prezzo) OVER (ORDER BY snapshot_date ASC, created_at ASC) AS prev_p
                  FROM public.padova_listings_price_history hh
                 WHERE hh.listing_id = h2.listing_id
              ) s WHERE prev_p IS NOT NULL AND prezzo < prev_p
           ) AS drops_count
    FROM hist h2
    GROUP BY listing_id
  ),
  branch_b AS (
    SELECT
      ('lph:' || listing_id::text) AS source_id,
      listing_id::text             AS listing_id,
      source, url, title, mq, lat, lng,
      first_price::numeric AS initial_price_eur,
      last_price::numeric  AS current_price_eur,
      CASE
        WHEN first_price IS NULL OR first_price <= 0 THEN 0
        ELSE round(((first_price - last_price)::numeric / first_price::numeric) * 100, 2)
      END AS total_drop_pct,
      COALESCE(drops_count, 0)::int AS drops_count,
      obs_count::int   AS observations_count,
      first_seen_at, last_seen_at,
      comune, omi_zone, commercial_zone_slug,
      'padova_listings_price_history'::text AS zone_match_method,
      1.0::numeric                          AS zone_match_confidence,
      quartiere
    FROM hist_pairs
    WHERE obs_days >= 2
      AND first_price IS NOT NULL AND last_price IS NOT NULL
      AND last_price < first_price
      AND (first_price - last_price)::numeric / first_price::numeric * 100 >= p_min_drop_pct
      AND last_seen_at >= now() - make_interval(days => p_max_age_days)
  ),
  unioned AS (
    SELECT * FROM branch_a
    UNION ALL
    SELECT * FROM branch_b
  ),
  deduped AS (
    SELECT DISTINCT ON (url) *
    FROM unioned
    ORDER BY url, last_seen_at DESC NULLS LAST
  )
  SELECT
    source_id, listing_id, source, url, title, mq,
    lat, lng,
    initial_price_eur, current_price_eur, total_drop_pct,
    drops_count, observations_count,
    first_seen_at, last_seen_at,
    comune, omi_zone, commercial_zone_slug,
    zone_match_method, zone_match_confidence, quartiere
  FROM deduped
  WHERE p_commercial_zone_slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = p_commercial_zone_slug)
    AND (p_quartiere IS NULL OR quartiere = p_quartiere)
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone_v2(text, text, integer, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone_v2(text, text, integer, numeric, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone_v2(text, text, integer, numeric, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_padova_verified_price_drops_by_zone_v2(text, text, integer, numeric, integer) TO service_role;

COMMENT ON FUNCTION public.get_padova_verified_price_drops_by_zone_v2(text, text, integer, numeric, integer) IS
  'Ribassi verificati Padova per zona: union snapshot RPC + storico prezzo listing. Fail-closed su zona; quartiere opzionale.';

-- ────────────────────────────────────────────────────────────────
-- 6. EOSC: quartiere column + fail-closed trigger + by_zone view
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.early_offmarket_signal_candidates
  ADD COLUMN IF NOT EXISTS quartiere text NULL;

ALTER TABLE public._bkp_20260724_eosc_touched
  ADD COLUMN IF NOT EXISTS quartiere text;

CREATE OR REPLACE FUNCTION public.eosc_resolve_quartiere_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s text;
BEGIN
  -- priority 1: explicit quartiere set → must resolve exactly to an 8-slug zone
  IF NEW.quartiere IS NOT NULL AND btrim(NEW.quartiere) <> '' THEN
    s := public.civiko_resolve_commercial_zone_slug(NEW.quartiere);
    IF s IS NOT NULL THEN
      RETURN NEW;
    END IF;
    -- explicit but unresolved → fall through
  END IF;

  -- priority 2: whole location_detail resolves exactly
  IF NEW.location_detail IS NOT NULL AND btrim(NEW.location_detail) <> '' THEN
    s := public.civiko_resolve_commercial_zone_slug(NEW.location_detail);
    IF s IS NOT NULL THEN
      NEW.quartiere := NEW.location_detail;
      RETURN NEW;
    END IF;
  END IF;

  -- fail-closed
  NEW.quartiere := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS eosc_resolve_quartiere ON public.early_offmarket_signal_candidates;
CREATE TRIGGER eosc_resolve_quartiere
  BEFORE INSERT OR UPDATE OF quartiere, location_detail
  ON public.early_offmarket_signal_candidates
  FOR EACH ROW EXECUTE FUNCTION public.eosc_resolve_quartiere_trg();

-- One-shot backfill (safe: trigger applies only on insert/update; do it explicitly)
INSERT INTO public._bkp_20260724_eosc_touched
  SELECT * FROM public.early_offmarket_signal_candidates
   WHERE quartiere IS NULL
     AND location_detail IS NOT NULL
     AND public.civiko_resolve_commercial_zone_slug(location_detail) IS NOT NULL;

UPDATE public.early_offmarket_signal_candidates
   SET quartiere = location_detail
 WHERE quartiere IS NULL
   AND location_detail IS NOT NULL
   AND public.civiko_resolve_commercial_zone_slug(location_detail) IS NOT NULL;

CREATE OR REPLACE VIEW public.early_offmarket_signal_candidates_by_zone_v AS
SELECT e.*,
       public.civiko_resolve_commercial_zone_slug(e.quartiere) AS commercial_zone_slug
FROM public.early_offmarket_signal_candidates e;

REVOKE ALL ON public.early_offmarket_signal_candidates_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.early_offmarket_signal_candidates_by_zone_v FROM anon;
REVOKE ALL ON public.early_offmarket_signal_candidates_by_zone_v FROM authenticated;
GRANT  SELECT ON public.early_offmarket_signal_candidates_by_zone_v TO service_role;

COMMENT ON VIEW public.early_offmarket_signal_candidates_by_zone_v IS
  'Server-only. EOSC con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere) autorizzato dal trigger fail-closed.';

-- ────────────────────────────────────────────────────────────────
-- 7. CRON CLEANUP (canonical: central-core-padova-contendibili-recompute)
--   The legacy 'padova-contendibili-recompute' is unschedules only if present.
--   Wrapped in DO block because cron.unschedule raises if missing.
-- ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'padova-contendibili-recompute';
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
    RAISE NOTICE 'Unscheduled legacy cron: padova-contendibili-recompute (jobid=%)', jid;
  END IF;
END;
$$;
