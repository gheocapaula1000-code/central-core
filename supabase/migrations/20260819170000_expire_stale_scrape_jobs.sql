-- Watchdog: open scrape/cron rows cannot stay running forever.
-- public-padova-meta-stats maps running/started/in_progress/queued → "running"
-- and collectors skip while a lock row is open. No HTTP, no secrets.

CREATE OR REPLACE FUNCTION public.expire_stale_scrape_jobs(
  p_timeout_seconds integer DEFAULT 14400
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_apify integer := 0;
  v_firecrawl integer := 0;
  v_cron integer := 0;
  v_cutoff timestamptz;
BEGIN
  IF p_timeout_seconds IS NULL OR p_timeout_seconds < 60 THEN
    p_timeout_seconds := 14400;
  END IF;
  v_cutoff := now() - make_interval(secs => p_timeout_seconds);

  UPDATE public.padova_apify_runs
     SET status = 'FAILED',
         error = 'watchdog_timeout',
         finished_at = now()
   WHERE lower(status) IN ('running', 'ready', 'started', 'in_progress', 'queued')
     AND started_at < v_cutoff;
  GET DIAGNOSTICS v_apify = ROW_COUNT;

  UPDATE public.padova_firecrawl_jobs
     SET status = 'failed',
         last_error = 'watchdog_timeout',
         finished_at = now(),
         updated_at = now()
   WHERE lower(status) IN ('running', 'ready', 'started', 'in_progress', 'queued')
     AND updated_at < v_cutoff;
  GET DIAGNOSTICS v_firecrawl = ROW_COUNT;

  UPDATE public.cron_executions_log
     SET status = 'failure',
         completed_at = COALESCE(completed_at, now()),
         error_message = COALESCE(NULLIF(error_message, ''), 'watchdog_timeout')
   WHERE status = 'started'
     AND triggered_at < v_cutoff;
  GET DIAGNOSTICS v_cron = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'apify', v_apify,
    'firecrawl', v_firecrawl,
    'cron_log', v_cron,
    'timeout_seconds', p_timeout_seconds,
    'cutoff', v_cutoff
  );
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_scrape_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_scrape_jobs(integer) TO service_role;

DO $$
DECLARE
  j text := 'expire-stale-scrape-jobs';
BEGIN
  BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

SELECT cron.schedule(
  'expire-stale-scrape-jobs',
  '*/15 * * * *',
  $cmd$
  DO $body$
  DECLARE
    v_log_id bigint;
    v_r jsonb;
    v_started timestamptz := now();
  BEGIN
    INSERT INTO public.cron_executions_log (job_name, status, triggered_at)
    VALUES ('expire-stale-scrape-jobs', 'started', v_started)
    RETURNING id INTO v_log_id;
    BEGIN
      v_r := public.expire_stale_scrape_jobs();
      UPDATE public.cron_executions_log
         SET status = 'success',
             completed_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
             response_excerpt = LEFT(COALESCE(v_r::text, ''), 4000)
       WHERE id = v_log_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.cron_executions_log
         SET status = 'failure',
             completed_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
             error_message = LEFT(COALESCE(SQLSTATE, '') || ' ' || COALESCE(SQLERRM, ''), 4000)
       WHERE id = v_log_id;
    END;
  END;
  $body$;
  $cmd$
);
