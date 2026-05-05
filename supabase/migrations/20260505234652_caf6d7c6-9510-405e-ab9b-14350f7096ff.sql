
CREATE TABLE IF NOT EXISTS public.offmarket_opportunity_scores (
  id BIGSERIAL PRIMARY KEY,
  region TEXT NOT NULL DEFAULT 'veneto',
  comune TEXT NOT NULL,
  provincia TEXT NOT NULL,
  area_label TEXT NOT NULL,
  area_type TEXT NOT NULL DEFAULT 'comune',
  off_market_potential_score NUMERIC NOT NULL DEFAULT 0,
  acquisition_priority_score NUMERIC NOT NULL DEFAULT 0,
  owner_education_score NUMERIC NOT NULL DEFAULT 0,
  microzone_heat_score NUMERIC NOT NULL DEFAULT 0,
  family_attractiveness_score NUMERIC NOT NULL DEFAULT 0,
  investor_attractiveness_score NUMERIC NOT NULL DEFAULT 0,
  exclusive_pitch_score NUMERIC NOT NULL DEFAULT 0,
  valuation_campaign_score NUMERIC NOT NULL DEFAULT 0,
  confidence_score NUMERIC NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'parziale',
  positive_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  negative_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  scripts JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_basis JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  fingerprint TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.offmarket_opportunity_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_oos" ON public.offmarket_opportunity_scores
  FOR SELECT TO public USING (true);

CREATE POLICY "service_role_full_oos" ON public.offmarket_opportunity_scores
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_oos_provincia ON public.offmarket_opportunity_scores(provincia);
CREATE INDEX IF NOT EXISTS idx_oos_offmarket ON public.offmarket_opportunity_scores(off_market_potential_score DESC);
CREATE INDEX IF NOT EXISTS idx_oos_acquisition ON public.offmarket_opportunity_scores(acquisition_priority_score DESC);
