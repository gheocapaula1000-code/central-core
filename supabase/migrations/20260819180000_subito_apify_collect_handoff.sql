-- Subito nightly/weekly launch + staging promote on live Core
-- (jpunnzgixcghuydstdlt). No secrets in this file.
--
-- Fixes:
--   1. Replace apify-subito-weekly (hardcoded anon JWT in net.http_post) with
--      vault-backed log_cron_http_invocation (x-job-secret at runtime).
--   2. Keep portal-subito-padova @ 02:20 UTC via log_cron_http_invocation.
--   3. Schedule portal-subito-promote at 02:50 and 03:50 UTC so nightly
--      (02:20) and weekly (03:30 Sunday) staging rows reach collect_v2.
--
-- Collect-pending drain is already on main (#39): portal-collect-pending-drain
-- every 15 minutes plus Apify webhooks. This migration must not unschedule
-- portal-collect-pending, portal-collect-pending-drain, or expire-stale-scrape-jobs.

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'apify-subito-weekly',
    'portal-subito-padova',
    'portal-subito-promote',
    'central-core-padova-subito-promote'
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
  'portal-subito-padova',
  '20 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-subito-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-subito-nightly',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'apify-subito-weekly',
  '30 3 * * 0',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'apify-subito-weekly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-subito-nightly',
      '{"max_items": 300}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'portal-subito-promote',
  '50 2,3 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-subito-promote',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-padova-subito-promote',
      '{}'::jsonb
    );
  $cmd$
);
