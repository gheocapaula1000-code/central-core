-- Separate Class A official ingest from Class C portal scrapers.
-- The mixed nightly-data-refresh-master invoked civiko-scheduler with every
-- due source, including F21 portals. Portal antibot failures must not gate
-- official ingest or the Padova matcher recompute.
--
-- Live Core: jpunnzgixcghuydstdlt
-- Paid on-demand registries stay unscheduled.
-- Portal scrapers are not rewritten and are not invoked by these jobs.

-- 1) Replace the mixed master with an official-only runner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-data-refresh-master') THEN
    PERFORM cron.unschedule('nightly-data-refresh-master');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'official-data-refresh') THEN
    PERFORM cron.unschedule('official-data-refresh');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'official-data-refresh',
  '0 1 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-data-refresh',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-scheduler/run-scheduled',
      '{"due_only":true,"pipeline_class":"A","triggered_by":"pg_cron_official"}'::jsonb
    );
  $cmd$
);

-- 2) Dedicated matcher recompute. Uses existing padova_listings + official
--    anchors (via+civico, 40m grid, pHash, auctions out). Does not wait for
--    Immobiliare / Idealista / Subito / Casa.it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'official-padova-listings-recompute') THEN
    PERFORM cron.unschedule('official-padova-listings-recompute');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'official-padova-listings-recompute',
  '30 1 * * *',
  $cmd$
  DO $body$
  DECLARE
    v_log_id bigint;
    v_r jsonb;
    v_started timestamptz := now();
  BEGIN
    INSERT INTO public.cron_executions_log (job_name, status, triggered_at)
    VALUES ('official-padova-listings-recompute', 'started', v_started)
    RETURNING id INTO v_log_id;
    BEGIN
      PERFORM set_config('statement_timeout', '600s', true);
      v_r := public.recompute_padova_listings_contendibili();
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

COMMENT ON FUNCTION public.recompute_padova_listings_contendibili() IS
  'Padova matcher: via+civico, 40m grid, pHash, auctions out. 2+ agencies = contendibile; 3+ = caldo/HOT display. Official recompute cron does not depend on portal scrape success.';
