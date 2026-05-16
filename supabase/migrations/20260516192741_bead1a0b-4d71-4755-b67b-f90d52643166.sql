
CREATE TABLE public.raw_sources_ingest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  source_url text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  municipality text,
  microzone text,
  ingest_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_raw_sources_fetched ON public.raw_sources_ingest (fetched_at DESC);
CREATE INDEX idx_raw_sources_muni ON public.raw_sources_ingest (municipality);

ALTER TABLE public.raw_sources_ingest ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_raw_sources"
  ON public.raw_sources_ingest FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "service_role_full_raw_sources"
  ON public.raw_sources_ingest FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE TABLE public.normalized_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_id uuid REFERENCES public.raw_sources_ingest(id) ON DELETE SET NULL,
  title text NOT NULL,
  municipality text,
  microzone text,
  address_text text,
  property_type text,
  ask_price numeric,
  surface_mq numeric,
  source_name text NOT NULL,
  source_url text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  freshness_days integer NOT NULL DEFAULT 0,
  completeness_score numeric NOT NULL DEFAULT 0,
  priority_score numeric NOT NULL DEFAULT 0,
  scoring_reason text,
  possible_duplicate boolean NOT NULL DEFAULT false,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_norm_opp_muni ON public.normalized_opportunities (municipality);
CREATE INDEX idx_norm_opp_microzone ON public.normalized_opportunities (microzone);
CREATE INDEX idx_norm_opp_priority ON public.normalized_opportunities (priority_score DESC);
CREATE INDEX idx_norm_opp_dedupe ON public.normalized_opportunities (dedupe_key);
CREATE INDEX idx_norm_opp_last_seen ON public.normalized_opportunities (last_seen_at DESC);

ALTER TABLE public.normalized_opportunities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_norm_opp"
  ON public.normalized_opportunities FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "service_role_full_norm_opp"
  ON public.normalized_opportunities FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER trg_norm_opp_updated_at
  BEFORE UPDATE ON public.normalized_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();
