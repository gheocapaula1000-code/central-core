-- Audit orchestratore Civiko: colonne canoniche tracciabili, unicità tentativo,
-- e tabella di avanzamento deterministico della certificazione fotografica.
-- Additiva: nessun DELETE/DROP di dati.

ALTER TABLE public.civiko_orchestrator_action_runs
  ADD COLUMN IF NOT EXISTS pipeline_action text,
  ADD COLUMN IF NOT EXISTS attempt_no integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS target text,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS result jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS duration_ms integer;

-- Alias legacy compatibili: pipeline resta popolata, pipeline_action è il nome canonico.
UPDATE public.civiko_orchestrator_action_runs
   SET pipeline_action = COALESCE(pipeline_action, pipeline),
       http_status     = COALESCE(http_status, status)
 WHERE pipeline_action IS NULL OR http_status IS NULL;

ALTER TABLE public.civiko_orchestrator_action_runs
  DROP CONSTRAINT IF EXISTS civiko_orch_action_runs_attempt_no_range;
ALTER TABLE public.civiko_orchestrator_action_runs
  ADD CONSTRAINT civiko_orch_action_runs_attempt_no_range
  CHECK (attempt_no >= 1 AND attempt_no <= 64) NOT VALID;

-- Finalizzazione via upsert deterministico: un tentativo per (run, azione, n).
CREATE UNIQUE INDEX IF NOT EXISTS civiko_orch_action_runs_attempt_uniq
  ON public.civiko_orchestrator_action_runs (pipeline_run_id, action, attempt_no)
  WHERE pipeline_run_id IS NOT NULL;

GRANT ALL ON public.civiko_orchestrator_action_runs TO service_role;

-- ── Avanzamento deterministico della certificazione fotografica ─────────────
CREATE TABLE IF NOT EXISTS public.civiko_image_certify_attempts (
  listing_id bigint PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  last_pipeline_run_id uuid,
  last_outcome text,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS civiko_image_certify_attempts_run_idx
  ON public.civiko_image_certify_attempts (last_pipeline_run_id, last_attempt_at DESC);
CREATE INDEX IF NOT EXISTS civiko_image_certify_attempts_progress_idx
  ON public.civiko_image_certify_attempts (attempts, listing_id);

GRANT ALL ON public.civiko_image_certify_attempts TO service_role;
ALTER TABLE public.civiko_image_certify_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_only_image_certify_attempts
  ON public.civiko_image_certify_attempts;
CREATE POLICY service_role_only_image_certify_attempts
  ON public.civiko_image_certify_attempts
  TO service_role USING (true) WITH CHECK (true);