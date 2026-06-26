
CREATE TABLE IF NOT EXISTS public.b2b_enrichment_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  job_id uuid REFERENCES public.b2b_search_jobs(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('smart','deep','missing_only')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled','failed')),
  total int NOT NULL DEFAULT 0,
  processed int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  ready_to_contact int NOT NULL DEFAULT 0,
  cost_eur numeric NOT NULL DEFAULT 0,
  budget_eur numeric NOT NULL DEFAULT 0,
  limit_n int NOT NULL DEFAULT 0,
  company_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  providers_used jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_enrichment_jobs TO authenticated;
GRANT ALL ON public.b2b_enrichment_jobs TO service_role;
ALTER TABLE public.b2b_enrichment_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_b2b_enrichment_jobs"
  ON public.b2b_enrichment_jobs FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated_read_b2b_enrichment_jobs"
  ON public.b2b_enrichment_jobs FOR SELECT
  TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_b2b_enrichment_jobs_status ON public.b2b_enrichment_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_b2b_enrichment_jobs_job_id ON public.b2b_enrichment_jobs(job_id);
