ALTER TABLE public.civiko_orchestrator_action_runs
  ADD COLUMN IF NOT EXISTS pipeline_run_id uuid;

UPDATE public.civiko_orchestrator_action_runs
   SET pipeline_run_id = run_id
 WHERE pipeline_run_id IS NULL;

CREATE INDEX IF NOT EXISTS civiko_orch_action_runs_pipeline_run_idx
  ON public.civiko_orchestrator_action_runs (pipeline_run_id, started_at DESC);

ALTER TABLE public.civiko_pipeline_runs
  ADD COLUMN IF NOT EXISTS pipeline_run_id uuid;

UPDATE public.civiko_pipeline_runs
   SET pipeline_run_id = run_id
 WHERE pipeline_run_id IS NULL;

CREATE INDEX IF NOT EXISTS civiko_pipeline_runs_pipeline_started_idx
  ON public.civiko_pipeline_runs (pipeline, started_at DESC);