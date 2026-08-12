INSERT INTO public.trovabandi_refresh_requests_log_tmp(request_id)
SELECT net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'x-internal-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CENTRAL_CORE_JOB_SECRET' LIMIT 1)
  ),
  body := '{"action":"backfill_nulls","max_batch":25,"dry_run":false}'::jsonb,
  timeout_milliseconds := 300000
);