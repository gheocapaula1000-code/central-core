DO $$
DECLARE v_req bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-contendibili-evidence-refresh',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1)
    ),
    body := '{"limit":24,"trigger":"manual-p1d-first-production"}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE 'p1d_first_production_request_id=%', v_req;
END $$;