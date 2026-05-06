
CREATE TABLE IF NOT EXISTS public.early_offmarket_signal_candidates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id TEXT,
  comune TEXT,
  provincia TEXT,
  signal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  why_it_matters TEXT,
  possible_agent_action TEXT,
  timing TEXT CHECK (timing IN ('early','active','monitoring')) DEFAULT 'early',
  source_url TEXT NOT NULL,
  source_name TEXT,
  confidence_score NUMERIC(4,2) DEFAULT 0,
  quality TEXT CHECK (quality IN ('alta','media','bassa')) DEFAULT 'media',
  data_basis TEXT,
  privacy_safe BOOLEAN NOT NULL DEFAULT true,
  needs_review BOOLEAN NOT NULL DEFAULT true,
  import_recommendation TEXT CHECK (import_recommendation IN ('importable','needs_review','reject')) DEFAULT 'needs_review',
  reject_reason TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  fingerprint TEXT NOT NULL UNIQUE,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eosc_run ON public.early_offmarket_signal_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_eosc_comune ON public.early_offmarket_signal_candidates(comune);
CREATE INDEX IF NOT EXISTS idx_eosc_signal_type ON public.early_offmarket_signal_candidates(signal_type);
CREATE INDEX IF NOT EXISTS idx_eosc_import_reco ON public.early_offmarket_signal_candidates(import_recommendation);

ALTER TABLE public.early_offmarket_signal_candidates ENABLE ROW LEVEL SECURITY;

-- No policies: only service_role bypasses RLS. Public + authenticated = no access.
