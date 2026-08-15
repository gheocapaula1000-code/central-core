SELECT net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-detail-enrich-collect',
  headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1)),
  body := '{"since_hours":48,"limit":15,"dry_run":true}'::jsonb,
  timeout_milliseconds := 120000
) AS dry_id;