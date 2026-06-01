-- Cron execution health log + nightly master orchestrator
CREATE TABLE IF NOT EXISTS public.cron_executions_log (
  id BIGSERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','success','failure')),
  http_request_id BIGINT,
  http_status INT,
  response_excerpt TEXT,
  error_message TEXT,
  duration_ms INT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_executions_log_job_time
  ON public.cron_executions_log (job_name, triggered_at DESC);

GRANT SELECT ON public.cron_executions_log TO authenticated;
GRANT ALL ON public.cron_executions_log TO service_role;

ALTER TABLE public.cron_executions_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read cron log" ON public.cron_executions_log;
CREATE POLICY "Admins can read cron log"
  ON public.cron_executions_log
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Helper: POST to an edge function and log the queued request id
CREATE OR REPLACE FUNCTION public.log_cron_http_invocation(
  p_job_name TEXT,
  p_url TEXT,
  p_body JSONB DEFAULT '{}'::jsonb
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net, vault
AS $fn$
DECLARE
  v_secret TEXT;
  v_request_id BIGINT;
  v_log_id BIGINT;
BEGIN
  INSERT INTO public.cron_executions_log (job_name, status)
  VALUES (p_job_name, 'started')
  RETURNING id INTO v_log_id;

  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'central_core_job_secret'
    LIMIT 1;

    SELECT net.http_post(
      url := p_url,
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-job-secret', COALESCE(v_secret,'')
      ),
      body := p_body,
      timeout_milliseconds := 120000
    ) INTO v_request_id;

    UPDATE public.cron_executions_log
       SET status = 'success',
           http_request_id = v_request_id,
           completed_at = now(),
           duration_ms = EXTRACT(MILLISECOND FROM (now() - triggered_at))::int
     WHERE id = v_log_id;

    RETURN v_log_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.cron_executions_log
       SET status = 'failure',
           error_message = SQLERRM,
           completed_at = now(),
           duration_ms = EXTRACT(MILLISECOND FROM (now() - triggered_at))::int
     WHERE id = v_log_id;
    RETURN v_log_id;
  END;
END;
$fn$;

-- Master nightly orchestrator: runs civiko-scheduler at 04:00 local (Europe/Rome = 02:00 UTC)
DO $$ BEGIN
  PERFORM cron.unschedule('nightly-data-refresh-master');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'nightly-data-refresh-master',
  '0 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'nightly-data-refresh-master',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-scheduler/run-scheduled',
      '{"due_only":true,"triggered_by":"pg_cron_nightly_master"}'::jsonb
    );
  $cmd$
);