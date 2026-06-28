
-- Multi-portale table: same immobile present on >=2 portals, but <2 distinct real agencies confirmed
CREATE TABLE IF NOT EXISTS public.padova_multi_portale (
  id bigserial PRIMARY KEY,
  chiave_match text,
  portals_seen text[] NOT NULL DEFAULT ARRAY[]::text[],
  portal_count int NOT NULL DEFAULT 0,
  agency_count_distinct int NOT NULL DEFAULT 0,
  agencies_normalized text[] NOT NULL DEFAULT ARRAY[]::text[],
  agenzie text[] NOT NULL DEFAULT ARRAY[]::text[],
  prezzo_min int,
  prezzo_max int,
  mq int,
  locali int,
  bagni int,
  quartiere text,
  lat double precision,
  lng double precision,
  urls text[] NOT NULL DEFAULT ARRAY[]::text[],
  n_annunci int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.padova_multi_portale TO authenticated;
GRANT ALL ON public.padova_multi_portale TO service_role;

ALTER TABLE public.padova_multi_portale ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manage multi_portale" ON public.padova_multi_portale;
CREATE POLICY "service role manage multi_portale" ON public.padova_multi_portale
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated read multi_portale" ON public.padova_multi_portale;
CREATE POLICY "authenticated read multi_portale" ON public.padova_multi_portale
  FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_padova_multi_portale_created_at ON public.padova_multi_portale (created_at DESC);

-- Rewrite recompute: emit groups where rows>=2 AND distinct portals>=2,
-- then split into contendibili (>=2 distinct REAL agencies) vs multi_portale (<2 distinct agencies).
CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili(p_job_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total int := 0;
  v_groups_all int := 0;
  v_groups_cont int := 0;
  v_groups_multi int := 0;
  v_alta int := 0;
  v_media int := 0;
  v_annunci int := 0;
  v_examples jsonb := '[]'::jsonb;
  v_before_cont int := 0;
  v_before_multi int := 0;
  v_after_cont int := 0;
  v_after_multi int := 0;
BEGIN
  SELECT count(*) INTO v_before_cont FROM public.padova_contendibili;
  SELECT count(*) INTO v_before_multi FROM public.padova_multi_portale;

  UPDATE public.padova_collect_v2_items
     SET contendibile = false,
         contendibile_group_id = NULL,
         contendibile_confidenza = NULL
   WHERE mq IS NOT NULL;

  SELECT count(*) INTO v_total
    FROM public.padova_collect_v2_items
   WHERE mq IS NOT NULL;

  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT
    i.id, i.url, i.portal, i.mq, i.locali, i.bagni,
    i.agency AS agency_raw,
    CASE
      WHEN i.agency IS NULL THEN NULL
      WHEN lower(trim(i.agency)) = '' THEN NULL
      WHEN lower(trim(i.agency)) LIKE 'portal:%' THEN NULL
      WHEN lower(trim(i.agency)) IN ('casa','immobiliare','idealista','subito','privato','private') THEN NULL
      WHEN lower(trim(i.agency)) LIKE 'ha cancellato%' THEN NULL
      ELSE trim(i.agency)
    END AS agency_real,
    CASE
      WHEN i.agency IS NULL THEN NULL
      WHEN lower(trim(i.agency)) = '' THEN NULL
      WHEN lower(trim(i.agency)) LIKE 'portal:%' THEN NULL
      WHEN lower(trim(i.agency)) IN ('casa','immobiliare','idealista','subito','privato','private') THEN NULL
      WHEN lower(trim(i.agency)) LIKE 'ha cancellato%' THEN NULL
      ELSE NULLIF(public.norm_agency(i.agency), '')
    END AS agency_key,
    i.civico, i.lat, i.lng, i.prezzo, i.quartiere, i.raw_address,
    public.norm_via(i.raw_address) AS via_n,
    lower(coalesce(i.tipologia,'')) AS tipologia_n,
    regexp_replace(lower(coalesce(i.civico,'')),'[^a-z0-9]+','','g') AS civico_n,
    CASE WHEN i.bagni IS NULL THEN 'X' ELSE i.bagni::text END AS bagni_key
  FROM public.padova_collect_v2_items i
  WHERE i.mq IS NOT NULL
    AND i.locali IS NOT NULL
    AND i.tipologia IS NOT NULL
    AND public.norm_via(i.raw_address) NOT IN ('', 'na');

  CREATE TEMP TABLE _grp ON COMMIT DROP AS
  WITH bucketed AS (
    SELECT *, round((mq::numeric / 5.0))::int * 5 AS mq_bucket FROM _cand
  )
  SELECT
    via_n, locali, tipologia_n, mq_bucket, bagni_key,
    gen_random_uuid() AS group_uuid,
    via_n || '|' || locali::text || '|' || tipologia_n || '|' || mq_bucket::text || '|' || bagni_key AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT agency_key) FILTER (WHERE agency_key IS NOT NULL) AS n_agenzie_distinct,
    count(*) FILTER (WHERE agency_raw IS NOT NULL AND trim(agency_raw) <> '') AS n_agenzie_raw,
    array_agg(DISTINCT agency_real ORDER BY agency_real) FILTER (WHERE agency_real IS NOT NULL) AS agenzie_display,
    array_agg(DISTINCT agency_key  ORDER BY agency_key)  FILTER (WHERE agency_key  IS NOT NULL) AS agenzie_norm,
    array_agg(DISTINCT coalesce(portal,'unknown') ORDER BY coalesce(portal,'unknown')) AS fonti,
    count(DISTINCT coalesce(portal,'unknown')) AS n_portals,
    min(prezzo)::int AS prezzo_min,
    max(prezzo)::int AS prezzo_max,
    round(avg(mq))::int AS mq_avg,
    (array_agg(locali))[1] AS locali_pick,
    NULLIF(bagni_key,'X')::int AS bagni_pick,
    (array_agg(quartiere) FILTER (WHERE quartiere IS NOT NULL))[1] AS quartiere_pick,
    avg(lat) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL AND abs(lat)>0.000001 AND abs(lng)>0.000001) AS lat_avg,
    avg(lng) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL AND abs(lat)>0.000001 AND abs(lng)>0.000001) AS lng_avg,
    array_agg(url) FILTER (WHERE url IS NOT NULL) AS urls
  FROM bucketed
  GROUP BY via_n, locali, tipologia_n, mq_bucket, bagni_key
  HAVING count(*) >= 2
     AND count(DISTINCT coalesce(portal,'unknown')) >= 2;

  CREATE TEMP TABLE _row_conf ON COMMIT DROP AS
  SELECT c.id, g.group_uuid,
    CASE
      WHEN c.civico_n <> '' AND EXISTS (
        SELECT 1 FROM _cand c2
        WHERE c2.id <> c.id
          AND c2.via_n = c.via_n
          AND c2.locali = c.locali
          AND c2.tipologia_n = c.tipologia_n
          AND round((c2.mq::numeric / 5.0))::int * 5 = round((c.mq::numeric / 5.0))::int * 5
          AND c2.civico_n = c.civico_n
      ) THEN 'ALTA' ELSE 'MEDIA'
    END AS confidenza,
    g.n_agenzie_distinct
  FROM _cand c
  JOIN _grp g
    ON g.via_n = c.via_n
   AND g.locali = c.locali
   AND g.tipologia_n = c.tipologia_n
   AND g.mq_bucket = round((c.mq::numeric / 5.0))::int * 5
   AND g.bagni_key = c.bagni_key;

  UPDATE public.padova_collect_v2_items i
     SET contendibile = (c.n_agenzie_distinct >= 2),
         contendibile_group_id = c.group_uuid,
         contendibile_confidenza = c.confidenza
    FROM _row_conf c
   WHERE i.id = c.id;

  SELECT count(*) INTO v_groups_all FROM _grp;
  SELECT count(*) INTO v_groups_cont FROM _grp WHERE n_agenzie_distinct >= 2;
  SELECT count(*) INTO v_groups_multi FROM _grp WHERE n_agenzie_distinct < 2;

  -- Always rebuild: protezione = solo se v_groups_all>0
  IF v_groups_all > 0 THEN
    TRUNCATE TABLE public.padova_contendibili RESTART IDENTITY;
    TRUNCATE TABLE public.padova_multi_portale RESTART IDENTITY;

    INSERT INTO public.padova_contendibili
      (chiave_match, n_agenzie, agenzie, fonti, confidenza,
       prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, n_annunci,
       agencies_normalized, agency_count_raw, agency_count_distinct, portals_seen)
    SELECT
      g.chiave_match, g.n_agenzie_distinct,
      COALESCE(g.agenzie_display, ARRAY[]::text[]),
      g.fonti,
      CASE WHEN EXISTS (SELECT 1 FROM _row_conf r WHERE r.group_uuid = g.group_uuid AND r.confidenza='ALTA') THEN 'ALTA' ELSE 'MEDIA' END,
      g.prezzo_min, g.prezzo_max, g.mq_avg, g.locali_pick, g.bagni_pick,
      g.quartiere_pick, g.lat_avg, g.lng_avg,
      COALESCE(g.urls, ARRAY[]::text[]), g.n_rows,
      COALESCE(g.agenzie_norm, ARRAY[]::text[]),
      g.n_agenzie_raw, g.n_agenzie_distinct, g.fonti
    FROM _grp g WHERE g.n_agenzie_distinct >= 2;

    INSERT INTO public.padova_multi_portale
      (chiave_match, portals_seen, portal_count, agency_count_distinct,
       agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, bagni,
       quartiere, lat, lng, urls, n_annunci)
    SELECT
      g.chiave_match, g.fonti, g.n_portals, g.n_agenzie_distinct,
      COALESCE(g.agenzie_norm, ARRAY[]::text[]),
      COALESCE(g.agenzie_display, ARRAY[]::text[]),
      g.prezzo_min, g.prezzo_max, g.mq_avg, g.locali_pick, g.bagni_pick,
      g.quartiere_pick, g.lat_avg, g.lng_avg,
      COALESCE(g.urls, ARRAY[]::text[]), g.n_rows
    FROM _grp g WHERE g.n_agenzie_distinct < 2;
  END IF;

  SELECT count(*) INTO v_annunci FROM _row_conf;
  SELECT count(*) INTO v_alta FROM _row_conf WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM _row_conf WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_after_cont FROM public.padova_contendibili;
  SELECT count(*) INTO v_after_multi FROM public.padova_multi_portale;

  SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO v_examples FROM (
    SELECT jsonb_build_object('group_id',group_uuid,'via',via_n,'mq',mq_avg,'locali',locali,'tipologia',tipologia_n,'agenzie',agenzie_norm,'portals',fonti,'n_portals',n_portals,'n_agenzie',n_agenzie_distinct) AS x
    FROM _grp ORDER BY n_portals DESC, n_agenzie_distinct DESC LIMIT 5
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'annunci_con_mq', v_total,
    'totale_gruppi', v_groups_all,
    'gruppi_contendibili_verificati', v_groups_cont,
    'gruppi_multi_portale', v_groups_multi,
    'per_confidenza', jsonb_build_object('ALTA',v_alta,'MEDIA',v_media),
    'annunci_in_gruppi', v_annunci,
    'padova_contendibili_before', v_before_cont,
    'padova_contendibili_after', v_after_cont,
    'padova_multi_portale_before', v_before_multi,
    'padova_multi_portale_after', v_after_multi,
    'protezione_no_truncate', (v_groups_all = 0),
    'esempi', v_examples
  );
END;
$function$;
