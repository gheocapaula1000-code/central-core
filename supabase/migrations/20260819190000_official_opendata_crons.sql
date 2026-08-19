-- Official / open-data collection crons on live Core (jpunnzgixcghuydstdlt).
-- F2 ISTAT SDMX (already scheduled monthly) + demografia follow-on,
-- F5 OSM cantieri, F11 OpenPNRR, F19 obituaries aggregate.
-- Functions write last_error / record_count on civiko_source_registry.
-- Does not stand up civiko-scheduler. Does not schedule Catasto / Conservatoria.

-- Longer timeout for Overpass / Firecrawl / SDMX jobs.
CREATE OR REPLACE FUNCTION public.log_cron_http_invocation(
  p_job_name text,
  p_url text,
  p_body jsonb DEFAULT '{}'::jsonb,
  p_timeout_ms integer DEFAULT 120000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_secret TEXT;
  v_request_id BIGINT;
  v_log_id BIGINT;
  v_timeout INTEGER;
BEGIN
  INSERT INTO public.cron_executions_log (job_name, status)
  VALUES (p_job_name, 'started')
  RETURNING id INTO v_log_id;

  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'CENTRAL_CORE_JOB_SECRET'
    LIMIT 1;

    IF v_secret IS NULL OR length(v_secret) = 0 THEN
      RAISE EXCEPTION 'job secret not configured';
    END IF;

    v_timeout := GREATEST(COALESCE(p_timeout_ms, 120000), 5000);

    SELECT net.http_post(
      url := p_url,
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-job-secret', v_secret
      ),
      body := p_body,
      timeout_milliseconds := v_timeout
    ) INTO v_request_id;

    UPDATE public.cron_executions_log
       SET status = 'success',
           http_request_id = v_request_id,
           completed_at = now(),
           duration_ms = EXTRACT(MILLISECOND FROM (now() - triggered_at))::int
     WHERE id = v_log_id;

    RETURN v_log_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.cron_executions_log
       SET status = 'failure',
           error_message = SQLERRM,
           completed_at = now(),
           duration_ms = EXTRACT(MILLISECOND FROM (now() - triggered_at))::int
     WHERE id = v_log_id;
    RETURN v_log_id;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.log_cron_http_invocation(TEXT, TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_cron_http_invocation(TEXT, TEXT, JSONB, INTEGER) TO service_role, postgres;
-- 3-arg overload remains granted from earlier migrations.

-- Point F19 at the real collector (civiko-source-registry edge fn does not exist).
UPDATE public.civiko_source_registry
SET
  scheduler_job_name = 'civiko-obituaries-aggregate',
  ingestion_endpoint = '/civiko-obituaries-aggregate'
WHERE source_code = 'F19';

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'official-osm-cantieri',
    'official-pnrr-padova',
    'official-obituaries-aggregate',
    'istat-demografia-monthly',
    'cron-obituaries-aggregate-weekly'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- F2 follow-on: demographic signals from istat_comuni (after monthly SDMX).
SELECT cron.schedule(
  'istat-demografia-monthly',
  '0 5 1 * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'istat-demografia-monthly',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/connector-istat-demografia',
      '{"triggered_by":"pg_cron"}'::jsonb,
      120000
    );
  $cmd$
);

-- F5 weekly Overpass (Monday 04:30 UTC).
SELECT cron.schedule(
  'official-osm-cantieri',
  '30 4 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-osm-cantieri',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/connector-osm-cantieri',
      '{"triggered_by":"pg_cron"}'::jsonb,
      300000
    );
  $cmd$
);

-- F11 weekly OpenPNRR (Monday 05:00 UTC). Function defaults to Padova centro.
SELECT cron.schedule(
  'official-pnrr-padova',
  '0 5 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-pnrr-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-pnrr-padova',
      '{"lat":45.4064,"lng":11.8768,"radiusMeters":15000,"triggered_by":"pg_cron"}'::jsonb,
      120000
    );
  $cmd$
);

-- F19 daily aggregate-only obituaries (04:30 UTC).
SELECT cron.schedule(
  'official-obituaries-aggregate',
  '30 4 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-obituaries-aggregate',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-obituaries-aggregate',
      '{"triggered_by":"pg_cron"}'::jsonb,
      300000
    );
  $cmd$
);
