CREATE TABLE IF NOT EXISTS public.auction_discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  apify_run_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates_count integer NOT NULL DEFAULT 0,
  importable_count integer NOT NULL DEFAULT 0,
  needs_review_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adr_status ON public.auction_discovery_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.auction_discovery_candidates (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.auction_discovery_runs(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  source_url text,
  title text,
  comune text,
  provincia text,
  tribunal text,
  auction_date date,
  base_price numeric,
  minimum_offer numeric,
  asset_type text,
  lot_number text,
  procedure_number text,
  pdf_url text,
  confidence_score numeric NOT NULL DEFAULT 0,
  quality text NOT NULL DEFAULT 'parziale',
  data_basis text[] NOT NULL DEFAULT '{}',
  privacy_redacted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'needs_review',
  reject_reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_adc_run ON public.auction_discovery_candidates(run_id, status);
CREATE INDEX IF NOT EXISTS idx_adc_fp ON public.auction_discovery_candidates(fingerprint);
CREATE INDEX IF NOT EXISTS idx_adc_prov ON public.auction_discovery_candidates(provincia, status);

ALTER TABLE public.auction_discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_discovery_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_full_adr ON public.auction_discovery_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_adc ON public.auction_discovery_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);