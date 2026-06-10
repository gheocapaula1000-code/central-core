
CREATE TABLE IF NOT EXISTS public.padova_idealista_staging (
  id BIGSERIAL PRIMARY KEY,
  url TEXT,
  agency TEXT,
  tipo_lead TEXT,
  mq INTEGER,
  locali INTEGER,
  bagni INTEGER,
  prezzo INTEGER,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  indirizzo TEXT,
  raw_json JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_idealista_staging TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_idealista_staging_id_seq TO service_role;
ALTER TABLE public.padova_idealista_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_idealista_staging" ON public.padova_idealista_staging
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.padova_casa_test (
  id BIGSERIAL PRIMARY KEY,
  raw_json JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_casa_test TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_casa_test_id_seq TO service_role;
ALTER TABLE public.padova_casa_test ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_casa_test" ON public.padova_casa_test
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.padova_subito_test (
  id BIGSERIAL PRIMARY KEY,
  raw_json JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.padova_subito_test TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_subito_test_id_seq TO service_role;
ALTER TABLE public.padova_subito_test ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_subito_test" ON public.padova_subito_test
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.padova_apify_runs (
  id BIGSERIAL PRIMARY KEY,
  portal TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dataset_id TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  cost_cap_usd NUMERIC NOT NULL,
  cost_usd NUMERIC,
  items_count INTEGER,
  imported INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
GRANT ALL ON public.padova_apify_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.padova_apify_runs_id_seq TO service_role;
ALTER TABLE public.padova_apify_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_apify_runs" ON public.padova_apify_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_padova_apify_runs_portal_started ON public.padova_apify_runs(portal, started_at DESC);
