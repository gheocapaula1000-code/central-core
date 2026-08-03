DO $$
DECLARE s text; rid bigint;
BEGIN
  SELECT decrypted_secret INTO s FROM vault.decrypted_secrets WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-contendibili-evidence-refresh',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret', s),
    body := '{"limit":24}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO rid;
  RAISE NOTICE 'request %', rid;
END $$;