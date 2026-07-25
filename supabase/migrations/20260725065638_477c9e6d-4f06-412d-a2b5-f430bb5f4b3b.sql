DO $$
DECLARE
  req_id bigint;
  secret text;
BEGIN
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'CENTRAL_CORE_JOB_SECRET' LIMIT 1;
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-property-signals-match',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',secret),
    body := jsonb_build_object('dry_run', true, 'properties_limit', 500),
    timeout_milliseconds := 150000
  ) INTO req_id;
  RAISE NOTICE 'req_id=%', req_id;
END $$;
SELECT max(id) AS last_req FROM net.http_request_queue;