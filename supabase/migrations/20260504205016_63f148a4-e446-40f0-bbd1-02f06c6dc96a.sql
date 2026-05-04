
CREATE TABLE IF NOT EXISTS public.inheritance_pressure_signals (
  id BIGSERIAL PRIMARY KEY,
  region TEXT NOT NULL DEFAULT 'veneto',
  provincia TEXT NOT NULL,
  comune TEXT NOT NULL,
  area_label TEXT NOT NULL,
  area_type TEXT NOT NULL CHECK (area_type IN ('comune','quartiere','microzona','sezione_censuaria','cap','zona_omi')),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  score NUMERIC NOT NULL CHECK (score >= 0 AND score <= 100),
  confidence_score NUMERIC NOT NULL DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 100),
  signal_basis TEXT[] NOT NULL DEFAULT '{}',
  indicators JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality TEXT NOT NULL DEFAULT 'parziale' CHECK (quality IN ('reale','parziale')),
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  source_names TEXT[] NOT NULL DEFAULT '{}',
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ips_region_prov ON public.inheritance_pressure_signals(region, provincia);
CREATE INDEX IF NOT EXISTS idx_ips_area ON public.inheritance_pressure_signals(area_type, comune);
ALTER TABLE public.inheritance_pressure_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_ips" ON public.inheritance_pressure_signals FOR SELECT USING (true);
CREATE POLICY "service_role_full_ips" ON public.inheritance_pressure_signals FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.estate_turnover_zones (
  id BIGSERIAL PRIMARY KEY,
  region TEXT NOT NULL DEFAULT 'veneto',
  provincia TEXT NOT NULL,
  comune TEXT NOT NULL,
  microzona TEXT,
  area_label TEXT NOT NULL,
  score NUMERIC NOT NULL CHECK (score >= 0 AND score <= 100),
  temperature TEXT NOT NULL CHECK (temperature IN ('fredda','tiepida','calda','molto_calda','monitor')),
  reason TEXT NOT NULL,
  agent_action TEXT NOT NULL,
  script TEXT NOT NULL,
  positive_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  data_basis TEXT[] NOT NULL DEFAULT '{}',
  quality TEXT NOT NULL DEFAULT 'parziale' CHECK (quality IN ('reale','parziale')),
  confidence_score NUMERIC NOT NULL DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 100),
  fingerprint TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_etz_region_prov ON public.estate_turnover_zones(region, provincia);
CREATE INDEX IF NOT EXISTS idx_etz_score ON public.estate_turnover_zones(score DESC);
ALTER TABLE public.estate_turnover_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_etz" ON public.estate_turnover_zones FOR SELECT USING (true);
CREATE POLICY "service_role_full_etz" ON public.estate_turnover_zones FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.inheritance_safe_source_documents (
  id BIGSERIAL PRIMARY KEY,
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  classification TEXT NOT NULL,
  contains_personal_data BOOLEAN NOT NULL DEFAULT false,
  imported_as_aggregate BOOLEAN NOT NULL DEFAULT false,
  rejected_reason TEXT,
  extracted_aggregate_indicators JSONB NOT NULL DEFAULT '{}'::jsonb,
  comune TEXT,
  provincia TEXT,
  hash TEXT NOT NULL UNIQUE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_issd_class ON public.inheritance_safe_source_documents(classification);
ALTER TABLE public.inheritance_safe_source_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_issd" ON public.inheritance_safe_source_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
