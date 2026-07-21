-- 20260721060000_padova_contendibili_geo_identity.sql
--
-- Purpose (CAUSE-FIX geografico, sostituisce la griglia ~40 m):
--   L'identity gate 20260721050000 quantizzava le coordinate in celle
--   ~40 m. Questo introduceva due difetti opposti:
--     (a) due annunci a 10 m che cadono a cavallo del bordo della cella
--         venivano classificati come immobili diversi (falso negativo);
--     (b) più annunci in celle adiacenti potevano collassare in
--         "identity" instabili al variare della cella (rumore).
--
--   La nuova regola usa distanza geodetica reale:
--     • Se il civico è presente su entrambi gli annunci di un potenziale
--       gruppo → identità determinata dal civico (compatibile con via,
--       mq, locali, bagni già presenti nella pipeline). NON viene mai
--       fatto merge con annunci senza civico (fail-closed).
--     • Senza civico → servono coordinate valide. Le coordinate assenti
--       o fuori bounding box Padova → identità NULL → riga esclusa dalla
--       tabella contendibili (fail-closed, invariante rispetto alla
--       migration precedente).
--     • Annunci senza civico nella stessa (via_n, locali) vengono
--       raggruppati solo se ogni coppia del cluster ha distanza ≤ 50 m
--       (COMPLETE-LINKAGE, non single-linkage): questo impedisce
--       chaining transitivo A—B (40 m), B—C (40 m), A—C (80 m).
--     • Coppie a > 50 m → immobili distinti.
--
-- Interfaccia:
--   • Schema di `padova_contendibili` invariato.
--   • View server-only `padova_contendibili_by_zone_v` invariata
--     (filtro MLS + soglia prezzo 8% restano attivi in cascata).
--   • Isolamento zona (resolver quartiere-only) invariato.
--   • ACL invariati.
--   • Dati sorgenti (`padova_listings`) mai mutati.
--
-- Include DO block di test in-transaction sulla clustering function.
-- Idempotente.

BEGIN;

-- 1) Helper: distanza haversine in metri. -------------------------------
CREATE OR REPLACE FUNCTION public.padova_haversine_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public
AS $$
  SELECT 2 * 6371000.0 * asin(sqrt(
    power(sin(radians((lat2 - lat1) / 2.0)), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
      * power(sin(radians((lng2 - lng1) / 2.0)), 2)
  ))
$$;

REVOKE ALL ON FUNCTION public.padova_haversine_m(double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_haversine_m(double precision, double precision, double precision, double precision) TO service_role;

-- 2) Helper: cluster complete-linkage ≤ 50 m ---------------------------
--    Restituisce un array int[] parallelo ai due array di input in cui
--    la posizione i contiene il numero di cluster (1..k) del punto i.
--    Un punto entra in un cluster esistente solo se dista ≤ 50 m da
--    TUTTI i membri di quel cluster; altrimenti apre un nuovo cluster.
CREATE OR REPLACE FUNCTION public.padova_cluster_points_50m(
  p_lats double precision[], p_lngs double precision[]
) RETURNS int[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  n int := coalesce(array_length(p_lats, 1), 0);
  result int[];
  next_cluster int := 0;
  i int; j int; c int;
  best int; ok boolean;
  d double precision;
BEGIN
  IF n = 0 THEN
    RETURN ARRAY[]::int[];
  END IF;
  result := array_fill(0, ARRAY[n]);
  FOR i IN 1..n LOOP
    -- Coordinate non valide: cluster negativo dedicato (esclusione a valle).
    IF p_lats[i] IS NULL OR p_lngs[i] IS NULL THEN
      result[i] := -1;
      CONTINUE;
    END IF;
    best := 0;
    FOR c IN 1..next_cluster LOOP
      ok := true;
      FOR j IN 1..(i - 1) LOOP
        IF result[j] = c THEN
          d := public.padova_haversine_m(p_lats[i], p_lngs[i], p_lats[j], p_lngs[j]);
          IF d > 50.0 THEN
            ok := false;
            EXIT;
          END IF;
        END IF;
      END LOOP;
      IF ok THEN
        best := c;
        EXIT;
      END IF;
    END LOOP;
    IF best = 0 THEN
      next_cluster := next_cluster + 1;
      result[i] := next_cluster;
    ELSE
      result[i] := best;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.padova_cluster_points_50m(double precision[], double precision[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.padova_cluster_points_50m(double precision[], double precision[]) TO service_role;

COMMENT ON FUNCTION public.padova_cluster_points_50m(double precision[], double precision[]) IS
  'Cluster complete-linkage ≤ 50 m su liste parallele lat/lng. Nessun chaining transitivo. NULL coords → cluster -1 (fail-closed a valle).';

-- 3) Recompute con identità geografica reale. --------------------------
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

  -- Candidati arricchiti con civico normalizzato e coord validate.
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

  -- Identity gate GEOGRAFICO: civico OR cluster complete-linkage 50 m.
  CREATE TEMP TABLE _identity ON COMMIT DROP AS
  WITH civic_listings AS (
    SELECT id, 'C:' || civico_n AS identity_key
    FROM _cand_all
    WHERE coalesce(civico_n, '') <> ''
  ),
  no_civic_partitions AS (
    SELECT via_n, locali,
      array_agg(id ORDER BY id) AS ids,
      array_agg(lat ORDER BY id) AS lats,
      array_agg(lng ORDER BY id) AS lngs
    FROM _cand_all
    WHERE coalesce(civico_n, '') = ''
      AND lat IS NOT NULL AND lng IS NOT NULL
    GROUP BY via_n, locali
  ),
  no_civic_with_clusters AS (
    SELECT via_n, locali, ids, public.padova_cluster_points_50m(lats, lngs) AS clusters
    FROM no_civic_partitions
  ),
  no_civic_expanded AS (
    SELECT p.ids[i] AS id,
      'G:' || p.via_n || ':' || p.locali::text || ':' || p.clusters[i]::text AS identity_key
    FROM no_civic_with_clusters p,
      LATERAL generate_series(1, array_length(p.ids, 1)) AS i
    WHERE p.clusters[i] > 0
  )
  SELECT id, identity_key FROM civic_listings
  UNION ALL
  SELECT id, identity_key FROM no_civic_expanded;

  -- Join: righe senza identity_key → escluse (fail-closed).
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

  -- sub_idx (bucketing mq) partizionato anche per identity_key.
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
          AND public.padova_haversine_m(a.lat, a.lng, b.lat, b.lng) <= 40
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

-- 4) Test in-transaction sul clustering complete-linkage 50 m. ---------
DO $test$
DECLARE
  r int[];
  d double precision;
BEGIN
  -- T1: due punti a ~10 m ma a cavallo del vecchio bordo di griglia (1/2500 deg).
  --     Old grid: round(45.399980*2500)=113500, round(45.400060*2500)=113502 → celle diverse.
  --     Nuova regola: distanza ~8.9 m ⇒ stesso cluster.
  d := public.padova_haversine_m(45.399980, 11.9, 45.400060, 11.9);
  IF d > 50.0 THEN RAISE EXCEPTION 'T1 setup: distanza attesa <50m, ottenuta % m', d; END IF;
  r := public.padova_cluster_points_50m(
    ARRAY[45.399980, 45.400060]::float8[],
    ARRAY[11.9, 11.9]::float8[]
  );
  IF r[1] <> r[2] THEN
    RAISE EXCEPTION 'FAIL T1: 10 m attraverso vecchio bordo dovrebbero unirsi (r=%)', r;
  END IF;

  -- T2: due punti a ~50 m ⇒ compatibili (stesso cluster).
  d := public.padova_haversine_m(45.400000, 11.9, 45.400449, 11.9);
  IF d > 50.5 OR d < 49.5 THEN
    RAISE EXCEPTION 'T2 setup: distanza attesa ~50m, ottenuta % m', d;
  END IF;
  r := public.padova_cluster_points_50m(
    ARRAY[45.400000, 45.400449]::float8[],
    ARRAY[11.9, 11.9]::float8[]
  );
  IF r[1] <> r[2] THEN
    RAISE EXCEPTION 'FAIL T2: 50 m dovrebbero unirsi (r=%)', r;
  END IF;

  -- T3: due punti a ~51 m ⇒ distinti.
  d := public.padova_haversine_m(45.400000, 11.9, 45.400460, 11.9);
  IF d <= 50.0 THEN
    RAISE EXCEPTION 'T3 setup: distanza attesa >50m, ottenuta % m', d;
  END IF;
  r := public.padova_cluster_points_50m(
    ARRAY[45.400000, 45.400460]::float8[],
    ARRAY[11.9, 11.9]::float8[]
  );
  IF r[1] = r[2] THEN
    RAISE EXCEPTION 'FAIL T3: 51 m dovrebbero restare distinti (r=%)', r;
  END IF;

  -- T4: Fusinato vs Savonarola (~150 m) ⇒ distinti.
  d := public.padova_haversine_m(45.4139315, 11.8685579, 45.4151999, 11.8675444);
  IF d < 100.0 THEN
    RAISE EXCEPTION 'T4 setup: distanza attesa >100m, ottenuta % m', d;
  END IF;
  r := public.padova_cluster_points_50m(
    ARRAY[45.4139315, 45.4151999]::float8[],
    ARRAY[11.8685579, 11.8675444]::float8[]
  );
  IF r[1] = r[2] THEN
    RAISE EXCEPTION 'FAIL T4: Fusinato/Savonarola dovrebbero restare distinti (r=%)', r;
  END IF;

  -- T5: no chaining transitivo. p1—p2 40 m, p2—p3 40 m, p1—p3 80 m ⇒ [1,1,2].
  r := public.padova_cluster_points_50m(
    ARRAY[45.4, 45.4, 45.4]::float8[],
    ARRAY[11.9, 11.9005119, 11.9010238]::float8[]
  );
  IF r[1] <> 1 OR r[2] <> 1 OR r[3] <> 2 THEN
    RAISE EXCEPTION 'FAIL T5: chaining transitivo evitato: atteso [1,1,2], ottenuto %', r;
  END IF;

  -- T6: NULL coord ⇒ cluster -1 (esclusione a valle).
  r := public.padova_cluster_points_50m(
    ARRAY[NULL, 45.4]::float8[],
    ARRAY[NULL, 11.9]::float8[]
  );
  IF r[1] <> -1 THEN
    RAISE EXCEPTION 'FAIL T6: NULL coord dovrebbe dare cluster -1 (r=%)', r;
  END IF;

  RAISE NOTICE 'padova_cluster_points_50m tests OK';
END
$test$;

COMMIT;
