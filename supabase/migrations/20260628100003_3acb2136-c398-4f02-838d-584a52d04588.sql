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
  v_known_separated boolean := true;
  v_known_groups int;
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
    i.id, i.url, i.portal, i.mq, i.locali, i.bagni, i.agency, i.civico, i.lat, i.lng,
    i.prezzo, i.quartiere, i.raw_address,
    public.norm_via(i.raw_address) AS via_n,
    lower(coalesce(i.tipologia,'')) AS tipologia_n,
    CASE
      WHEN to_regproc('public.norm_agency(text)') IS NOT NULL THEN public.norm_agency(i.agency)
      ELSE lower(trim(coalesce(i.agency,'')))
    END AS agency_key,
    regexp_replace(lower(coalesce(i.civico,'')),'[^a-z0-9]+','','g') AS civico_n
  FROM public.padova_collect_v2_items i
  WHERE i.mq IS NOT NULL
    AND i.locali IS NOT NULL
    AND i.tipologia IS NOT NULL
    AND i.agency IS NOT NULL
    AND trim(i.agency) <> ''
    AND public.norm_via(i.raw_address) NOT IN ('', 'na')
    AND (p_job_id IS NULL OR i.job_id = p_job_id OR true);

  UPDATE _cand SET agency_key = lower(trim(coalesce(agency,''))) WHERE agency_key IS NULL OR agency_key = '';

  CREATE TEMP TABLE _grp ON COMMIT DROP AS
  WITH sorted AS (
    SELECT *,
      LAG(mq) OVER (PARTITION BY via_n, locali, tipologia_n ORDER BY mq, id) AS mq_prev
    FROM _cand
  ),
  flagged AS (
    SELECT *, CASE WHEN mq_prev IS NULL OR mq::numeric > mq_prev::numeric * 1.05 THEN 1 ELSE 0 END AS new_grp
    FROM sorted
  ),
  numbered AS (
    SELECT *, SUM(new_grp) OVER (PARTITION BY via_n, locali, tipologia_n ORDER BY mq, id) AS sub_idx
    FROM flagged
  )
  SELECT via_n, locali, tipologia_n, sub_idx, id, url, portal, mq, bagni, agency, agency_key,
         civico_n, lat, lng, prezzo, quartiere, raw_address
  FROM numbered;

  CREATE TEMP TABLE _grp2 ON COMMIT DROP AS
  WITH base AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY via_n, locali, tipologia_n, sub_idx ORDER BY id) AS rn_in_grp
    FROM _grp
  ),
  with_bagni AS (
    SELECT b.*,
      (SELECT array_agg(DISTINCT b2.bagni ORDER BY b2.bagni)
         FROM base b2
        WHERE b2.via_n=b.via_n AND b2.locali=b.locali AND b2.tipologia_n=b.tipologia_n
          AND b2.sub_idx=b.sub_idx AND b2.bagni IS NOT NULL) AS bagni_distinct
    FROM base b
  ),
  assigned AS (
    SELECT *,
      CASE
        WHEN bagni IS NOT NULL THEN bagni::text
        WHEN bagni_distinct IS NULL OR array_length(bagni_distinct,1) IS NULL THEN 'X'
        ELSE bagni_distinct[1]::text
      END AS bagni_key
    FROM with_bagni
  )
  SELECT via_n, locali, tipologia_n, sub_idx, bagni_key,
         id, url, portal, mq, bagni, agency, agency_key, civico_n, lat, lng, prezzo, quartiere, raw_address, bagni_distinct
  FROM assigned;

  CREATE TEMP TABLE _agency_display ON COMMIT DROP AS
  SELECT via_n, locali, tipologia_n, sub_idx, bagni_key, agency_key,
         (array_agg(agency ORDER BY length(agency) DESC, agency))[1] AS display
  FROM _grp2
  GROUP BY 1,2,3,4,5,6;

  CREATE TEMP TABLE _final_groups ON COMMIT DROP AS
  SELECT g.via_n, g.locali, g.tipologia_n, g.sub_idx, g.bagni_key,
         gen_random_uuid() AS group_uuid,
         g.via_n || '|' || g.locali::text || '|' || g.tipologia_n || '|' || g.sub_idx::text || '|' || g.bagni_key AS chiave_match,
         count(*) AS n_rows,
         count(DISTINCT g.agency_key) AS n_agenzie,
         (SELECT array_agg(display ORDER BY display)
            FROM _agency_display d
           WHERE d.via_n=g.via_n AND d.locali=g.locali AND d.tipologia_n=g.tipologia_n
             AND d.sub_idx=g.sub_idx AND d.bagni_key=g.bagni_key) AS agenzie,
         array_agg(DISTINCT coalesce(g.portal,'unknown') ORDER BY coalesce(g.portal,'unknown')) AS fonti,
         min(g.prezzo)::int AS prezzo_min,
         max(g.prezzo)::int AS prezzo_max,
         round(avg(g.mq))::int AS mq_avg,
         array_agg(g.url) FILTER (WHERE g.url IS NOT NULL) AS urls,
         (array_agg(g.quartiere) FILTER (WHERE g.quartiere IS NOT NULL))[1] AS quartiere,
         avg(g.lat) FILTER (WHERE g.lat IS NOT NULL) AS lat,
         avg(g.lng) FILTER (WHERE g.lng IS NOT NULL) AS lng,
         max(g.bagni_distinct) AS bagni_distinct_arr,
         (array_agg(g.bagni) FILTER (WHERE g.bagni IS NOT NULL))[1] AS bagni_pick
  FROM _grp2 g
  GROUP BY 1,2,3,4,5
  HAVING count(*) >= 2 AND count(DISTINCT g.agency_key) >= 2;

  CREATE TEMP TABLE _row_assign ON COMMIT DROP AS
  SELECT g.id, g.mq, g.bagni, g.civico_n, g.lat, g.lng, g.agency,
         f.group_uuid, f.via_n, f.locali, f.tipologia_n, f.bagni_key, f.bagni_distinct_arr
  FROM _grp2 g
  JOIN _final_groups f
    ON f.via_n=g.via_n AND f.locali=g.locali AND f.tipologia_n=g.tipologia_n
   AND f.sub_idx=g.sub_idx AND f.bagni_key=g.bagni_key;

  CREATE TEMP TABLE _row_conf ON COMMIT DROP AS
  SELECT a.id, a.group_uuid,
    CASE
      WHEN COALESCE(array_length(a.bagni_distinct_arr,1),0) > 1 THEN 'DA_CONFERMARE'
      WHEN EXISTS (
        SELECT 1 FROM _row_assign b
        WHERE b.group_uuid=a.group_uuid AND b.id<>a.id
          AND a.civico_n <> '' AND b.civico_n=a.civico_n
      ) THEN 'ALTA'
      WHEN a.lat IS NOT NULL AND a.lng IS NOT NULL AND EXISTS (
        SELECT 1 FROM _row_assign b
        WHERE b.group_uuid=a.group_uuid AND b.id<>a.id
          AND b.lat IS NOT NULL AND b.lng IS NOT NULL
          AND sqrt(power((b.lat-a.lat)*111111.0,2) + power((b.lng-a.lng)*111111.0*cos(radians(a.lat)),2)) <= 80
      ) THEN 'ALTA'
      WHEN a.bagni IS NULL AND COALESCE(array_length(a.bagni_distinct_arr,1),0) >= 1 THEN 'MEDIA'
      ELSE 'MEDIA'
    END AS confidenza
  FROM _row_assign a;

  UPDATE public.padova_collect_v2_items i
     SET contendibile = true,
         contendibile_group_id = c.group_uuid,
         contendibile_confidenza = c.confidenza
    FROM _row_conf c
   WHERE i.id = c.id;

  TRUNCATE TABLE public.padova_contendibili RESTART IDENTITY;

  INSERT INTO public.padova_contendibili
    (chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, n_annunci)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie, f.fonti,
         CASE
           WHEN COALESCE(array_length(f.bagni_distinct_arr,1),0) > 1 THEN 'DA_CONFERMARE'
           WHEN EXISTS (SELECT 1 FROM _row_conf c WHERE c.group_uuid=f.group_uuid AND c.confidenza='ALTA') THEN 'ALTA'
           ELSE 'MEDIA'
         END AS confidenza,
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick, f.quartiere, f.lat, f.lng,
         COALESCE(f.urls, ARRAY[]::text[]), f.n_rows
  FROM _final_groups f;

  SELECT count(*) INTO v_groups FROM _final_groups;
  SELECT count(*) INTO v_annunci FROM _row_conf;
  SELECT count(*) INTO v_alta FROM _row_conf WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM _row_conf WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf FROM _row_conf WHERE confidenza='DA_CONFERMARE';
  SELECT count(*) INTO v_after_contendibili FROM public.padova_contendibili;

  SELECT count(DISTINCT COALESCE(contendibile_group_id::text, 'none-' || id::text))
    INTO v_known_groups
    FROM public.padova_collect_v2_items
   WHERE url ILIKE '%128366330%' OR url ILIKE '%124467797%' OR url ILIKE '%53485960%';
  v_known_separated := v_known_groups >= (
    SELECT count(*) FROM public.padova_collect_v2_items
     WHERE url ILIKE '%128366330%' OR url ILIKE '%124467797%' OR url ILIKE '%53485960%'
  );

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_examples FROM (
    SELECT jsonb_build_object(
      'group_id', f.group_uuid,
      'via', f.via_n,
      'mq', f.mq_avg,
      'locali', f.locali,
      'tipologia', f.tipologia_n,
      'agenzie', f.agenzie,
      'confidenza', CASE WHEN EXISTS (SELECT 1 FROM _row_conf c WHERE c.group_uuid=f.group_uuid AND c.confidenza='ALTA') THEN 'ALTA' ELSE 'MEDIA' END
    ) AS x
    FROM _final_groups f
    WHERE EXISTS (SELECT 1 FROM _row_conf c WHERE c.group_uuid=f.group_uuid AND c.confidenza='ALTA')
    LIMIT 5
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'cron_spento', NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='padova_detail_chain'),
    'annunci_con_mq', v_total,
    'totale_gruppi_contendibili', v_groups,
    'per_confidenza', jsonb_build_object('ALTA', v_alta, 'MEDIA', v_media, 'DA_CONFERMARE', v_conf),
    'annunci_contendibili', v_annunci,
    'padova_contendibili_before', v_before_contendibili,
    'padova_contendibili_after', v_after_contendibili,
    'contendibili_created', GREATEST(v_after_contendibili - v_before_contendibili, 0),
    'contendibili_updated', LEAST(v_before_contendibili, v_after_contendibili),
    'caso_noto_3_link_ora_separati', v_known_separated,
    'esempi_contendibili_alta', v_examples
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_padova_contendibili(text) TO service_role;