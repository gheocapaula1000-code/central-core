-- Add missing crons (padova-successioni 04:45 already exists)
SELECT cron.schedule(
  'padova-daily-radar',
  '0 4 * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-daily-radar',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)),
    body := '{"triggered_by":"pg_cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

SELECT cron.schedule(
  'refresh-padova-auctions',
  '15 4 * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/refresh-padova-auctions',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)),
    body := '{"triggered_by":"pg_cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

SELECT cron.schedule(
  'build-padova-early-warning',
  '35 4 * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/build-padova-early-warning',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)),
    body := '{"triggered_by":"pg_cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- Trigger immediate backfill of civiko_evidence (idempotent)
DO $$
DECLARE
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'diagnostic_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'DIAGNOSTIC_SECRET' LIMIT 1;
  END IF;
  IF v_secret IS NULL THEN
    RAISE NOTICE 'diagnostic_secret missing — skipping immediate backfill';
  ELSE
    PERFORM net.http_post(
      url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-force-backfill',
      headers := jsonb_build_object('Content-Type','application/json','x-diagnostic-secret',v_secret),
      body := '{"triggered_by":"manual_kickoff"}'::jsonb,
      timeout_milliseconds := 120000
    );
  END IF;
END $$;