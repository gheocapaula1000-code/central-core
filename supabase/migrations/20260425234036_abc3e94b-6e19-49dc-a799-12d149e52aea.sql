-- ── Civiko One Hyperlocal Signals base schema ──

CREATE TABLE IF NOT EXISTS public.local_sources (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  url TEXT,
  source_owner TEXT,
  reliability_score NUMERIC,
  allowed_usage TEXT,
  refresh_frequency TEXT,
  last_checked_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  municipality TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_local_sources_active ON public.local_sources (is_active, level);
CREATE INDEX IF NOT EXISTS idx_local_sources_municipality ON public.local_sources (municipality);

ALTER TABLE public.local_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_local_sources" ON public.local_sources;
CREATE POLICY "public_read_local_sources"
  ON public.local_sources FOR SELECT
  USING (is_active = TRUE);

DROP POLICY IF EXISTS "service_role_write_local_sources" ON public.local_sources;
CREATE POLICY "service_role_write_local_sources"
  ON public.local_sources FOR ALL
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- ── local_signals ──
CREATE TABLE IF NOT EXISTS public.local_signals (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT REFERENCES public.local_sources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  summary TEXT,
  category TEXT,
  location_text TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_meters INTEGER,
  municipality TEXT,
  neighborhood TEXT,
  published_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  signal_tone TEXT NOT NULL DEFAULT 'neutral' CHECK (signal_tone IN ('positive','negative','mixed','neutral')),
  commercial_use TEXT,
  evidence_url TEXT,
  expires_at TIMESTAMPTZ,
  use_in_report BOOLEAN NOT NULL DEFAULT TRUE,
  source_level SMALLINT NOT NULL DEFAULT 2 CHECK (source_level BETWEEN 1 AND 4),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_local_signals_municipality ON public.local_signals (municipality, is_active);
CREATE INDEX IF NOT EXISTS idx_local_signals_neighborhood ON public.local_signals (neighborhood);
CREATE INDEX IF NOT EXISTS idx_local_signals_category ON public.local_signals (category);
CREATE INDEX IF NOT EXISTS idx_local_signals_geo ON public.local_signals (lat, lng);

ALTER TABLE public.local_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_local_signals" ON public.local_signals;
CREATE POLICY "public_read_local_signals"
  ON public.local_signals FOR SELECT
  USING (is_active = TRUE AND (expires_at IS NULL OR expires_at > now()));

DROP POLICY IF EXISTS "service_role_write_local_signals" ON public.local_signals;
CREATE POLICY "service_role_write_local_signals"
  ON public.local_signals FOR ALL
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- ── property_signal_matches (joins) ──
CREATE TABLE IF NOT EXISTS public.property_signal_matches (
  id BIGSERIAL PRIMARY KEY,
  property_id TEXT NOT NULL,
  signal_id BIGINT NOT NULL REFERENCES public.local_signals(id) ON DELETE CASCADE,
  distance_meters NUMERIC,
  relevance_score NUMERIC,
  match_reason TEXT,
  recommended_use TEXT,
  visible_in_owner_report BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psm_property ON public.property_signal_matches (property_id);
CREATE INDEX IF NOT EXISTS idx_psm_signal ON public.property_signal_matches (signal_id);

ALTER TABLE public.property_signal_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_psm" ON public.property_signal_matches;
CREATE POLICY "service_role_full_psm"
  ON public.property_signal_matches FOR ALL
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- ── agency_property_outcomes (TENANT-SCOPED) ──
CREATE TABLE IF NOT EXISTS public.agency_property_outcomes (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID NOT NULL,
  property_id TEXT,
  municipality TEXT,
  neighborhood TEXT,
  property_type TEXT,
  mandate_status TEXT CHECK (mandate_status IN ('won_exclusive','lost_exclusive','non_exclusive','withdrawn','unknown')),
  owner_objections JSONB DEFAULT '[]'::jsonb,
  visits_count INTEGER,
  offers_count INTEGER,
  initial_asking_price NUMERIC,
  final_sale_price NUMERIC,
  days_on_market INTEGER,
  fee_generated NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apo_agency ON public.agency_property_outcomes (agency_id);
CREATE INDEX IF NOT EXISTS idx_apo_area ON public.agency_property_outcomes (municipality, neighborhood);

ALTER TABLE public.agency_property_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_read_own_outcomes" ON public.agency_property_outcomes;
CREATE POLICY "agency_read_own_outcomes"
  ON public.agency_property_outcomes FOR SELECT
  TO authenticated
  USING (agency_id = auth.uid());

DROP POLICY IF EXISTS "service_role_full_apo" ON public.agency_property_outcomes;
CREATE POLICY "service_role_full_apo"
  ON public.agency_property_outcomes FOR ALL
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- ── owner_objection_patterns (TENANT-SCOPED) ──
CREATE TABLE IF NOT EXISTS public.owner_objection_patterns (
  id BIGSERIAL PRIMARY KEY,
  agency_id UUID NOT NULL,
  municipality TEXT,
  neighborhood TEXT,
  objection_type TEXT NOT NULL CHECK (objection_type IN (
    'commission','price_expectation','timing','trust','competition',
    'documentation','visibility','previous_bad_experience','other'
  )),
  objection_text TEXT,
  suggested_response TEXT,
  source TEXT NOT NULL DEFAULT 'agency_internal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oop_agency ON public.owner_objection_patterns (agency_id);
CREATE INDEX IF NOT EXISTS idx_oop_type ON public.owner_objection_patterns (objection_type);

ALTER TABLE public.owner_objection_patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_read_own_objections" ON public.owner_objection_patterns;
CREATE POLICY "agency_read_own_objections"
  ON public.owner_objection_patterns FOR SELECT
  TO authenticated
  USING (agency_id = auth.uid());

DROP POLICY IF EXISTS "service_role_full_oop" ON public.owner_objection_patterns;
CREATE POLICY "service_role_full_oop"
  ON public.owner_objection_patterns FOR ALL
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

-- ── timestamp trigger ──
CREATE OR REPLACE FUNCTION public.civiko_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_local_sources_touch ON public.local_sources;
CREATE TRIGGER trg_local_sources_touch BEFORE UPDATE ON public.local_sources
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

DROP TRIGGER IF EXISTS trg_local_signals_touch ON public.local_signals;
CREATE TRIGGER trg_local_signals_touch BEFORE UPDATE ON public.local_signals
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

DROP TRIGGER IF EXISTS trg_apo_touch ON public.agency_property_outcomes;
CREATE TRIGGER trg_apo_touch BEFORE UPDATE ON public.agency_property_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

DROP TRIGGER IF EXISTS trg_oop_touch ON public.owner_objection_patterns;
CREATE TRIGGER trg_oop_touch BEFORE UPDATE ON public.owner_objection_patterns
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();