CREATE TABLE IF NOT EXISTS public.civiko_orchestrator_action_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  action text NOT NULL,
  pipeline text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean,
  status integer,
  error_code text,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.civiko_orchestrator_action_runs
  ADD CONSTRAINT civiko_orchestrator_action_runs_error_code_len
  CHECK (error_code IS NULL OR char_length(error_code) <= 120) NOT VALID;

ALTER TABLE public.civiko_orchestrator_action_runs
  ADD CONSTRAINT civiko_orchestrator_action_runs_status_range
  CHECK (status IS NULL OR (status >= 100 AND status <= 599)) NOT VALID;

GRANT ALL ON public.civiko_orchestrator_action_runs TO service_role;

ALTER TABLE public.civiko_orchestrator_action_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only_orchestrator_action_runs"
  ON public.civiko_orchestrator_action_runs;
CREATE POLICY "service_role_only_orchestrator_action_runs"
  ON public.civiko_orchestrator_action_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS civiko_orchestrator_action_runs_action_time_idx
  ON public.civiko_orchestrator_action_runs (action, started_at DESC);
CREATE INDEX IF NOT EXISTS civiko_orchestrator_action_runs_started_idx
  ON public.civiko_orchestrator_action_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS civiko_orchestrator_action_runs_run_idx
  ON public.civiko_orchestrator_action_runs (run_id);