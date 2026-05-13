CREATE TABLE IF NOT EXISTS public.api_credit_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL UNIQUE,
  warning_threshold_eur numeric NOT NULL DEFAULT 25,
  critical_threshold_eur numeric NOT NULL DEFAULT 10,
  block_threshold_eur numeric NOT NULL DEFAULT 5,
  recommended_topup_eur numeric NOT NULL DEFAULT 50,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.api_credit_thresholds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_act"
  ON public.api_credit_thresholds
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_act_provider ON public.api_credit_thresholds(provider);
