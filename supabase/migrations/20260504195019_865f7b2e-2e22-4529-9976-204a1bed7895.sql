
-- 1. data_sources registry
CREATE TABLE IF NOT EXISTS public.data_sources (
  id BIGSERIAL PRIMARY KEY,
  source_name TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('official','authorized_api','public_allowed','civiko_generated')),
  priority INTEGER NOT NULL DEFAULT 50,
  coverage_area TEXT NOT NULL DEFAULT 'veneto',
  allowed_use TEXT,
  requires_key BOOLEAN NOT NULL DEFAULT false,
  ingestion_status TEXT NOT NULL DEFAULT 'ready' CHECK (ingestion_status IN ('ready','active','blocked','missing_credentials','not_available')),
  last_run_at TIMESTAMPTZ,
  reliability_score NUMERIC,
  freshness_score NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_data_sources" ON public.data_sources FOR SELECT USING (true);
CREATE POLICY "service_role_full_data_sources" ON public.data_sources FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. ingestion_runs
CREATE TABLE IF NOT EXISTS public.ingestion_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  source_name TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  rows_in INTEGER DEFAULT 0,
  rows_out INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]'::jsonb,
  warnings JSONB DEFAULT '[]'::jsonb,
  report JSONB DEFAULT '{}'::jsonb
);
ALTER TABLE public.ingestion_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_ingestion_runs" ON public.ingestion_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. auction_signals
CREATE TABLE IF NOT EXISTS public.auction_signals (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  source_url TEXT,
  province TEXT,
  municipality TEXT,
  cap TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  property_type TEXT,
  base_price_eur NUMERIC,
  minimum_offer_eur NUMERIC,
  sale_date DATE,
  status TEXT,
  data_basis TEXT,
  quality TEXT NOT NULL DEFAULT 'parziale',
  payload JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.auction_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_auction_signals" ON public.auction_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. territorial_signals
CREATE TABLE IF NOT EXISTS public.territorial_signals (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  province TEXT,
  municipality TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  title TEXT,
  description TEXT,
  data_basis TEXT,
  quality TEXT NOT NULL DEFAULT 'parziale',
  payload JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.territorial_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_territorial_signals" ON public.territorial_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. area_opportunity_scores
CREATE TABLE IF NOT EXISTS public.area_opportunity_scores (
  id BIGSERIAL PRIMARY KEY,
  region TEXT NOT NULL DEFAULT 'veneto',
  province TEXT NOT NULL,
  municipality TEXT NOT NULL,
  microzone TEXT,
  score NUMERIC NOT NULL,
  temperature TEXT NOT NULL,
  components JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_basis TEXT,
  quality TEXT NOT NULL DEFAULT 'parziale',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(province, municipality, microzone)
);
ALTER TABLE public.area_opportunity_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_aos" ON public.area_opportunity_scores FOR SELECT USING (true);
CREATE POLICY "service_role_full_aos" ON public.area_opportunity_scores FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. source_documents
CREATE TABLE IF NOT EXISTS public.source_documents (
  id BIGSERIAL PRIMARY KEY,
  source_name TEXT NOT NULL,
  doc_type TEXT,
  url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);
ALTER TABLE public.source_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_source_documents" ON public.source_documents FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 7. source_fetch_logs
CREATE TABLE IF NOT EXISTS public.source_fetch_logs (
  id BIGSERIAL PRIMARY KEY,
  source_name TEXT NOT NULL,
  url TEXT,
  status_code INTEGER,
  ok BOOLEAN,
  error TEXT,
  duration_ms INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.source_fetch_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_source_fetch_logs" ON public.source_fetch_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 8. civiko_data_quality
CREATE TABLE IF NOT EXISTS public.civiko_data_quality (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'veneto',
  rows_total INTEGER,
  rows_real INTEGER,
  rows_partial INTEGER,
  rows_demo INTEGER,
  provinces_covered TEXT[],
  municipalities_covered INTEGER,
  last_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);
ALTER TABLE public.civiko_data_quality ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_cdq" ON public.civiko_data_quality FOR SELECT USING (true);
CREATE POLICY "service_role_full_cdq" ON public.civiko_data_quality FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Indici utili
CREATE INDEX IF NOT EXISTS idx_auction_signals_prov ON public.auction_signals(province, municipality);
CREATE INDEX IF NOT EXISTS idx_aos_prov ON public.area_opportunity_scores(province, municipality);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_job ON public.ingestion_runs(job_name, started_at DESC);
