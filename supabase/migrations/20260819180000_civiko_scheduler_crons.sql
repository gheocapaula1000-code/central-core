-- Real triggers for automated Civiko sources (F2/F5/F7/F10/F11/F16/F19/F21).
-- Live Core: jpunnzgixcghuydstdlt
-- Auth: log_cron_http_invocation (pg_net) sends x-job-secret = vault CENTRAL_CORE_JOB_SECRET.
-- Does not schedule Catasto (F14) or Conservatoria (F15).
-- Idempotent: unschedule then reschedule the jobs this migration owns.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'civiko-scheduler-daily',
    'civiko-scheduler-weekly',
    'connector-osm-cantieri-weekly',
    'civiko-pnrr-padova-weekly',
    'civiko-obituaries-aggregate-daily'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- Due-only pass after nightly-data-refresh-master (02:00 UTC).
-- Covers daily automated sources (F16, F19, F21) plus any overdue weekly/monthly.
SELECT cron.schedule(
  'civiko-scheduler-daily',
  '15 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'civiko-scheduler-daily',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-scheduler/run-scheduled',
      '{"due_only":true,"triggered_by":"pg_cron_scheduler_daily"}'::jsonb
    );
  $cmd$
);

-- Weekly pass (Monday 03:30 UTC) for F5/F7/F10/F11 and overdue semi-automated.
SELECT cron.schedule(
  'civiko-scheduler-weekly',
  '30 3 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'civiko-scheduler-weekly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-scheduler/run-scheduled',
      '{"due_only":true,"triggered_by":"pg_cron_scheduler_weekly"}'::jsonb
    );
  $cmd$
);

-- Dedicated F5 weekly OSM Overpass pull.
SELECT cron.schedule(
  'connector-osm-cantieri-weekly',
  '0 5 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'connector-osm-cantieri-weekly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/connector-osm-cantieri',
      '{"triggered_by":"pg_cron","source_code":"F5"}'::jsonb
    );
  $cmd$
);

-- Dedicated F11 weekly OpenPNRR pull (Padova centroid).
SELECT cron.schedule(
  'civiko-pnrr-padova-weekly',
  '15 5 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'civiko-pnrr-padova-weekly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-pnrr-padova',
      '{"lat":45.4064,"lng":11.8768,"radiusMeters":1500,"triggered_by":"pg_cron","source_code":"F11"}'::jsonb
    );
  $cmd$
);

-- Keep registry endpoints aligned with sourceScheduler.ts (no secrets).
UPDATE public.civiko_source_registry AS r
SET
  scheduler_job_name = v.job,
  ingestion_endpoint = v.endpoint,
  updated_at = now()
FROM (VALUES
  ('F2',  'istat-sdmx-fetch',              '/istat-sdmx-fetch'),
  ('F5',  'connector-osm-cantieri',        '/connector-osm-cantieri'),
  ('F7',  'civiko-radar-veneto',           '/civiko-radar-veneto/jobs/import-arpav-air-quality'),
  ('F10', 'civiko-radar-veneto',           '/civiko-radar-veneto/jobs/import-veneto-open-data'),
  ('F11', 'civiko-pnrr-padova',            '/civiko-pnrr-padova'),
  ('F16', 'civiko-radar-veneto',           '/civiko-radar-veneto/jobs/refresh-padova-auctions'),
  ('F19', 'civiko-obituaries-aggregate',   '/civiko-obituaries-aggregate'),
  ('F21', 'civiko-radar-veneto',           '/civiko-radar-veneto/jobs/deep-scan-padova')
) AS v(code, job, endpoint)
WHERE r.source_code = v.code;

-- Dedicated F19 daily aggregate obituaries (k>=3). Complements the weekly job.
SELECT cron.schedule(
  'civiko-obituaries-aggregate-daily',
  '30 4 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'civiko-obituaries-aggregate-daily',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-obituaries-aggregate',
      '{"triggered_by":"pg_cron","source_code":"F19","aggregate_only":true}'::jsonb
    );
  $cmd$
);
