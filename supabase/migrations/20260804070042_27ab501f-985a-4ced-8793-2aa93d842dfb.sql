select net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-apify-idealista-collect',
  headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(select decrypted_secret from vault.decrypted_secrets where name='CENTRAL_CORE_JOB_SECRET')),
  body := '{"mode":"discovery","desired_results":10,"max_items":10,"wait_seconds":180,"async_start":false,"cost_cap_usd":0.5,"dry_run":true}'::jsonb,
  timeout_milliseconds := 30000
) as request_id;