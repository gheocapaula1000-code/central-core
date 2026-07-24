BEGIN;

DO $$
DECLARE
  v_exists boolean;
  v_url    text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/enqueue-padova-portal-scrapes';
  v_apikey text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpwdW5uemdpeGNnaHV5ZHN0ZGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDE1NzcsImV4cCI6MjA4Nzg3NzU3N30.aZSVcHq76DGZv0Ka_p0tdwvSSn-2TAECrgXFCrs5ECQ';
  v_existing bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'vault secret central_core_job_secret missing: aborting';
  END IF;

  -- Idempotenza: rimuovi eventuali job omonimi preesistenti
  FOR v_existing IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('padova-portal-scrapes-full','padova-portal-scrapes-soft')
  LOOP
    PERFORM cron.unschedule(v_existing);
  END LOOP;

  PERFORM cron.schedule(
    'padova-portal-scrapes-full',
    '40 2 * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', %L,
          'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret' LIMIT 1)
        ),
        body := '{"mode":"full"}'::jsonb,
        timeout_milliseconds := 60000
      ) AS request_id;
    $cmd$, v_url, v_apikey)
  );

  PERFORM cron.schedule(
    'padova-portal-scrapes-soft',
    '0 10 * * 1-5',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', %L,
          'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret' LIMIT 1)
        ),
        body := '{"mode":"soft"}'::jsonb,
        timeout_milliseconds := 60000
      ) AS request_id;
    $cmd$, v_url, v_apikey)
  );
END $$;

COMMIT;