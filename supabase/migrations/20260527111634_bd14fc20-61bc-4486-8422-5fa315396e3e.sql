
ALTER TABLE public.openapi_it_call_log
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS real_cost_eur NUMERIC(10,4) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_openapi_it_call_log_env
  ON public.openapi_it_call_log (environment, created_at DESC);
