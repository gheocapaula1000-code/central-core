
-- ═══════════════════════════════════════════════════════════════
-- Civiko Padova — Registro Fonti Dati (PROMPT 0)
-- ═══════════════════════════════════════════════════════════════

-- 1) Tabella registro fonti
CREATE TABLE public.civiko_data_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  label         text NOT NULL,
  description   text,
  category      text NOT NULL CHECK (category IN ('free','premium','manual_or_phase_2')),
  status        text NOT NULL CHECK (status IN (
                    'connected',
                    'connectable',
                    'account_required',
                    'manual',
                    'not_yet_available',
                    'phase_2'
                  )),
  provider      text,
  base_url      text,
  env_var       text,
  coverage      text,
  requires_premium_consent boolean NOT NULL DEFAULT false,
  estimated_cost_eur numeric(10,4),
  notes         text,
  display_order integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_civiko_data_sources_status   ON public.civiko_data_sources(status);
CREATE INDEX idx_civiko_data_sources_category ON public.civiko_data_sources(category);

GRANT SELECT ON public.civiko_data_sources TO anon;
GRANT SELECT ON public.civiko_data_sources TO authenticated;
GRANT ALL    ON public.civiko_data_sources TO service_role;

ALTER TABLE public.civiko_data_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "data_sources public read"
  ON public.civiko_data_sources FOR SELECT
  USING (true);

CREATE POLICY "data_sources service write"
  ON public.civiko_data_sources FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER trg_civiko_data_sources_touch
  BEFORE UPDATE ON public.civiko_data_sources
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

-- 2) Tabella log esecuzioni ingest
CREATE TABLE public.civiko_source_ingestion_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code    text NOT NULL REFERENCES public.civiko_data_sources(code) ON DELETE CASCADE,
  status         text NOT NULL CHECK (status IN ('ok','partial','error','skipped')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  duration_ms    integer,
  rows_ingested  integer,
  error_code     text,
  error_message  text,
  debug_id       text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_civiko_runs_source ON public.civiko_source_ingestion_runs(source_code, started_at DESC);
CREATE INDEX idx_civiko_runs_status ON public.civiko_source_ingestion_runs(status);

GRANT SELECT ON public.civiko_source_ingestion_runs TO authenticated;
GRANT ALL    ON public.civiko_source_ingestion_runs TO service_role;

ALTER TABLE public.civiko_source_ingestion_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingestion_runs authenticated read"
  ON public.civiko_source_ingestion_runs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "ingestion_runs service write"
  ON public.civiko_source_ingestion_runs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
