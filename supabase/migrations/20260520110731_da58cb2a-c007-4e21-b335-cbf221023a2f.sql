CREATE OR REPLACE FUNCTION private.padova_daily_radar_trigger()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
  v_url    text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-daily-radar';
  v_req_id bigint;
BEGIN
  SELECT decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'central_core_job_secret'
   LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE NOTICE 'padova_daily_radar_trigger: vault secret central_core_job_secret missing — skipping';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-job-secret', v_secret
               ),
    body    := jsonb_build_object('triggered_by', 'pg_cron', 'at', now()),
    timeout_milliseconds := 300000
  )
  INTO v_req_id;

  RETURN v_req_id;
END;
$$;

REVOKE ALL ON FUNCTION private.padova_daily_radar_trigger() FROM PUBLIC;