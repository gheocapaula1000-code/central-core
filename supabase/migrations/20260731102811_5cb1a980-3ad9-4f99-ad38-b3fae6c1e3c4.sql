-- Fix chirurgico: nome secret Vault errato ('central_core_job_secret' minuscolo, inesistente)
-- -> header x-job-secret vuoto/NULL -> endpoint rispondono 401.

CREATE OR REPLACE FUNCTION public.log_cron_http_invocation(
  p_job_name text,
  p_url text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    WHERE name = 'CENTRAL_CORE_JOB_SECRET'
    LIMIT 1;

    -- fail-closed: nessun fallback permissivo, nessun secret vuoto inviato
    IF v_secret IS NULL OR length(v_secret) = 0 THEN
      RAISE EXCEPTION 'job secret not configured';
    END IF;

    SELECT net.http_post(
      url := p_url,
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-job-secret', v_secret
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

-- Ripianifica SOLO i due job con comando inline errato (idempotente)
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid, jobname FROM cron.job
           WHERE jobname IN ('civiko-private-leads-nightly','padova-portal-scrapes-full')
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END
$do$;

SELECT cron.schedule(
  'civiko-private-leads-nightly',
  '25 2 * * *',
  $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CIVIKO_PRIVATE_LEADS_URL' LIMIT 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1)
    ),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

SELECT cron.schedule(
  'padova-portal-scrapes-full',
  '40 2 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/enqueue-padova-portal-scrapes',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1)
    ),
    body := '{"mode":"full"}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $job$
);
