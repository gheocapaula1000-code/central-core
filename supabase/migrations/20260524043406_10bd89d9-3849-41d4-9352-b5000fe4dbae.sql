
CREATE TABLE IF NOT EXISTS public.luxuradar_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'IT',
  region TEXT,
  city TEXT,
  price_eur BIGINT,
  price_min_eur BIGINT,
  price_max_eur BIGINT,
  surface_sqm INTEGER,
  score INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'low',
  why_now TEXT,
  opportunity TEXT,
  risk TEXT,
  source_category TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_url TEXT,
  dossier_available BOOLEAN NOT NULL DEFAULT false,
  hero_image_url TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NOT NULL,
  scan_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT luxuradar_assets_dedupe_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS luxuradar_assets_priority_idx ON public.luxuradar_assets (priority, score DESC);
CREATE INDEX IF NOT EXISTS luxuradar_assets_city_idx ON public.luxuradar_assets (city);
CREATE INDEX IF NOT EXISTS luxuradar_assets_category_idx ON public.luxuradar_assets (category);
CREATE INDEX IF NOT EXISTS luxuradar_assets_price_idx ON public.luxuradar_assets (price_eur);

CREATE TABLE IF NOT EXISTS public.luxuradar_scan_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  assets_found INTEGER NOT NULL DEFAULT 0,
  assets_new INTEGER NOT NULL DEFAULT 0,
  sources_used TEXT[] NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.luxuradar_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luxuradar_scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read luxuradar_assets"
  ON public.luxuradar_assets FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins read luxuradar_scan_runs"
  ON public.luxuradar_scan_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER luxuradar_assets_touch
  BEFORE UPDATE ON public.luxuradar_assets
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
