DO $$
DECLARE v_secret text; v_base text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/';
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CENTRAL_CORE_JOB_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN RAISE EXCEPTION 'job_secret_missing'; END IF;

  PERFORM net.http_post(
    url := v_base || 'padova-apify-casa-collect',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',v_secret),
    body := jsonb_build_object('max_items',20,'async_start',true),
    timeout_milliseconds := 55000
  );

  PERFORM net.http_post(
    url := v_base || 'enqueue-padova-portal-scrapes',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret',v_secret),
    body := jsonb_build_object('mode','soft','max_pages',1,'portals',jsonb_build_array('bakeca.it')),
    timeout_milliseconds := 55000
  );
END $$;