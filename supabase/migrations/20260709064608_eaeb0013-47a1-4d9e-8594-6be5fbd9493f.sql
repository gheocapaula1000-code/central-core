
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
BEGIN
  TRUNCATE TABLE public.padova_contendibili RESTART IDENTITY;

  -- Base pool with same pre-filters as before, augmented with quality flags.
  CREATE TEMP TABLE _base ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    p.lat, p.lng, p.quartiere, p.indirizzo,
    p.agency,
    -- Titolo originale dell'annuncio con fallback per fonte.
    -- casa/immobiliare: raw_json->>'title'
    -- idealista:       raw_json->'suggestedTexts'->>'title'
    -- subito:          raw_json->>'subject'
    NULLIF(trim(COALESCE(
      p.raw_json->>'title',
      p.raw_json->'suggestedTexts'->>'title',
      p.raw_json->>'subject'
    )), '') AS titolo_ann,
    -- Stato coordinate: 'null' (entrambe NULL, passano), 'ok' (valide), 'bad' (da sanificare).
    CASE
      WHEN p.lat IS NULL AND p.lng IS NULL THEN 'null'
      WHEN p.lat IS NOT NULL AND p.lng IS NOT NULL
           AND p.lat = p.lat AND p.lng = p.lng            -- finite (esclude NaN)
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
    AND public.norm_via(p.indirizzo) NOT IN ('','na');

  -- GUARDIA TITOLO: escludi righe senza titolo o con titolo non riconducibile a un immobile.
  -- Conteggio: quante righe del pool base vengono escluse.
  SELECT count(*) INTO v_excluded_bad_title
  FROM _base
  WHERE titolo_ann IS NULL
     OR lower(titolo_ann) !~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio)';

  -- Pool post-guardia titolo.
  CREATE TEMP TABLE _base_ok ON COMMIT DROP AS
  SELECT * FROM _base
  WHERE titolo_ann IS NOT NULL
    AND lower(titolo_ann) ~ '(appartament|casa|villa|villetta|attico|mansarda|loft|monolocale|bilocale|trilocale|quadrilocale|plurilocale|room|flat|rustico|porzione|terreno|ufficio|negozio)';

  -- GUARDIA COORDINATE (sanifica, non esclude): contata sugli annunci che partecipano.
  SELECT count(*) INTO v_sanitized_bad_coords
  FROM _base_ok WHERE coord_state = 'bad';

  -- _cand invariato per struttura; lat/lng sanificati (bad -> NULL); esclude titoli non validi.
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
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

  ALTER TABLE _cand ADD COLUMN agency_key text;
  UPDATE _cand
     SET agency_key = CASE WHEN coalesce(agency_core,'') <> '' THEN agency_core ELSE agency_n_full END
   WHERE true;

  SELECT count(*) INTO v_prefilter FROM _cand;

  CREATE TEMP TABLE _grp ON COMMIT DROP AS
  WITH sorted AS (
    SELECT *, LAG(mq) OVER (PARTITION BY via_n, locali ORDER BY mq, id) AS mq_prev FROM _cand
  ),
  flagged AS (
    SELECT *, CASE WHEN mq_prev IS NULL OR mq::numeric > mq_prev::numeric * 1.05 THEN 1 ELSE 0 END AS new_grp FROM sorted
  ),
  numbered AS (
    SELECT *, SUM(new_grp) OVER (PARTITION BY via_n, locali ORDER BY mq, id) AS sub_idx FROM flagged
  )
  SELECT via_n, locali, sub_idx, id, url, fonte, agency_raw, agency_key, mq, bagni, prezzo, lat, lng, quartiere, indirizzo, civico_n
  FROM numbered;

  CREATE TEMP TABLE _grp2 ON COMMIT DROP AS
  WITH base AS (
    SELECT g.*, (SELECT array_agg(DISTINCT b2.bagni ORDER BY b2.bagni)
                 FROM _grp b2
                WHERE b2.via_n=g.via_n AND b2.locali=g.locali AND b2.sub_idx=g.sub_idx AND b2.bagni IS NOT NULL) AS bagni_distinct
    FROM _grp g
  )
  SELECT via_n, locali, sub_idx,
    CASE
      WHEN bagni IS NOT NULL THEN bagni::text
      WHEN bagni_distinct IS NULL OR array_length(bagni_distinct,1) IS NULL THEN 'X'
      ELSE bagni_distinct[1]::text
    END AS bagni_key,
    id, url, fonte, agency_raw, agency_key, mq, bagni, prezzo, lat, lng, quartiere, indirizzo, civico_n,
    bagni_distinct
  FROM base;

  CREATE TEMP TABLE _agency_display ON COMMIT DROP AS
  SELECT via_n, locali, sub_idx, bagni_key, agency_key,
         (array_agg(agency_raw ORDER BY id))[1] AS display
  FROM _grp2
  GROUP BY 1,2,3,4,5;

  CREATE TEMP TABLE _fg ON COMMIT DROP AS
  SELECT g.via_n, g.locali, g.sub_idx, g.bagni_key,
    g.via_n || '|' || g.locali::text || '|' || g.sub_idx::text || '|' || g.bagni_key AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT g.agency_key) AS n_agenzie,
    (SELECT array_agg(display ORDER BY display)
       FROM _agency_display d
      WHERE d.via_n=g.via_n AND d.locali=g.locali AND d.sub_idx=g.sub_idx AND d.bagni_key=g.bagni_key) AS agenzie,
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
  GROUP BY 1,2,3,4
  HAVING count(DISTINCT g.agency_key) >= 2;

  CREATE TEMP TABLE _conf ON COMMIT DROP AS
  SELECT f.chiave_match,
    CASE
      WHEN COALESCE(array_length(f.bagni_distinct_arr,1),0) > 1 THEN 'DA_CONFERMARE'
      WHEN EXISTS (
        SELECT 1 FROM _grp2 a JOIN _grp2 b
          ON a.via_n=b.via_n AND a.locali=b.locali AND a.sub_idx=b.sub_idx AND a.bagni_key=b.bagni_key
         AND a.id < b.id
        WHERE a.via_n=f.via_n AND a.locali=f.locali AND a.sub_idx=f.sub_idx AND a.bagni_key=f.bagni_key
          AND a.civico_n <> '' AND a.civico_n = b.civico_n
      ) THEN 'ALTA'
      WHEN EXISTS (
        SELECT 1 FROM _grp2 a JOIN _grp2 b
          ON a.via_n=b.via_n AND a.locali=b.locali AND a.sub_idx=b.sub_idx AND a.bagni_key=b.bagni_key
         AND a.id < b.id
        WHERE a.via_n=f.via_n AND a.locali=f.locali AND a.sub_idx=f.sub_idx AND a.bagni_key=f.bagni_key
          AND a.lat IS NOT NULL AND a.lng IS NOT NULL AND b.lat IS NOT NULL AND b.lng IS NOT NULL
          AND sqrt(power((b.lat-a.lat)*111111.0,2) + power((b.lng-a.lng)*111111.0*cos(radians(a.lat)),2)) <= 80
      ) THEN 'ALTA'
      ELSE 'MEDIA'
    END AS confidenza
  FROM _fg f;

  INSERT INTO public.padova_contendibili
    (chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, n_annunci)
  SELECT f.chiave_match, f.n_agenzie, f.agenzie, f.fonti, c.confidenza,
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
    'excluded_bad_title', v_excluded_bad_title
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
  v_r1 jsonb;
  v_r2 jsonb;
BEGIN
  v_r1 := public.recompute_padova_listings_contendibili();
  v_r2 := public.recompute_padova_contendibili_extras();
  RETURN jsonb_build_object(
    'ok', true,
    'clustering', v_r1,
    'extras', v_r2,
    'sanitized_bad_coords', COALESCE((v_r1->>'sanitized_bad_coords')::int, 0),
    'excluded_bad_title',   COALESCE((v_r1->>'excluded_bad_title')::int, 0)
  );
END;
$function$;
