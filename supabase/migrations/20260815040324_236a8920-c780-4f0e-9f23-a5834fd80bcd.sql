select net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-radar-padova-nightly?mode=soft&force=1',
  headers := jsonb_build_object('Content-Type','application/json','x-job-secret', (select decrypted_secret from vault.decrypted_secrets where name='CENTRAL_CORE_JOB_SECRET' limit 1)),
  body := '{}'::jsonb,
  timeout_milliseconds := 240000
) as request_id;