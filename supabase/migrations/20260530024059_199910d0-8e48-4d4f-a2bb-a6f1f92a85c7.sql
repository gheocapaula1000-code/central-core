DO $$
DECLARE
  v_secret text;
  v_base   text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/';
  v_paths  text[] := ARRAY['padova-daily-radar','padova-successioni','refresh-padova-auctions','build-padova-early-warning'];
  p text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'central_core_job_secret not in vault';
  END IF;
  FOREACH p IN ARRAY v_paths LOOP
    PERFORM net.http_post(
      url := v_base || p,
      headers := jsonb_build_object('Content-Type','application/json','x-job-secret',v_secret),
      body := '{"triggered_by":"manual_kickoff"}'::jsonb,
      timeout_milliseconds := 120000
    );
  END LOOP;
END $$;