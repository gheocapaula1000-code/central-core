
-- =========================================================
-- AGENCY PIPELINE INFRASTRUCTURE
-- =========================================================

-- 1) Estendi padova_listings con i campi richiesti
ALTER TABLE public.padova_listings
  ADD COLUMN IF NOT EXISTS published_at_portal timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

CREATE INDEX IF NOT EXISTS padova_listings_last_seen_idx
  ON public.padova_listings(last_seen_at);
CREATE INDEX IF NOT EXISTS padova_listings_expired_idx
  ON public.padova_listings(expired_at);

-- 2) pipeline_runs — tracciamento per ogni cron agenzie
CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id              bigserial PRIMARY KEY,
  pipeline_name   text NOT NULL,                                  -- 'padova-agencies'
  mode            text NOT NULL,                                  -- 'soft' | 'full'
  trigger_source  text NOT NULL DEFAULT 'cron',                   -- cron | manual
  status          text NOT NULL DEFAULT 'running',                -- running|done|failed|skipped_budget
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     integer,
  apify_run_ids   text[]   NOT NULL DEFAULT '{}',
  sources         text[]   NOT NULL DEFAULT '{}',                 -- ['idealista','casa','immobiliare']
  cost_usd        numeric  NOT NULL DEFAULT 0,
  monthly_spent_usd_at_start numeric,
  monthly_cap_usd numeric,
  per_source_stats jsonb   NOT NULL DEFAULT '{}'::jsonb,
  -- chiavi per fonte: { idealista:{new,updated,unchanged,expired,cost_usd}, casa:{...}, immobiliare:{...} }
  warnings        text[]   NOT NULL DEFAULT '{}',
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pipeline_runs TO authenticated;
GRANT ALL    ON public.pipeline_runs TO service_role;

ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pipeline_runs admin read"
  ON public.pipeline_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS pipeline_runs_started_idx
  ON public.pipeline_runs(pipeline_name, started_at DESC);

-- 3) Budget cap mensile (USD; default ~200 EUR a 1.075)
CREATE OR REPLACE FUNCTION public.agency_pipeline_monthly_spent_usd()
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(SUM(cost_usd), 0)::numeric
    FROM public.pipeline_runs
   WHERE pipeline_name = 'padova-agencies'
     AND started_at >= date_trunc('month', now());
$$;

CREATE OR REPLACE FUNCTION public.agency_pipeline_budget_check(p_cap_usd numeric DEFAULT 215)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'spent_usd', public.agency_pipeline_monthly_spent_usd(),
    'cap_usd',   p_cap_usd,
    'cap_eur_approx', round(p_cap_usd / 1.075, 0),
    'ok', public.agency_pipeline_monthly_spent_usd() < p_cap_usd,
    'remaining_usd', p_cap_usd - public.agency_pipeline_monthly_spent_usd()
  );
$$;

-- 4) Promoter staging → padova_listings (idealista + casa)
-- Idealista: usa raw_json.modificationDate.value come published_at_portal proxy.
-- Casa.it:    published_at_portal non disponibile, resta NULL.
CREATE OR REPLACE FUNCTION public.promote_padova_agencies_listings(p_since timestamptz DEFAULT (now() - interval '6 hours'))
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ideal_new int := 0; v_ideal_upd int := 0;
  v_casa_new  int := 0; v_casa_upd  int := 0;
  v_now timestamptz := now();
BEGIN
  -- IDEALISTA: upsert da staging
  WITH src AS (
    SELECT DISTINCT ON (url)
      url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo, raw_json, fetched_at
    FROM public.padova_idealista_staging
    WHERE fetched_at >= p_since AND url IS NOT NULL
    ORDER BY url, fetched_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo,
       raw_json, published_at_portal, imported_at, last_seen_at)
    SELECT
      'idealista', s.url, s.agency, s.tipo_lead, s.mq, s.locali, s.bagni, s.prezzo,
      s.lat, s.lng, s.indirizzo, s.raw_json,
      CASE
        WHEN s.raw_json->'modificationDate'->>'value' ~ '^[0-9]+$'
        THEN to_timestamp((s.raw_json->'modificationDate'->>'value')::bigint / 1000.0)
        ELSE NULL
      END,
      v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency    = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq        = COALESCE(EXCLUDED.mq,     public.padova_listings.mq),
      locali    = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni     = COALESCE(EXCLUDED.bagni,  public.padova_listings.bagni),
      prezzo    = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat       = COALESCE(EXCLUDED.lat,    public.padova_listings.lat),
      lng       = COALESCE(EXCLUDED.lng,    public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      raw_json  = EXCLUDED.raw_json,
      published_at_portal = COALESCE(public.padova_listings.published_at_portal, EXCLUDED.published_at_portal),
      last_seen_at = v_now,
      expired_at = NULL
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
    INTO v_ideal_new, v_ideal_upd FROM ups;

  -- CASA.IT: upsert da staging (raw_json grezzo da actor solidcode)
  WITH src AS (
    SELECT DISTINCT ON (raw_json->>'url')
      raw_json->>'url'                         AS url,
      raw_json->>'publisherName'               AS agency,
      CASE WHEN raw_json->>'publisherName' IS NOT NULL THEN 'AGENZIA' ELSE NULL END AS tipo_lead,
      NULLIF((raw_json->'features'->>'squareMeters'),'')::int  AS mq,
      NULLIF((raw_json->'features'->>'rooms'),'')::int         AS locali,
      NULLIF((raw_json->'features'->>'bathrooms'),'')::int     AS bagni,
      NULLIF(raw_json->>'price','')::int                       AS prezzo,
      NULLIF((raw_json->'location'->'coordinates'->>'lat'),'')::float8 AS lat,
      NULLIF((raw_json->'location'->'coordinates'->>'lon'),'')::float8 AS lng,
      coalesce(raw_json->'title'->>'main', raw_json->'location'->>'city') AS indirizzo,
      raw_json, fetched_at
    FROM public.padova_casa_staging
    WHERE fetched_at >= p_since AND raw_json->>'url' IS NOT NULL
    ORDER BY raw_json->>'url', fetched_at DESC
  ),
  ups AS (
    INSERT INTO public.padova_listings
      (fonte, url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo,
       raw_json, published_at_portal, imported_at, last_seen_at)
    SELECT 'casa', s.url, s.agency, s.tipo_lead, s.mq, s.locali, s.bagni, s.prezzo,
           s.lat, s.lng, s.indirizzo, s.raw_json, NULL, v_now, v_now
    FROM src s
    ON CONFLICT (fonte, url) DO UPDATE SET
      agency    = COALESCE(EXCLUDED.agency, public.padova_listings.agency),
      tipo_lead = COALESCE(EXCLUDED.tipo_lead, public.padova_listings.tipo_lead),
      mq        = COALESCE(EXCLUDED.mq, public.padova_listings.mq),
      locali    = COALESCE(EXCLUDED.locali, public.padova_listings.locali),
      bagni     = COALESCE(EXCLUDED.bagni, public.padova_listings.bagni),
      prezzo    = COALESCE(EXCLUDED.prezzo, public.padova_listings.prezzo),
      lat       = COALESCE(EXCLUDED.lat, public.padova_listings.lat),
      lng       = COALESCE(EXCLUDED.lng, public.padova_listings.lng),
      indirizzo = COALESCE(EXCLUDED.indirizzo, public.padova_listings.indirizzo),
      raw_json  = EXCLUDED.raw_json,
      last_seen_at = v_now,
      expired_at = NULL
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
    INTO v_casa_new, v_casa_upd FROM ups;

  RETURN jsonb_build_object(
    'ok', true,
    'since', p_since,
    'idealista', jsonb_build_object('new', v_ideal_new, 'updated', v_ideal_upd),
    'casa',      jsonb_build_object('new', v_casa_new,  'updated', v_casa_upd)
  );
END;
$$;

-- 5) Mark expired (per full weekly): annunci agenzie non visti in questa run
CREATE OR REPLACE FUNCTION public.expire_padova_agency_listings(p_seen_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.padova_listings
     SET expired_at = now()
   WHERE fonte IN ('idealista','casa','immobiliare')
     AND expired_at IS NULL
     AND last_seen_at < p_seen_since;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'expired', v_n, 'seen_since', p_seen_since);
END $$;

GRANT EXECUTE ON FUNCTION public.agency_pipeline_monthly_spent_usd() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_pipeline_budget_check(numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.promote_padova_agencies_listings(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_padova_agency_listings(timestamptz) TO service_role;
