
-- microzone_sentiment
CREATE TABLE IF NOT EXISTS public.microzone_sentiment (
  id BIGSERIAL PRIMARY KEY,
  comune TEXT NOT NULL,
  provincia TEXT NOT NULL,
  area_label TEXT,
  area_type TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  environment_score NUMERIC,
  noise_score NUMERIC,
  air_quality_score NUMERIC,
  green_score NUMERIC,
  services_score NUMERIC,
  school_access_score NUMERIC,
  transit_access_score NUMERIC,
  parking_score NUMERIC,
  safety_proxy_score NUMERIC,
  tourism_pressure_score NUMERIC,
  nightlife_pressure_score NUMERIC,
  urban_decay_risk_score NUMERIC,
  family_fit_score NUMERIC,
  student_fit_score NUMERIC,
  investor_fit_score NUMERIC,
  sentiment_score_total NUMERIC,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'parziale',
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS microzone_sentiment_fingerprint_uniq ON public.microzone_sentiment(fingerprint);
CREATE INDEX IF NOT EXISTS microzone_sentiment_geo_idx ON public.microzone_sentiment(provincia, comune);
ALTER TABLE public.microzone_sentiment ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY public_read_microzone_sentiment ON public.microzone_sentiment FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY service_role_full_microzone_sentiment ON public.microzone_sentiment FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- turnover_signals
CREATE TABLE IF NOT EXISTS public.turnover_signals (
  id BIGSERIAL PRIMARY KEY,
  comune TEXT NOT NULL,
  provincia TEXT NOT NULL,
  area_label TEXT,
  elderly_ratio NUMERIC,
  single_household_ratio NUMERIC,
  non_occupied_ratio NUMERIC,
  old_building_ratio NUMERIC,
  second_home_proxy NUMERIC,
  low_rotation_proxy NUMERIC,
  distress_aggregate NUMERIC,
  turnover_potential_score NUMERIC NOT NULL DEFAULT 0,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'parziale',
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS turnover_signals_fingerprint_uniq ON public.turnover_signals(fingerprint);
CREATE INDEX IF NOT EXISTS turnover_signals_geo_idx ON public.turnover_signals(provincia, comune);
ALTER TABLE public.turnover_signals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY public_read_turnover_signals ON public.turnover_signals FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY service_role_full_turnover_signals ON public.turnover_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- territorial_signals extensions
ALTER TABLE public.territorial_signals
  ADD COLUMN IF NOT EXISTS signal_subtype TEXT,
  ADD COLUMN IF NOT EXISTS impact_direction TEXT,
  ADD COLUMN IF NOT EXISTS impact_strength NUMERIC,
  ADD COLUMN IF NOT EXISTS target_demand_segment TEXT,
  ADD COLUMN IF NOT EXISTS amount_eur NUMERIC,
  ADD COLUMN IF NOT EXISTS geo_polygon JSONB,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- data_sources extensions for the registry-backed catalog
ALTER TABLE public.data_sources
  ADD COLUMN IF NOT EXISTS base_url TEXT,
  ADD COLUMN IF NOT EXISTS province TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS comuni TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_paths TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS excluded_paths TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS expected_entities TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS format_expected TEXT,
  ADD COLUMN IF NOT EXISTS ingestion_method TEXT,
  ADD COLUMN IF NOT EXISTS quality_default TEXT NOT NULL DEFAULT 'parziale';
CREATE UNIQUE INDEX IF NOT EXISTS data_sources_source_name_uniq ON public.data_sources(source_name);
