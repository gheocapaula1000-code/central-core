DO $$
BEGIN
  PERFORM cron.unschedule('padova-successioni');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'padova-successioni',
  '45 4 * * *',
  $c$ SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-successioni',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)
    ),
    body := '{"triggered_by":"pg_cron","aggregate_only":true,"min_group_size":3}'::jsonb,
    timeout_milliseconds := 60000
  ); $c$
);