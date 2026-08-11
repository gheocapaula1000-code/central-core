select net.http_post(
  url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'CENTRAL_CORE_JOB_SECRET' limit 1)
  ),
  body := '{"action":"backfill_nulls","max_batch":10,"dry_run":false}'::jsonb,
  timeout_milliseconds := 150000
);