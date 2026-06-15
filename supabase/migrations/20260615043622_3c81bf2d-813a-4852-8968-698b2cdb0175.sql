DO $$
DECLARE
  v_secret TEXT;
  v_req_id BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'central_core_job_secret not in vault';
  END IF;
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-apify-multi-launch',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret', v_secret),
    body := jsonb_build_object(
      'idealista', jsonb_build_object('from_db', true, 'max_urls', 2000, 'cost_cap_usd', 3.0),
      'casa_full', jsonb_build_object('search_location', 'Padova', 'max_results', 2000, 'cost_cap_usd', 3.0),
      'subito_full', jsonb_build_object('cost_cap_usd', 3.0, 'max_items', 2000)
    ),
    timeout_milliseconds := 60000
  ) INTO v_req_id;
  RAISE NOTICE 'http request id: %', v_req_id;
END $$;