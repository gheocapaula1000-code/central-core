ALTER TABLE public.normalized_opportunities
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS external_ref text;

CREATE INDEX IF NOT EXISTS idx_norm_opp_category ON public.normalized_opportunities(category);
CREATE INDEX IF NOT EXISTS idx_norm_opp_external_ref ON public.normalized_opportunities(external_ref);