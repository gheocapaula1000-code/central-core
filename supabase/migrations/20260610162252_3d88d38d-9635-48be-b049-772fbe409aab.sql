
DROP TABLE IF EXISTS public.padova_contendibili;
CREATE TABLE public.padova_contendibili (
  id bigserial PRIMARY KEY,
  chiave_match text NOT NULL,
  n_agenzie int NOT NULL,
  agenzie text[] NOT NULL,
  fonti text[] NOT NULL,
  confidenza text NOT NULL,
  prezzo_min int,
  prezzo_max int,
  mq int,
  locali int,
  bagni int,
  quartiere text,
  lat double precision,
  lng double precision,
  urls text[] NOT NULL,
  n_annunci int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_contendibili TO service_role;
GRANT SELECT ON public.padova_contendibili TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.padova_contendibili_id_seq TO service_role;
ALTER TABLE public.padova_contendibili ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read padova_contendibili" ON public.padova_contendibili
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX idx_padova_contendibili_n_agenzie ON public.padova_contendibili(n_agenzie DESC);
CREATE INDEX idx_padova_contendibili_quartiere ON public.padova_contendibili(quartiere);

CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefilter int;
  v_total int;
  v_alta int; v_media int; v_conf int;
  v_3plus int;
  v_quartieri int;
BEGIN
  TRUNCATE TABLE public.padova_contendibili RESTART IDENTITY;

  -- 1) candidates
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT
    p.id, p.url, p.fonte, p.mq, p.locali, p.bagni, p.prezzo,
    p.lat, p.lng, p.quartiere, p.indirizzo,
    lower(trim(p.agency)) AS agency_n,
    public.norm_via(p.indirizzo) AS via_n,
    -- estrai civico dall'indirizzo: numero finale opzionale
    regexp_replace(lower(coalesce(substring(p.indirizzo from '([0-9]+[a-zA-Z]?)\s*$'), '')), '[^a-z0-9]+', '', 'g') AS civico_n
  FROM public.padova_listings p
  WHERE p.mq IS NOT NULL
    AND p.locali IS NOT NULL
    AND p.agency IS NOT NULL
    AND p.agency <> 'Agenzie'
    AND p.indirizzo IS NOT NULL
    AND public.norm_via(p.indirizzo) NOT IN ('','na');

  SELECT count(*) INTO v_prefilter FROM _cand;

  -- 2) mq-sweep within (via_n, locali)
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
  SELECT via_n, locali, sub_idx, id, url, fonte, agency_n, mq, bagni, prezzo, lat, lng, quartiere, indirizzo, civico_n
  FROM numbered;

  -- 3) split per bagni
  CREATE TEMP TABLE _grp2 ON COMMIT DROP AS
  WITH base AS (
    SELECT *, (SELECT array_agg(DISTINCT b2.bagni ORDER BY b2.bagni)
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
    id, url, fonte, agency_n, mq, bagni, prezzo, lat, lng, quartiere, indirizzo, civico_n,
    bagni_distinct
  FROM base;

  -- 4) final clusters: ≥2 agency distinct
  CREATE TEMP TABLE _fg ON COMMIT DROP AS
  SELECT via_n, locali, sub_idx, bagni_key,
    via_n || '|' || locali::text || '|' || sub_idx::text || '|' || bagni_key AS chiave_match,
    count(*) AS n_rows,
    count(DISTINCT agency_n) AS n_agenzie,
    array_agg(DISTINCT agency_n ORDER BY agency_n) AS agenzie,
    array_agg(DISTINCT fonte ORDER BY fonte) AS fonti,
    min(prezzo) AS prezzo_min,
    max(prezzo) AS prezzo_max,
    round(avg(mq))::int AS mq_avg,
    array_agg(url) AS urls,
    (array_agg(quartiere) FILTER (WHERE quartiere IS NOT NULL))[1] AS quartiere,
    avg(lat) FILTER (WHERE lat IS NOT NULL) AS lat,
    avg(lng) FILTER (WHERE lng IS NOT NULL) AS lng,
    max(bagni_distinct) AS bagni_distinct_arr,
    (array_agg(bagni) FILTER (WHERE bagni IS NOT NULL))[1] AS bagni_pick
  FROM _grp2
  GROUP BY 1,2,3,4
  HAVING count(DISTINCT agency_n) >= 2;

  -- 5) confidence per cluster (rolled-up from rows)
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
    'quartieri_coinvolti', v_quartieri
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_padova_listings_contendibili() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_padova_listings_contendibili() TO service_role;
