-- Smallest official cron: ISTAT SDMX monthly only.
-- Live Core: jpunnzgixcghuydstdlt
-- POSTs existing istat-sdmx-fetch. Does not stand up civiko-scheduler.
-- Does not schedule portals, Catasto, Conservatoria, civici, or OSM.

-- Idempotent: drop this-branch official-pipeline drafts, then add ISTAT only.
-- Does not touch existing Immobiliare / Idealista / Subito / Casa.it crons.
DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'official-data-refresh',
    'official-padova-listings-recompute',
    'official-istat-sdmx',
    'official-civici-ingest',
    'official-civici-resolve-omi',
    'official-osm-cantieri',
    'istat-sdmx-monthly'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- Monthly ISTAT. log_cron_http_invocation sends x-job-secret =
-- vault CENTRAL_CORE_JOB_SECRET. The function also accepts
-- x-internal-secret + x-source-app=civiko (requireSecret).
SELECT cron.schedule(
  'istat-sdmx-monthly',
  '0 4 1 * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'istat-sdmx-monthly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/istat-sdmx-fetch',
      '{}'::jsonb
    );
  $cmd$
);
