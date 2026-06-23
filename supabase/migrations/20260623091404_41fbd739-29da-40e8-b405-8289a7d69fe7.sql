CREATE TABLE IF NOT EXISTS public.radar_budget_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text,
  request_id text,
  source text,
  target text,
  triggered_by text,
  mode text,
  intent text,
  scope text,
  provider text NOT NULL,
  api_name text,
  operation text,
  calls_count integer NOT NULL DEFAULT 1,
  items_processed integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  compute_units numeric NOT NULL DEFAULT 0,
  proxy_gb numeric NOT NULL DEFAULT 0,
  estimated_cost_eur numeric NOT NULL DEFAULT 0,
  estimated_cost_usd numeric NOT NULL DEFAULT 0,
  cost_basis text NOT NULL DEFAULT 'estimate',
  budget_mode text,
  month_key text NOT NULL,
  week_key text NOT NULL,
  day_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.radar_budget_ledger TO authenticated;
GRANT ALL ON public.radar_budget_ledger TO service_role;

ALTER TABLE public.radar_budget_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read radar_budget_ledger" ON public.radar_budget_ledger;
CREATE POLICY "Admins read radar_budget_ledger"
ON public.radar_budget_ledger
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE INDEX IF NOT EXISTS idx_radar_budget_ledger_month ON public.radar_budget_ledger(month_key);
CREATE INDEX IF NOT EXISTS idx_radar_budget_ledger_week ON public.radar_budget_ledger(week_key);
CREATE INDEX IF NOT EXISTS idx_radar_budget_ledger_day ON public.radar_budget_ledger(day_key);
CREATE INDEX IF NOT EXISTS idx_radar_budget_ledger_run ON public.radar_budget_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_radar_budget_ledger_provider ON public.radar_budget_ledger(provider);
CREATE INDEX IF NOT EXISTS idx_radar_budget_ledger_created ON public.radar_budget_ledger(created_at DESC);

CREATE OR REPLACE VIEW public.radar_budget_monthly_spend AS
SELECT
  month_key,
  COALESCE(SUM(estimated_cost_eur), 0)::numeric AS spent_eur,
  COALESCE(SUM(estimated_cost_usd), 0)::numeric AS spent_usd,
  COUNT(*)::bigint AS entries,
  COUNT(DISTINCT run_id)::bigint AS runs
FROM public.radar_budget_ledger
GROUP BY month_key;

GRANT SELECT ON public.radar_budget_monthly_spend TO service_role;