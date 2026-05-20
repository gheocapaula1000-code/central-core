CREATE TABLE IF NOT EXISTS public.legal_life_event_signals (
  id BIGSERIAL PRIMARY KEY,
  municipality TEXT NOT NULL,
  province TEXT,
  region TEXT NOT NULL DEFAULT 'veneto',
  signal_type TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  event_date DATE,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  area_or_microzone TEXT,
  property_hint TEXT,
  confidence TEXT NOT NULL DEFAULT 'bassa',
  privacy_safe BOOLEAN NOT NULL DEFAULT false,
  contains_personal_data BOOLEAN NOT NULL DEFAULT false,
  pii_redacted BOOLEAN NOT NULL DEFAULT true,
  legal_basis_note TEXT,
  explanation TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_minimized JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT legal_life_event_signals_confidence_chk CHECK (confidence IN ('bassa','media','alta')),
  CONSTRAINT legal_life_event_signals_type_chk CHECK (signal_type IN (
    'FORECLOSURE_SIGNAL',
    'PRE_AUCTION_SIGNAL',
    'AUCTION_CONFIRMATION',
    'PUBLIC_NOTICE_SIGNAL',
    'POSSIBLE_SUCCESSION_SIGNAL',
    'POSSIBLE_INHERITANCE_SIGNAL',
    'PUBLIC_ASSET_DISPOSAL',
    'MUNICIPAL_PROPERTY_SIGNAL',
    'URBAN_PLANNING_SIGNAL',
    'CONCESSION_OR_LEASE_SIGNAL'
  ))
);

CREATE INDEX IF NOT EXISTS legal_lifeevent_municipality_idx ON public.legal_life_event_signals (municipality);
CREATE INDEX IF NOT EXISTS legal_lifeevent_type_idx ON public.legal_life_event_signals (signal_type);
CREATE INDEX IF NOT EXISTS legal_lifeevent_active_idx ON public.legal_life_event_signals (is_active);
CREATE INDEX IF NOT EXISTS legal_lifeevent_detected_idx ON public.legal_life_event_signals (detected_at DESC);

ALTER TABLE public.legal_life_event_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_legal_life_event_signals"
  ON public.legal_life_event_signals
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated client: read only privacy-safe minimized rows.
CREATE POLICY "auth_read_privacy_safe_legal_life_event_signals"
  ON public.legal_life_event_signals
  FOR SELECT TO authenticated
  USING (
    is_active = true
    AND privacy_safe = true
    AND pii_redacted = true
    AND contains_personal_data = false
  );

-- Updated_at trigger reuses existing civiko helper
DROP TRIGGER IF EXISTS legal_life_event_signals_touch ON public.legal_life_event_signals;
CREATE TRIGGER legal_life_event_signals_touch
BEFORE UPDATE ON public.legal_life_event_signals
FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();