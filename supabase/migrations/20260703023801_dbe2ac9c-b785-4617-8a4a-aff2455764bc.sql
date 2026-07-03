
SELECT cron.schedule(
  'cron-obituaries-aggregate-weekly',
  '30 4 * * 0',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-obituaries-aggregate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', current_setting('app.central_core_job_secret', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
