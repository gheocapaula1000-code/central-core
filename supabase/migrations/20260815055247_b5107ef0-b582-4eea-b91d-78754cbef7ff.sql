SELECT net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-radar-padova-nightly?mode=soft&force=1',
  headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1)),
  body := '{}'::jsonb,
  timeout_milliseconds := 300000
) AS soft_run_id;