CREATE OR REPLACE FUNCTION public.test_radar_cron_post()
RETURNS TABLE(request_id bigint, status_code int, content_excerpt text, error_msg text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net, extensions
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_req bigint;
  v_status int;
  v_content text;
  v_error text;
  v_tries int := 0;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'CRON_REFRESH_PORTALI_URL';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret';

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := '{"mode":"normal","trigger":"manual-test-post-fix","comuni":["Padova"]}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;

  -- Poll for response up to ~65 s
  LOOP
    v_tries := v_tries + 1;
    SELECT r.status_code, left(r.content::text, 500), r.error_msg
      INTO v_status, v_content, v_error
      FROM net._http_response r
      WHERE r.id = v_req;
    EXIT WHEN v_status IS NOT NULL OR v_error IS NOT NULL OR v_tries > 65;
    PERFORM pg_sleep(1);
  END LOOP;

  RETURN QUERY SELECT v_req, v_status, v_content, v_error;
END;
$$;

REVOKE ALL ON FUNCTION public.test_radar_cron_post() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.test_radar_cron_post() TO service_role;