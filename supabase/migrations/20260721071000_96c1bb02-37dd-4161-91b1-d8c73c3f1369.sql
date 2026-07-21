BEGIN;

CREATE OR REPLACE FUNCTION public.padova_listing_identity_key(
  p_civ    text,
  p_lat    double precision,
  p_lng    double precision
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN coalesce(p_civ,'') <> '' THEN 'C:' || p_civ
    WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL
         AND p_lat = p_lat AND p_lng = p_lng
         AND p_lat BETWEEN 45.30 AND 45.50
         AND p_lng BETWEEN 11.75 AND 12.00
      THEN 'G:' || round(p_lat * 2500)::text || ':' || round(p_lng * 2500)::text
    ELSE NULL
  END
$$;

REVOKE ALL ON FUNCTION public.padova_listing_identity_key(text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_listing_identity_key(text, double precision, double precision) TO service_role;

COMMENT ON FUNCTION public.padova_listing_identity_key(text, double precision, double precision) IS
  'Identity key per un annuncio Padova: civico se presente, altrimenti cella ~40 m su griglia lat/lng, altrimenti NULL (fail-closed).';

CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefilter int;
  v_total int;
  v_alta int; v_media int; v_conf int;
  v_3plus int;
  v_quartieri int;
  v_sanitized_bad_coords int := 0;
  v_excluded_bad_title int := 0;
  v_excluded_no_identity int := 0;
BEGIN
  TRUNCATE TABLE public.padova_contendibili RESTART IDENTITY;

  CREATE TEMP TABLE _base ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    p.lat, p.lng, p.quartiere, p.indirizzo,
    p.agency,
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
    END AS coord_state
  FROM public.padova_listings p
  WHERE p.mq IS NOT NULL
    AND p.locali IS NOT NULL
    AND p.agency IS NOT NULL
    AND p.agency <> 'Agenzie'
    AND p.indirizzo IS NOT NULL
    AND public.norm_via(p.indirizzo) NOT IN ('','na')
    AND p.expired_at IS NULL;

  SELECT count(*) INTO v_excluded_bad_title
  FROM _base
  WHERE titolo_ann IS NULL
     OR lower(titolo_ann) !~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)';

  CREATE TEMP TABLE _base_ok ON COMMIT DROP AS
  SELECT * FROM _base
  WHERE titolo_ann IS NOT NULL
    AND lower(titolo_ann) ~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio|house|apartment|duplex|penthouse|villino|familiare)';

  SELECT count(*) INTO v_sanitized_bad_coords
  FROM _base_ok WHERE coord_state = 'bad';

  CREATE TEMP TABLE _cand_all ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    CASE WHEN p.coord_state = 'ok' THEN p.lat ELSE NULL END AS lat,
    CASE WHEN p.coord_state = 'ok' THEN p.lng ELSE NULL END AS lng,
    p.quartiere, p.indirizzo,
    p.agency AS agency_raw,
    public.norm_agency(
      regexp_replace(lower(trim(p.agency)), '^(agenzia immobiliare|immobiliare)\s+', '', 'g')
    ) AS agency_core,
    public.norm_agency(p.agency) AS agency_n_full,
    public.norm_via(p.indirizzo) AS via_n,
    regexp_replace(lower(coalesce(substring(p.indirizzo from '([0-9]+[a-zA-Z]?)\s*$'), '')), '[^a-z0-9]+', '', 'g') AS civico_n
  FROM _base_ok p;

  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT c.*,
    public.padova_listing_identity_key(c.civico_n, c.lat, c.lng) AS identity_key
  FROM _cand_all c
  WHERE public.padova_listing_identity_key(c.civico_n, c.lat, c.lng) IS NOT NULL;

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
  SELECT via_n, locali, identity_key, sub_idx, id, url, fonte, agency_raw, agency_key,
         mq, bagni, prezzo, lat, lng, quartiere, indirizzo, civico_n
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
  SELECT via_n, locali, identity_key, sub_idx,
    CASE
      WHEN bagni IS NOT NULL THEN bagni::text
      WHEN bagni_distinct IS NULL OR array_length(bagni_distinct,1) IS NULL THEN 'X'
      ELSE bagni_distinct[1]::text
    END AS bagni_key,
    id, url, fonte, agency_raw, agency_key, mq, bagni, prezzo, lat, lng, quartiere, indirizzo, civico_n,
    bagni_distinct
  FROM base;

  CREATE TEMP TABLE _agency_display ON COMMIT DROP AS
  SELECT via_n, locali, identity_key, sub_idx, bagni_key, agency_key,
         (array_agg(agency_raw ORDER BY id))[1] AS display
  FROM _grp2
  GROUP BY 1,2,3,4,5,6;

  CREATE TEMP TABLE _fg ON COMMIT DROP AS
  SELECT g.via_n, g.locali, g.identity_key, g.sub_idx, g.bagni_key,
    g.via_n || '|' || g.locali::text || '|' || g.sub_idx::text || '|' || g.bagni_key
      || '|' || g.identity_key AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT g.agency_key) AS n_agenzie,
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
    (array_agg(g.bagni) FILTER (WHERE g.bagni IS NOT NULL))[1] AS bagni_pick
  FROM _grp2 g
  GROUP BY 1,2,3,4,5
  HAVING count(DISTINCT g.agency_key) >= 2;

  CREATE TEMP TABLE _conf ON COMMIT DROP AS
  SELECT f.chiave_match,
    CASE
      WHEN COALESCE(array_length(f.bagni_distinct_arr,1),0) > 1 THEN 'DA_CONFERMARE'
      WHEN f.identity_key LIKE 'C:%' THEN 'ALTA'
      WHEN EXISTS (
        SELECT 1 FROM _grp2 a JOIN _grp2 b
          ON a.via_n=b.via_n AND a.locali=b.locali AND a.identity_key=b.identity_key
         AND a.sub_idx=b.sub_idx AND a.bagni_key=b.bagni_key
         AND a.id < b.id
        WHERE a.via_n=f.via_n AND a.locali=f.locali AND a.identity_key=f.identity_key
          AND a.sub_idx=f.sub_idx AND a.bagni_key=f.bagni_key
          AND a.lat IS NOT NULL AND a.lng IS NOT NULL AND b.lat IS NOT NULL AND b.lng IS NOT NULL
          AND sqrt(power((b.lat-a.lat)*111111.0,2) + power((b.lng-a.lng)*111111.0*cos(radians(a.lat)),2)) <= 40
      ) THEN 'ALTA'
      ELSE 'MEDIA'
    END AS confidenza
  FROM _fg f;

  INSERT INTO public.padova_contendibili
    (chiave_match, n_agenzie, agenzie, agencies_normalized, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, n_annunci)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie,
         ARRAY(SELECT DISTINCT public.norm_agency(a) FROM unnest(f.agenzie) AS a WHERE a IS NOT NULL AND btrim(a) <> ''),
         f.fonti, c.confidenza,
         f.prezzo_min, f.prezzo_max, f.mq_avg, f.locali, f.bagni_pick, f.quartiere, f.lat, f.lng, f.urls, f.n_rows
  FROM _fg f JOIN _conf c USING (chiave_match);

  SELECT count(*) INTO v_total FROM public.padova_contendibili;
  SELECT count(*) INTO v_alta  FROM public.padova_contendibili WHERE confidenza='ALTA';
  SELECT count(*) INTO v_media FROM public.padova_contendibili WHERE confidenza='MEDIA';
  SELECT count(*) INTO v_conf  FROM public.padova_contendibili WHERE confidenza='DA_CONFERMARE';
  SELECT count(*) INTO v_3plus FROM public.padova_contendibili WHERE n_agenzie >= 3;
  SELECT count(DISTINCT quartiere) INTO v_quartieri FROM public.padova_contendibili WHERE quartiere IS NOT NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'prefilter_rows', v_prefilter,
    'immobili_contendibili', v_total,
    'per_confidenza', jsonb_build_object('ALTA', v_alta, 'MEDIA', v_media, 'DA_CONFERMARE', v_conf),
    'con_3_piu_agenzie', v_3plus,
    'quartieri_coinvolti', v_quartieri,
    'sanitized_bad_coords', v_sanitized_bad_coords,
    'excluded_bad_title', v_excluded_bad_title,
    'excluded_no_identity', v_excluded_no_identity
  );
END;
$function$;

DO $test$
DECLARE
  k_fus_a text; k_sav_a text;
  k_civ_5 text; k_civ_12 text;
  k_same_a text; k_same_b text;
  k_ambig text;
BEGIN
  k_fus_a := public.padova_listing_identity_key('', 45.4139315, 11.8685579);
  k_sav_a := public.padova_listing_identity_key('', 45.4151999, 11.8675444);
  IF k_fus_a IS NULL OR k_sav_a IS NULL THEN
    RAISE EXCEPTION 'identity_key nullo su coord valide';
  END IF;
  IF k_fus_a = k_sav_a THEN
    RAISE EXCEPTION 'FAIL test 1: due indirizzi distanti nella stessa cella';
  END IF;

  k_civ_5  := public.padova_listing_identity_key('5',  45.4140, 11.8680);
  k_civ_12 := public.padova_listing_identity_key('12', 45.4140, 11.8680);
  IF k_civ_5 = k_civ_12 THEN
    RAISE EXCEPTION 'FAIL test 2: civici diversi con stessa identity_key';
  END IF;
  IF k_civ_5 NOT LIKE 'C:%' OR k_civ_12 NOT LIKE 'C:%' THEN
    RAISE EXCEPTION 'FAIL test 2: civico non usato come identity';
  END IF;

  k_same_a := public.padova_listing_identity_key('10', 45.4100, 11.8700);
  k_same_b := public.padova_listing_identity_key('10', 45.4102, 11.8702);
  IF k_same_a <> k_same_b THEN
    RAISE EXCEPTION 'FAIL test 3: stesso civico produce identity diverse';
  END IF;

  k_ambig := public.padova_listing_identity_key(NULL, NULL, NULL);
  IF k_ambig IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL test 4: indirizzo ambiguo non escluso';
  END IF;
  k_ambig := public.padova_listing_identity_key('', NULL, NULL);
  IF k_ambig IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL test 4b: civico vuoto senza coord non escluso';
  END IF;

  RAISE NOTICE 'identity_key tests OK';
END
$test$;

COMMIT;