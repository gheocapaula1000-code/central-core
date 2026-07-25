-- One-shot invocation for civiko-property-signals-match (dry_run test)
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT cron.schedule(
    'civiko-property-signals-match-oneshot-test',
    '* * * * *',
    $cron$
    SELECT net.http_post(
      url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-property-signals-match',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret')
      ),
      body := '{"dry_run": true, "properties_limit": 100}'::jsonb,
      timeout_milliseconds := 120000
    );
    -- self-unschedule
    SELECT cron.unschedule('civiko-property-signals-match-oneshot-test');
    $cron$
  ) INTO v_jobid;
  RAISE NOTICE 'scheduled oneshot as job %', v_jobid;
END $$;