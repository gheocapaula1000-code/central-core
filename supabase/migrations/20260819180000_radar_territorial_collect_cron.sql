-- Schedule territorial collectors on live Core (jpunnzgixcghuydstdlt).
-- F7 ARPAV weekly, F10 ANAC CKAN weekly, F16 aste daily.
-- log_cron_http_invocation sends x-job-secret = vault CENTRAL_CORE_JOB_SECRET.
-- Body forces persist (dryRun=false, import=true). No secret values in SQL.

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'central-core-radar-arpav-weekly',
    'central-core-radar-ckan-weekly',
    'central-core-radar-aste-daily'
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
  'central-core-radar-arpav-weekly',
  '20 4 * * 0',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-radar-arpav-weekly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/import-arpav-air-quality',
      '{"dryRun":false,"import":true,"triggered_by":"pg_cron","province":["PD"]}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'central-core-radar-ckan-weekly',
  '35 4 * * 0',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-radar-ckan-weekly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/anac-ckan',
      '{"dryRun":false,"import":true,"triggered_by":"pg_cron","province":["PD"]}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'central-core-radar-aste-daily',
  '10 4 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'central-core-radar-aste-daily',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/asteGiudiziarie',
      '{"dryRun":false,"import":true,"triggered_by":"pg_cron","province":["PD"]}'::jsonb
    );
  $cmd$
);
