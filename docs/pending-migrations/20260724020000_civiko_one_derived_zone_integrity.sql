-- 20260724020000_civiko_one_derived_zone_integrity.sql
-- Persist commercial_zone_slug on padova_contendibili and padova_multi_portale,
-- run atomic recompute preserving IDs, then enforce NOT NULL + FK.
-- Atomic transaction. No data widened elsewhere. No cron/deploy touched.

BEGIN;

SELECT pg_advisory_xact_lock(776024020000);

-- ---------- 1. BACKUP ----------
DROP TABLE IF EXISTS public._bkp_20260724020000_cont;
DROP TABLE IF EXISTS public._bkp_20260724020000_mp;

CREATE TABLE public._bkp_20260724020000_cont AS
  SELECT * FROM public.padova_contendibili;
CREATE TABLE public._bkp_20260724020000_mp AS
  SELECT * FROM public.padova_multi_portale;

REVOKE ALL ON public._bkp_20260724020000_cont FROM PUBLIC;
REVOKE ALL ON public._bkp_20260724020000_cont FROM anon, authenticated;
GRANT  ALL ON public._bkp_20260724020000_cont TO service_role;

REVOKE ALL ON public._bkp_20260724020000_mp FROM PUBLIC;
REVOKE ALL ON public._bkp_20260724020000_mp FROM anon, authenticated;
GRANT  ALL ON public._bkp_20260724020000_mp TO service_role;

-- Registrazione coppie id/chiave_match iniziali
DROP TABLE IF EXISTS public._bkp_20260724020000_cont_ids;
DROP TABLE IF EXISTS public._bkp_20260724020000_mp_ids;

CREATE TABLE public._bkp_20260724020000_cont_ids AS
  SELECT id, chiave_match FROM public.padova_contendibili;
CREATE TABLE public._bkp_20260724020000_mp_ids AS
  SELECT id, chiave_match FROM public.padova_multi_portale;

REVOKE ALL ON public._bkp_20260724020000_cont_ids FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public._bkp_20260724020000_mp_ids   FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public._bkp_20260724020000_cont_ids TO service_role;
GRANT  ALL ON public._bkp_20260724020000_mp_ids   TO service_role;

-- ---------- 2. PERSISTI LA ZONA ----------
ALTER TABLE public.padova_contendibili
  ADD COLUMN IF NOT EXISTS commercial_zone_slug text;
ALTER TABLE public.padova_multi_portale
  ADD COLUMN IF NOT EXISTS commercial_zone_slug text;

-- ---------- 3. RICREA RECOMPUTE ----------
CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
    regexp_replace(lower(coalesce(substring(p.indirizzo from '([0-9]+[a-zA-Z]?)\s*$'), '')), '[^a-z0-9]+', '', 'g') AS civico_n,
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

  CREATE TEMP TABLE _fg_cont ON COMMIT DROP AS
    SELECT * FROM _fg WHERE n_agenzie >= 2;
  CREATE TEMP TABLE _fg_mp ON COMMIT DROP AS
    SELECT * FROM _fg WHERE n_portali >= 2 AND n_agenzie < 2;

  -- UPSERT CONTENDIBILI (with commercial_zone_slug)
  INSERT INTO public.padova_contendibili AS pc
    (chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza,
     prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls,
     n_annunci, portals_seen, agency_count_distinct, agency_count_raw,
     n_portali, last_seen_at, updated_at, commercial_zone_slug)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a)
                 FROM unnest(f.agenzie) AS a
                WHERE a IS NOT NULL AND btrim(a) <> ''),
         f.fonti, c.confidenza,
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick,
         f.quartiere, f.lat, f.lng, f.urls, f.n_rows,
         f.fonti, f.n_agenzie, f.n_rows, f.n_portali,
         f.last_seen_at, now(), f.czone_slug
  FROM _fg_cont f JOIN _conf c USING (chiave_match)
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
        commercial_zone_slug  = EXCLUDED.commercial_zone_slug;

  -- UPSERT MULTI-PORTALE (with commercial_zone_slug)
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
  FROM _fg_mp f
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

  -- DELETE stale (dopo UPSERT)
  DELETE FROM public.padova_contendibili pc
   WHERE NOT EXISTS (SELECT 1 FROM _fg_cont f WHERE f.chiave_match = pc.chiave_match);

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
    'excluded_cross_zone_groups', 0
  );
END;
$function$;

-- ---------- 4. VIEW (stessa firma, slug persistito) ----------
CREATE OR REPLACE VIEW public.padova_contendibili_by_zone_v AS
SELECT
  id, chiave_match, n_agenzie, agenzie, fonti, confidenza,
  prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls,
  n_annunci, created_at, prezzo_medio_zona_eur_mq, prezzo_immobile_eur_mq,
  differenza_zona_pct, giorni_sul_mercato, data_primo_annuncio,
  agencies_normalized, agency_count_raw, agency_count_distinct, portals_seen,
  ribasso_pct, n_ribassi, is_ripubblicato, cambio_agenzia, giorni_fermo,
  n_portali, score_pressione, cambio_agenzia_data, cambio_agenzia_da,
  cambio_agenzia_a, updated_at, last_seen_at,
  commercial_zone_slug
FROM public.padova_contendibili pc;

CREATE OR REPLACE VIEW public.padova_multi_portale_by_zone_v AS
SELECT
  id, chiave_match, portals_seen, portal_count, agency_count_distinct,
  agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, bagni,
  quartiere, lat, lng, urls, n_annunci, created_at, updated_at, last_seen_at,
  commercial_zone_slug
FROM public.padova_multi_portale mp;

-- ---------- 5. RECOMPUTE ATOMICO ----------
DO $$
DECLARE
  v_result jsonb;
  v_bad_slug_cont int;
  v_bad_slug_mp   int;
  v_null_slug_cont int;
  v_null_slug_mp   int;
  v_dup_cont int;
  v_dup_mp   int;
  v_null_km_cont int;
  v_null_km_mp   int;
  v_id_mismatch_cont int;
  v_id_mismatch_mp   int;
  v_bad_expired int;
  v_bad_not_padova int;
BEGIN
  PERFORM public.recompute_padova_listings_contendibili();

  -- NULL slug
  SELECT count(*) INTO v_null_slug_cont
    FROM public.padova_contendibili WHERE commercial_zone_slug IS NULL;
  SELECT count(*) INTO v_null_slug_mp
    FROM public.padova_multi_portale WHERE commercial_zone_slug IS NULL;
  IF v_null_slug_cont > 0 OR v_null_slug_mp > 0 THEN
    RAISE EXCEPTION 'commercial_zone_slug NULL rilevato: cont=%, mp=%', v_null_slug_cont, v_null_slug_mp;
  END IF;

  -- Slug fuori dalle 8 zone ufficiali (via civiko_commercial_zones)
  SELECT count(*) INTO v_bad_slug_cont
    FROM public.padova_contendibili pc
   WHERE NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = pc.commercial_zone_slug);
  SELECT count(*) INTO v_bad_slug_mp
    FROM public.padova_multi_portale mp
   WHERE NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = mp.commercial_zone_slug);
  IF v_bad_slug_cont > 0 OR v_bad_slug_mp > 0 THEN
    RAISE EXCEPTION 'slug fuori 8 zone: cont=%, mp=%', v_bad_slug_cont, v_bad_slug_mp;
  END IF;

  -- chiave_match NULL o duplicati
  SELECT count(*) INTO v_null_km_cont FROM public.padova_contendibili WHERE chiave_match IS NULL;
  SELECT count(*) INTO v_null_km_mp   FROM public.padova_multi_portale WHERE chiave_match IS NULL;
  IF v_null_km_cont > 0 OR v_null_km_mp > 0 THEN
    RAISE EXCEPTION 'chiave_match NULL: cont=%, mp=%', v_null_km_cont, v_null_km_mp;
  END IF;

  SELECT COALESCE(sum(c),0) INTO v_dup_cont FROM (
    SELECT count(*) c FROM public.padova_contendibili GROUP BY chiave_match HAVING count(*)>1
  ) d;
  SELECT COALESCE(sum(c),0) INTO v_dup_mp FROM (
    SELECT count(*) c FROM public.padova_multi_portale GROUP BY chiave_match HAVING count(*)>1
  ) d;
  IF v_dup_cont > 0 OR v_dup_mp > 0 THEN
    RAISE EXCEPTION 'chiave_match duplicata: cont=%, mp=%', v_dup_cont, v_dup_mp;
  END IF;

  -- Cross-zone groups: chiave_match che compare in più slug (impossibile per costruzione, ma controllo)
  IF EXISTS (
    SELECT 1 FROM public.padova_contendibili
    GROUP BY chiave_match HAVING count(DISTINCT commercial_zone_slug) > 1
  ) THEN
    RAISE EXCEPTION 'cross-zone group in padova_contendibili';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.padova_multi_portale
    GROUP BY chiave_match HAVING count(DISTINCT commercial_zone_slug) > 1
  ) THEN
    RAISE EXCEPTION 'cross-zone group in padova_multi_portale';
  END IF;

  -- ID stabili: per ogni chiave_match presente sia prima sia dopo, id identico
  SELECT count(*) INTO v_id_mismatch_cont
    FROM public._bkp_20260724020000_cont_ids b
    JOIN public.padova_contendibili n ON n.chiave_match = b.chiave_match
   WHERE b.id <> n.id;
  SELECT count(*) INTO v_id_mismatch_mp
    FROM public._bkp_20260724020000_mp_ids b
    JOIN public.padova_multi_portale n ON n.chiave_match = b.chiave_match
   WHERE b.id <> n.id;
  IF v_id_mismatch_cont > 0 OR v_id_mismatch_mp > 0 THEN
    RAISE EXCEPTION 'ID instabile per chiave_match sopravvissuta: cont=%, mp=%', v_id_mismatch_cont, v_id_mismatch_mp;
  END IF;

  -- Nessun record expired o non-Padova: qualsiasi URL nelle tabelle derivate deve corrispondere a listing valido
  SELECT count(*) INTO v_bad_expired
    FROM (
      SELECT unnest(urls) AS u FROM public.padova_contendibili
      UNION ALL
      SELECT unnest(urls) AS u FROM public.padova_multi_portale
    ) all_urls
    JOIN public.padova_listings l ON l.url = all_urls.u
   WHERE l.expired_at IS NOT NULL;
  IF v_bad_expired > 0 THEN
    RAISE EXCEPTION 'record expired usati nelle derivate: %', v_bad_expired;
  END IF;

  SELECT count(*) INTO v_bad_not_padova
    FROM (
      SELECT unnest(urls) AS u FROM public.padova_contendibili
      UNION ALL
      SELECT unnest(urls) AS u FROM public.padova_multi_portale
    ) all_urls
    JOIN public.padova_listings l ON l.url = all_urls.u
   WHERE lower(coalesce(l.comune,'')) <> 'padova';
  IF v_bad_not_padova > 0 THEN
    RAISE EXCEPTION 'record non-Padova usati nelle derivate: %', v_bad_not_padova;
  END IF;
END
$$;

-- ---------- 6. VINCOLI ----------
ALTER TABLE public.padova_contendibili
  ALTER COLUMN commercial_zone_slug SET NOT NULL;
ALTER TABLE public.padova_multi_portale
  ALTER COLUMN commercial_zone_slug SET NOT NULL;

ALTER TABLE public.padova_contendibili
  ADD CONSTRAINT padova_contendibili_commercial_zone_slug_fkey
  FOREIGN KEY (commercial_zone_slug)
  REFERENCES public.civiko_commercial_zones(slug)
  ON UPDATE CASCADE;

ALTER TABLE public.padova_multi_portale
  ADD CONSTRAINT padova_multi_portale_commercial_zone_slug_fkey
  FOREIGN KEY (commercial_zone_slug)
  REFERENCES public.civiko_commercial_zones(slug)
  ON UPDATE CASCADE;

-- Indici UNIQUE non-partial su chiave_match: già installati dalla 20260724010000; nessuna modifica.

COMMIT;
