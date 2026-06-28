CREATE OR REPLACE FUNCTION public.recompute_padova_contendibili(p_job_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_total int := 0;
  v_groups int := 0;
  v_alta int := 0;
  v_media int := 0;
  v_conf int := 0;
  v_annunci int := 0;
  v_examples jsonb := '[]'::jsonb;
  v_before_contendibili int := 0;
  v_after_contendibili int := 0;
BEGIN
  SELECT count(*) INTO v_before_contendibili FROM public.padova_contendibili;

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
    i.id,
    i.url,
    i.portal,
    i.mq,
    i.locali,
    i.bagni,
    i.agency,
    i.civico,
    i.lat,
    i.lng,
    i.prezzo,
    i.quartiere,
    i.raw_address,
    public.norm_via(i.raw_address) AS via_n,
    lower(coalesce(i.tipologia,'')) AS tipologia_n,
    COALESCE(NULLIF(lower(trim(coalesce(i.agency,''))), ''), 'portal:' || coalesce(i.portal, 'unknown')) AS agency_key,
    regexp_replace(lower(coalesce(i.civico,'')),'[^a-z0-9]+','','g') AS civico_n,
    CASE WHEN i.bagni IS NULL THEN 'X' ELSE i.bagni::text END AS bagni_key
  FROM public.padova_collect_v2_items i
  WHERE i.mq IS NOT NULL
    AND i.locali IS NOT NULL
    AND i.tipologia IS NOT NULL
    AND public.norm_via(i.raw_address) NOT IN ('', 'na')
    AND (p_job_id IS NULL OR i.job_id = p_job_id OR true);

  CREATE TEMP TABLE _grp ON COMMIT DROP AS
  WITH bucketed AS (
    SELECT *, round((mq::numeric / 5.0))::int * 5 AS mq_bucket
    FROM _cand
  )
  SELECT
    via_n,
    locali,
    tipologia_n,
    mq_bucket,
    bagni_key,
    gen_random_uuid() AS group_uuid,
    via_n || '|' || locali::text || '|' || tipologia_n || '|' || mq_bucket::text || '|' || bagni_key AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT agency_key) AS n_agenzie,
    array_agg(DISTINCT coalesce(nullif(trim(agency), ''), portal, 'unknown') ORDER BY coalesce(nullif(trim(agency), ''), portal, 'unknown')) AS agenzie,
    array_agg(DISTINCT coalesce(portal,'unknown') ORDER BY coalesce(portal,'unknown')) AS fonti,
    min(prezzo)::int AS prezzo_min,
    max(prezzo)::int AS prezzo_max,
    round(avg(mq))::int AS mq_avg,
    (array_agg(locali))[1] AS locali_pick,
    NULLIF(bagni_key, 'X')::int AS bagni_pick,
    (array_agg(quartiere) FILTER (WHERE quartiere IS NOT NULL))[1] AS quartiere_pick,
    avg(lat) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL AND abs(lat) > 0.000001 AND abs(lng) > 0.000001) AS lat_avg,
    avg(lng) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL AND abs(lat) > 0.000001 AND abs(lng) > 0.000001) AS lng_avg,
    array_agg(url) FILTER (WHERE url IS NOT NULL) AS urls
  FROM bucketed
  GROUP BY via_n, locali, tipologia_n, mq_bucket, bagni_key
  HAVING count(*) >= 2 AND count(DISTINCT agency_key) >= 2;

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
      ) THEN 'ALTA'
      ELSE 'MEDIA'
    END AS confidenza
  FROM _cand c
  JOIN _grp g
    ON g.via_n = c.via_n
   AND g.locali = c.locali
   AND g.tipologia_n = c.tipologia_n
   AND g.mq_bucket = round((c.mq::numeric / 5.0))::int * 5
   AND g.bagni_key = c.bagni_key;

  UPDATE public.padova_collect_v2_items i
     SET contendibile = true,
         contendibile_group_id = c.group_uuid,
         contendibile_confidenza = c.confidenza
    FROM _row_conf c
   WHERE i.id = c.id;

  SELECT count(*) INTO v_groups FROM _grp;

  IF v_groups > 0 THEN
    TRUNCATE TABLE public.padova_contendibili RESTART IDENTITY;

    INSERT INTO public.padova_contendibili
      (chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, n_annunci)
    SELECT
      g.chiave_match,
      g.n_agenzie,
      g.agenzie,
      g.fonti,
      CASE WHEN EXISTS (SELECT 1 FROM _row_conf r WHERE r.group_uuid = g.group_uuid AND r.confidenza = 'ALTA') THEN 'ALTA' ELSE 'MEDIA' END,
      g.prezzo_min,
      g.prezzo_max,
      g.mq_avg,
      g.locali_pick,
      g.bagni_pick,
      g.quartiere_pick,
      g.lat_avg,
      g.lng_avg,
      COALESCE(g.urls, ARRAY[]::text[]),
      g.n_rows
    FROM _grp g;
  END IF;

  SELECT count(*) INTO v_annunci FROM _row_conf;
  SELECT count(*) INTO v_alta FROM _row_conf WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM _row_conf WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf FROM _row_conf WHERE confidenza='DA_CONFERMARE';
  SELECT count(*) INTO v_after_contendibili FROM public.padova_contendibili;

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_examples FROM (
    SELECT jsonb_build_object('group_id', group_uuid, 'via', via_n, 'mq', mq_avg, 'locali', locali, 'tipologia', tipologia_n, 'agenzie', agenzie) AS x
    FROM _grp
    LIMIT 5
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'annunci_con_mq', v_total,
    'totale_gruppi_contendibili', v_groups,
    'per_confidenza', jsonb_build_object('ALTA', v_alta, 'MEDIA', v_media, 'DA_CONFERMARE', v_conf),
    'annunci_contendibili', v_annunci,
    'padova_contendibili_before', v_before_contendibili,
    'padova_contendibili_after', v_after_contendibili,
    'contendibili_created', GREATEST(v_after_contendibili - v_before_contendibili, 0),
    'contendibili_updated', LEAST(v_before_contendibili, v_after_contendibili),
    'esempi_contendibili_alta', v_examples
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_padova_contendibili(text) TO service_role;