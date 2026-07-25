DO $$
DECLARE
  s text;
BEGIN
  SELECT decrypted_secret INTO s FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1;
  PERFORM net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-signals-classify',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret', s),
    body := '{"dry_run":false,"sources":["legal_life_event_signals"],"limit_per_source":500}'::jsonb,
    timeout_milliseconds := 30000
  );
  PERFORM net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-signals-classify',
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret', s),
    body := '{"dry_run":false,"sources":["territorial_signals"],"limit_per_source":1000}'::jsonb,
    timeout_milliseconds := 30000
  );
END $$;