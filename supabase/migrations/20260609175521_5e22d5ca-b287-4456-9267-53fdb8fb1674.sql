CREATE TABLE IF NOT EXISTS public.padova_firecrawl_jobs (
  job_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  source_job_id text,
  annunci_totali integer NOT NULL DEFAULT 0,
  annunci_processati integer NOT NULL DEFAULT 0,
  annunci_ok integer NOT NULL DEFAULT 0,
  annunci_fail integer NOT NULL DEFAULT 0,
  fallback_apify_usati integer NOT NULL DEFAULT 0,
  spesa_firecrawl_usd numeric NOT NULL DEFAULT 0,
  spesa_apify_usd numeric NOT NULL DEFAULT 0,
  cov_mq integer NOT NULL DEFAULT 0,
  cov_locali integer NOT NULL DEFAULT 0,
  cov_piano integer NOT NULL DEFAULT 0,
  cov_bagni integer NOT NULL DEFAULT 0,
  cov_civico integer NOT NULL DEFAULT 0,
  cov_agency integer NOT NULL DEFAULT 0,
  cov_tipologia integer NOT NULL DEFAULT 0,
  cov_latlng integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

GRANT ALL ON public.padova_firecrawl_jobs TO service_role;

ALTER TABLE public.padova_firecrawl_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only padova_firecrawl_jobs"
  ON public.padova_firecrawl_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
