-- Civiko: classificazione di sicurezza e visibilità segnali

CREATE TABLE IF NOT EXISTS public.civiko_signal_policy (
  id BIGSERIAL PRIMARY KEY,
  signal_type TEXT NOT NULL UNIQUE,
  sensitivity_level TEXT NOT NULL CHECK (sensitivity_level IN ('basso','medio','alto','escluso')),
  usable_for_scoring BOOLEAN NOT NULL DEFAULT true,
  visible_to_agency BOOLEAN NOT NULL DEFAULT false,
  visible_to_owner BOOLEAN NOT NULL DEFAULT false,
  retention_policy TEXT NOT NULL DEFAULT '90d',
  forbidden_phrases TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.civiko_signal_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_csp"
  ON public.civiko_signal_policy FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.civiko_signals_classified (
  id BIGSERIAL PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE,
  signal_type TEXT NOT NULL,
  source_name_internal TEXT NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence_level TEXT NOT NULL DEFAULT 'media' CHECK (confidence_level IN ('alta','media','bassa')),
  sensitivity_level TEXT NOT NULL CHECK (sensitivity_level IN ('basso','medio','alto','escluso')),
  usable_for_scoring BOOLEAN NOT NULL DEFAULT true,
  visible_to_agency BOOLEAN NOT NULL DEFAULT false,
  visible_to_owner BOOLEAN NOT NULL DEFAULT false,
  allowed_commercial_phrase TEXT,
  forbidden_phrases TEXT[] NOT NULL DEFAULT '{}',
  retention_policy TEXT NOT NULL DEFAULT '90d',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_csc_signal_type ON public.civiko_signals_classified(signal_type);
CREATE INDEX IF NOT EXISTS idx_csc_sensitivity ON public.civiko_signals_classified(sensitivity_level);
CREATE INDEX IF NOT EXISTS idx_csc_collected_at ON public.civiko_signals_classified(collected_at DESC);

ALTER TABLE public.civiko_signals_classified ENABLE ROW LEVEL SECURITY;

-- Nessuna policy pubblica: questi dati restano SOLO al Core (service_role).
-- I client autenticati non leggono mai direttamente questa tabella;
-- le viste agency/owner vengono costruite dal Core via edge function.
CREATE POLICY "service_role_full_csc"
  ON public.civiko_signals_classified FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_csp_touch
  BEFORE UPDATE ON public.civiko_signal_policy
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

CREATE TRIGGER trg_csc_touch
  BEFORE UPDATE ON public.civiko_signals_classified
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();