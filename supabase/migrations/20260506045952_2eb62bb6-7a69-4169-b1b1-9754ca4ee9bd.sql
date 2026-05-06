
ALTER TABLE public.early_offmarket_signal_candidates
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'discovered',
  ADD COLUMN IF NOT EXISTS priority_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commercial_value_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS real_estate_relevance_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_reason text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS asset_type text,
  ADD COLUMN IF NOT EXISTS location_detail text,
  ADD COLUMN IF NOT EXISTS amount_text text,
  ADD COLUMN IF NOT EXISTS deadline_text text,
  ADD COLUMN IF NOT EXISTS publication_date text,
  ADD COLUMN IF NOT EXISTS promoted_to text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS agent_action text,
  ADD COLUMN IF NOT EXISTS owner_pitch text,
  ADD COLUMN IF NOT EXISTS investor_pitch text;

ALTER TABLE public.early_offmarket_signal_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_eosc ON public.early_offmarket_signal_candidates;
CREATE POLICY service_role_full_eosc
  ON public.early_offmarket_signal_candidates
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS eosc_status_idx ON public.early_offmarket_signal_candidates(status);
CREATE INDEX IF NOT EXISTS eosc_priority_idx ON public.early_offmarket_signal_candidates(priority_score DESC);
CREATE INDEX IF NOT EXISTS eosc_run_idx ON public.early_offmarket_signal_candidates(run_id);
