-- Idealista nightly launch on live Core (jpunnzgixcghuydstdlt).
-- No secrets in this file.
--
-- Keeps portal-idealista-padova @ 02:10 UTC via log_cron_http_invocation
-- (sends vault CENTRAL_CORE_JOB_SECRET as x-job-secret).
-- Does not reschedule the collect drain or scrape-job watchdog already on main.

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'central-core-apify-idealista-nightly',
    'portal-idealista-padova'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

SELECT cron.schedule(
  'portal-idealista-padova',
  '10 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-idealista-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-idealista-nightly',
      '{}'::jsonb
    );
  $cmd$
);
