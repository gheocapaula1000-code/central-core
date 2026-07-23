-- Compensativa di 20260723200000_cron_subito_weekly_job_secret_header.sql
-- Ripristina body '{}'::jsonb e header 'apikey' (anon key pre-esistente) nel
-- cron `apify-subito-weekly`, mantenendo l'header 'x-job-secret' letto a
-- runtime da vault.decrypted_secrets (name='central_core_job_secret').

BEGIN;

DO $$
DECLARE
  v_exists boolean;
  v_jobid  bigint;
  v_count  int;
  v_url    text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-subito-nightly';
  v_apikey text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpwdW5uemdpeGNnaHV5ZHN0ZGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzMDE1NzcsImV4cCI6MjA4Nzg3NzU3N30.aZSVcHq76DGZv0Ka_p0tdwvSSn-2TAECrgXFCrs5ECQ';
  v_new_cmd text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'vault secret central_core_job_secret missing: aborting cron update';
  END IF;

  SELECT COUNT(*) INTO v_count FROM cron.job WHERE jobname = 'apify-subito-weekly';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 cron job apify-subito-weekly, found %', v_count;
  END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'apify-subito-weekly' LIMIT 1;

  v_new_cmd := format($cmd$
    SELECT net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', %L,
        'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret' LIMIT 1)
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$, v_url, v_apikey);

  PERFORM cron.alter_job(
    job_id  => v_jobid,
    command => v_new_cmd
  );
END $$;

COMMIT;