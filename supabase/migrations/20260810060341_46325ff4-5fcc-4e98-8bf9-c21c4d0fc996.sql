select cron.schedule(
  'trovabandi-collect-supabase',
  '*/20 * * * *',
  $cron$
  select net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'CENTRAL_CORE_JOB_SECRET' limit 1)
    ),
    body := '{"action":"collect","max_pages":2,"trigger_source":"supabase-cron"}'::jsonb,
    timeout_milliseconds := 180000
  );
  $cron$
);