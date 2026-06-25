
-- =========================================================================
-- b2b-finder init migration (additive-only, isolated module)
-- =========================================================================

-- 1) b2b_search_jobs
CREATE TABLE public.b2b_search_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  created_by uuid NULL,
  vertical text NOT NULL DEFAULT 'coprimacchia_tnt',
  mode text NOT NULL DEFAULT 'buyers',
  product text NOT NULL DEFAULT 'Coprimacchia TNT Colorati',
  zone jsonb NOT NULL DEFAULT '{}'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  cost_eur numeric(10,4) NOT NULL DEFAULT 0,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text NULL,
  debug_id text NULL,
  CONSTRAINT b2b_search_jobs_status_check
    CHECK (status IN ('queued','running','done','failed')),
  CONSTRAINT b2b_search_jobs_mode_check
    CHECK (mode IN ('buyers','suppliers'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_search_jobs TO authenticated;
GRANT ALL ON public.b2b_search_jobs TO service_role;

ALTER TABLE public.b2b_search_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "b2b_search_jobs service_role full"
  ON public.b2b_search_jobs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "b2b_search_jobs admin read"
  ON public.b2b_search_jobs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_search_jobs admin write"
  ON public.b2b_search_jobs FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_search_jobs admin update"
  ON public.b2b_search_jobs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_search_jobs admin delete"
  ON public.b2b_search_jobs FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_b2b_search_jobs_created_at ON public.b2b_search_jobs (created_at DESC);
CREATE INDEX idx_b2b_search_jobs_status ON public.b2b_search_jobs (status);
CREATE INDEX idx_b2b_search_jobs_vertical ON public.b2b_search_jobs (vertical);

-- 2) b2b_companies
CREATE TABLE public.b2b_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  identity_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NULL,
  address text NULL,
  comune text NULL,
  provincia text NULL,
  regione text NULL DEFAULT 'Veneto',
  country text NULL DEFAULT 'IT',
  lat numeric NULL,
  lng numeric NULL,
  phone text NULL,
  email text NULL,
  website text NULL,
  source_count integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz NULL,
  status text NOT NULL DEFAULT 'new',
  priority text NULL,
  score integer NULL,
  fit_reason text NULL,
  notes text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT b2b_companies_status_check
    CHECK (status IN ('new','contacted','interested','quote_sent','awaiting_payment','won','lost','later','excluded')),
  CONSTRAINT b2b_companies_priority_check
    CHECK (priority IS NULL OR priority IN ('high','medium','low'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_companies TO authenticated;
GRANT ALL ON public.b2b_companies TO service_role;

ALTER TABLE public.b2b_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "b2b_companies service_role full"
  ON public.b2b_companies FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "b2b_companies admin read"
  ON public.b2b_companies FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_companies admin write"
  ON public.b2b_companies FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_companies admin update"
  ON public.b2b_companies FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_companies admin delete"
  ON public.b2b_companies FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_b2b_companies_identity_hash ON public.b2b_companies (identity_hash);
CREATE INDEX idx_b2b_companies_comune ON public.b2b_companies (comune);
CREATE INDEX idx_b2b_companies_provincia ON public.b2b_companies (provincia);
CREATE INDEX idx_b2b_companies_category ON public.b2b_companies (category);
CREATE INDEX idx_b2b_companies_status ON public.b2b_companies (status);
CREATE INDEX idx_b2b_companies_priority ON public.b2b_companies (priority);
CREATE INDEX idx_b2b_companies_last_seen_at ON public.b2b_companies (last_seen_at DESC);

-- 3) b2b_company_sources
CREATE TABLE public.b2b_company_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  company_id uuid NOT NULL REFERENCES public.b2b_companies(id) ON DELETE CASCADE,
  job_id uuid NULL REFERENCES public.b2b_search_jobs(id) ON DELETE SET NULL,
  source text NOT NULL,
  source_ref text NULL,
  source_url text NULL,
  source_title text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  extracted_summary text NULL,
  confidence numeric(5,2) NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT b2b_company_sources_source_check
    CHECK (source IN ('osm','overpass','firecrawl','manual','import','other'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_company_sources TO authenticated;
GRANT ALL ON public.b2b_company_sources TO service_role;

ALTER TABLE public.b2b_company_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "b2b_company_sources service_role full"
  ON public.b2b_company_sources FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "b2b_company_sources admin read"
  ON public.b2b_company_sources FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_company_sources admin write"
  ON public.b2b_company_sources FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_company_sources admin update"
  ON public.b2b_company_sources FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_company_sources admin delete"
  ON public.b2b_company_sources FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_b2b_company_sources_company_id ON public.b2b_company_sources (company_id);
CREATE INDEX idx_b2b_company_sources_job_id ON public.b2b_company_sources (job_id);

-- 4) b2b_outreach_messages
CREATE TABLE public.b2b_outreach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  company_id uuid NOT NULL REFERENCES public.b2b_companies(id) ON DELETE CASCADE,
  job_id uuid NULL REFERENCES public.b2b_search_jobs(id) ON DELETE SET NULL,
  vertical text NOT NULL DEFAULT 'coprimacchia_tnt',
  channel text NOT NULL,
  language text NOT NULL DEFAULT 'it',
  subject text NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  generated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT b2b_outreach_messages_channel_check
    CHECK (channel IN ('whatsapp','email','sms','phone_script','note')),
  CONSTRAINT b2b_outreach_messages_status_check
    CHECK (status IN ('draft','sent_manually','replied','none','archived'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_outreach_messages TO authenticated;
GRANT ALL ON public.b2b_outreach_messages TO service_role;

ALTER TABLE public.b2b_outreach_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "b2b_outreach_messages service_role full"
  ON public.b2b_outreach_messages FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "b2b_outreach_messages admin read"
  ON public.b2b_outreach_messages FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_outreach_messages admin write"
  ON public.b2b_outreach_messages FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_outreach_messages admin update"
  ON public.b2b_outreach_messages FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_outreach_messages admin delete"
  ON public.b2b_outreach_messages FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_b2b_outreach_messages_company_id ON public.b2b_outreach_messages (company_id);
CREATE INDEX idx_b2b_outreach_messages_job_id ON public.b2b_outreach_messages (job_id);

-- 5) b2b_usage_ledger
CREATE TABLE public.b2b_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  day date NOT NULL DEFAULT current_date,
  provider text NOT NULL,
  action text NOT NULL,
  units integer NOT NULL DEFAULT 0,
  cost_eur numeric(10,4) NOT NULL DEFAULT 0,
  job_id uuid NULL REFERENCES public.b2b_search_jobs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT b2b_usage_ledger_provider_check
    CHECK (provider IN ('overpass','firecrawl','lovable_ai','manual','other'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_usage_ledger TO authenticated;
GRANT ALL ON public.b2b_usage_ledger TO service_role;

ALTER TABLE public.b2b_usage_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "b2b_usage_ledger service_role full"
  ON public.b2b_usage_ledger FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "b2b_usage_ledger admin read"
  ON public.b2b_usage_ledger FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "b2b_usage_ledger admin write"
  ON public.b2b_usage_ledger FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_b2b_usage_ledger_day ON public.b2b_usage_ledger (day);
CREATE INDEX idx_b2b_usage_ledger_provider ON public.b2b_usage_ledger (provider);
CREATE INDEX idx_b2b_usage_ledger_job_id ON public.b2b_usage_ledger (job_id);
