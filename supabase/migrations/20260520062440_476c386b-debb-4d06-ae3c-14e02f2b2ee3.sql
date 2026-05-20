
CREATE TABLE IF NOT EXISTS public.early_warning_opportunities (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'veneto',
  provincia TEXT,
  comune TEXT NOT NULL,
  microzona TEXT,
  area_label TEXT,
  property_type TEXT,
  identity_hash TEXT,
  primary_signal_type TEXT NOT NULL,
  signal_types TEXT[] NOT NULL DEFAULT '{}',
  secondary_signals JSONB NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  sources_count INTEGER NOT NULL DEFAULT 0,
  source_names TEXT[] NOT NULL DEFAULT '{}',
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  early_acquisition_score NUMERIC NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'media',
  explanation TEXT,
  recommended_action TEXT,
  warnings TEXT[] NOT NULL DEFAULT '{}',
  privacy_safe BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  payload JSONB NOT NULL DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ewo_comune_active ON public.early_warning_opportunities(comune, is_active);
CREATE INDEX IF NOT EXISTS idx_ewo_score ON public.early_warning_opportunities(early_acquisition_score DESC);
CREATE INDEX IF NOT EXISTS idx_ewo_identity ON public.early_warning_opportunities(identity_hash);

ALTER TABLE public.early_warning_opportunities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_ewo"
  ON public.early_warning_opportunities
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "public_read_ewo"
  ON public.early_warning_opportunities
  FOR SELECT TO public USING (is_active = true AND privacy_safe = true);
