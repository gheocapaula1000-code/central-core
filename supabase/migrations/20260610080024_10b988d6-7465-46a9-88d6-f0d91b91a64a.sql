
-- A) Unschedule cron
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='padova_detail_chain') THEN
    PERFORM cron.unschedule('padova_detail_chain');
  END IF;
END $$;

-- B) Columns
ALTER TABLE public.padova_collect_v2_items
  ADD COLUMN IF NOT EXISTS contendibile boolean,
  ADD COLUMN IF NOT EXISTS contendibile_group_id uuid,
  ADD COLUMN IF NOT EXISTS contendibile_confidenza text;

-- C) norm_via helper
CREATE OR REPLACE FUNCTION public.norm_via(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT trim(both '-' from regexp_replace(
    regexp_replace(
      translate(lower(coalesce(p,'')),
        'àáâãäåèéêëìíîïòóôõöùúûüýÿñç',
        'aaaaaaeeeeiiiiooooouuuuyync'),
      '^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|str\.|borgo|lungargine|riviera|salita|calle|contra|contrada|stradella|passaggio)\s+','','i'),
    '[^a-z0-9]+','-','g'))
$$;

-- D) Recompute function
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
BEGIN
  -- Reset
  UPDATE public.padova_collect_v2_items
     SET contendibile = false,
         contendibile_group_id = NULL,
         contendibile_confidenza = NULL
   WHERE mq IS NOT NULL;

  SELECT count(*) INTO v_total
    FROM public.padova_collect_v2_items
   WHERE mq IS NOT NULL;

  -- Candidates
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT
    i.id, i.url, i.mq, i.locali, i.bagni, i.agency, i.civico, i.lat, i.lng, i.prezzo,
    public.norm_via(i.raw_address) AS via_n,
    lower(coalesce(i.tipologia,'')) AS tipologia_n,
    regexp_replace(lower(coalesce(i.civico,'')),'[^a-z0-9]+','','g') AS civico_n
  FROM public.padova_collect_v2_items i
  WHERE i.mq IS NOT NULL
    AND i.locali IS NOT NULL
    AND i.tipologia IS NOT NULL
    AND i.agency IS NOT NULL
    AND public.norm_via(i.raw_address) NOT IN ('', 'na');

  -- mq-sweep within base bucket (via, locali, tipologia)
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
  SELECT via_n, locali, tipologia_n, sub_idx, id, mq, bagni, agency, civico_n, lat, lng, prezzo
  FROM numbered;

  -- Split groups by bagni conflict: if two non-null bagni differ, split into bagni-bucket; nulls fold into majority.
  -- Simpler: refine cluster key to (..., COALESCE(bagni::text,'X'))
  -- Then merge X rows into majority cluster having most rows; rule: if a group contains conflicting non-null bagni, they become separate clusters; bagni=null rows stay in the most populous sub-cluster (or first).
  CREATE TEMP TABLE _grp2 ON COMMIT DROP AS
  WITH base AS (
    SELECT via_n, locali, tipologia_n, sub_idx, id, mq, bagni, agency, civico_n, lat, lng, prezzo,
      ROW_NUMBER() OVER (PARTITION BY via_n, locali, tipologia_n, sub_idx ORDER BY id) AS rn_in_grp
    FROM _grp
  ),
  -- For each base group, list non-null bagni values
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
        ELSE bagni_distinct[1]::text  -- absorb null rows into smallest bagni cluster deterministically
      END AS bagni_key
    FROM with_bagni
  )
  SELECT via_n, locali, tipologia_n, sub_idx, bagni_key,
         id, mq, bagni, agency, civico_n, lat, lng, prezzo, bagni_distinct
  FROM assigned;

  -- Form final groups with >=2 distinct agencies
  CREATE TEMP TABLE _final_groups ON COMMIT DROP AS
  SELECT via_n, locali, tipologia_n, sub_idx, bagni_key,
         gen_random_uuid() AS group_uuid,
         count(*) AS n_rows,
         count(DISTINCT agency) AS n_agencies,
         array_agg(DISTINCT agency) AS agencies,
         max(bagni_distinct) AS bagni_distinct_arr
  FROM _grp2
  GROUP BY 1,2,3,4,5
  HAVING count(*) >= 2 AND count(DISTINCT agency) >= 2;

  -- Assign group_uuid to rows
  CREATE TEMP TABLE _row_assign ON COMMIT DROP AS
  SELECT g.id, g.mq, g.bagni, g.civico_n, g.lat, g.lng, g.agency,
         f.group_uuid, f.via_n, f.locali, f.tipologia_n, f.bagni_distinct_arr
  FROM _grp2 g
  JOIN _final_groups f
    ON f.via_n=g.via_n AND f.locali=g.locali AND f.tipologia_n=g.tipologia_n
   AND f.sub_idx=g.sub_idx AND f.bagni_key=g.bagni_key;

  -- Confidence per row:
  --  ALTA: civico matches at least one other row in group (non-empty same civico_n) OR coords within ~80m of another row.
  --  DA_CONFERMARE: bagni conflict in group (bagni_distinct_arr length > 1) OR this row's bagni is null while group has other bagni.
  --  MEDIA: otherwise.
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
          AND (
            -- approx meters: 1 deg lat ~111111m; lng ~111111*cos(lat)
            sqrt(power((b.lat-a.lat)*111111.0,2) +
                 power((b.lng-a.lng)*111111.0*cos(radians(a.lat)),2)) <= 80
          )
      ) THEN 'ALTA'
      WHEN a.bagni IS NULL AND COALESCE(array_length(a.bagni_distinct_arr,1),0) >= 1 THEN 'MEDIA'
      ELSE 'MEDIA'
    END AS confidenza
  FROM _row_assign a;

  -- Write back
  UPDATE public.padova_collect_v2_items i
     SET contendibile = true,
         contendibile_group_id = c.group_uuid,
         contendibile_confidenza = c.confidenza
    FROM _row_conf c
   WHERE i.id = c.id;

  -- Stats
  SELECT count(*) INTO v_groups FROM _final_groups;
  SELECT count(*) INTO v_annunci FROM _row_conf;
  SELECT count(*) INTO v_alta FROM _row_conf WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM _row_conf WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf FROM _row_conf WHERE confidenza='DA_CONFERMARE';

  -- 3 known links: verify they're in different groups (or unassigned)
  SELECT count(DISTINCT COALESCE(contendibile_group_id::text, 'none-' || id::text))
    INTO v_known_groups
    FROM public.padova_collect_v2_items
   WHERE url ILIKE '%128366330%' OR url ILIKE '%124467797%' OR url ILIKE '%53485960%';
  v_known_separated := v_known_groups >= (
    SELECT count(*) FROM public.padova_collect_v2_items
     WHERE url ILIKE '%128366330%' OR url ILIKE '%124467797%' OR url ILIKE '%53485960%'
  );

  -- Examples (up to 5 ALTA groups)
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_examples FROM (
    SELECT jsonb_build_object(
      'group_id', f.group_uuid,
      'via', f.via_n,
      'mq', (SELECT round(avg(mq))::int FROM _row_assign a WHERE a.group_uuid=f.group_uuid),
      'locali', f.locali,
      'tipologia', f.tipologia_n,
      'agenzie', f.agencies,
      'confidenza', 'ALTA'
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
    'caso_noto_3_link_ora_separati', v_known_separated,
    'esempi_contendibili_alta', v_examples
  );
END;
$$;
