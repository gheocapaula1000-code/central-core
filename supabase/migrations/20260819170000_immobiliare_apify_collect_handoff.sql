-- Immobiliare nightly launch + collect-pending handoff on live Core
-- (jpunnzgixcghuydstdlt). No secrets in this file.
--
-- Fixes:
--   1. Unschedule the legacy 03:10 job that POSTed without x-job-secret
--      (only an anon JWT) so nightly always 401'd.
--   2. Keep portal-immobiliare-padova @ 02:00 UTC via log_cron_http_invocation
--      (sends vault CENTRAL_CORE_JOB_SECRET as x-job-secret).
--   3. Run collect-pending every 15 minutes so async Apify runs that finish
--      after 02:45 are ingested instead of staying status=RUNNING.

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'central-core-apify-immobiliare-nightly',
    'portal-immobiliare-padova',
    'portal-collect-pending'
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
  'portal-immobiliare-padova',
  '0 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-immobiliare-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-immobiliare-nightly',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'portal-collect-pending',
  '*/15 * * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-collect-pending',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-collect-pending',
      '{}'::jsonb
    );
  $cmd$
);
