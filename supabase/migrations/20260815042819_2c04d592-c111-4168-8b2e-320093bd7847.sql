select net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/activate-veneto',
  headers := jsonb_build_object('Content-Type','application/json','x-job-secret',(select decrypted_secret from vault.decrypted_secrets where name='CENTRAL_CORE_JOB_SECRET' limit 1),'x-internal-secret',(select decrypted_secret from vault.decrypted_secrets where name='CENTRAL_CORE_JOB_SECRET' limit 1),'x-source-app','central-core-cron'),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
) as request_id;