CREATE TABLE IF NOT EXISTS public.zone_completeness (
  id BIGSERIAL PRIMARY KEY,
  zone_key TEXT NOT NULL UNIQUE,
  zone_label TEXT NOT NULL,
  total_records INTEGER NOT NULL DEFAULT 0,
  categories_count INTEGER NOT NULL DEFAULT 0,
  geo_coverage_ratio NUMERIC NOT NULL DEFAULT 0,
  freshness_score NUMERIC NOT NULL DEFAULT 0,
  avg_freshness_days NUMERIC NOT NULL DEFAULT 0,
  min_quality_ratio NUMERIC NOT NULL DEFAULT 0,
  completeness_score NUMERIC NOT NULL DEFAULT 0,
  readiness_label TEXT NOT NULL DEFAULT 'debole',
  top_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_short TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zone_completeness_score ON public.zone_completeness (completeness_score DESC);

ALTER TABLE public.zone_completeness ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_zone_completeness"
ON public.zone_completeness FOR ALL TO service_role
USING (true) WITH CHECK (true);