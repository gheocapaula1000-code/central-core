-- Rebuild pg_cron from scratch: portals FIRST, then official.
-- Live Core: jpunnzgixcghuydstdlt (do not use empty central-core-prod).
--
-- Tears up:
--   * mixed nightly-data-refresh-master → missing civiko-scheduler
--   * official-only jobs from the overruled ISTAT-only plan
--   * crons that do not fire a real function on this project
--
-- New jobs are simple, separate, and point at existing edge functions
-- with CENTRAL_CORE_JOB_SECRET (x-job-secret). Matcher SQL is unchanged.
-- Catasto / Conservatoria stay on-demand (no cron).

-- 1) Drop broken / leftover / official-only-only jobs
DO $$
DECLARE
  j text;
  r record;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    -- mixed master: pointed at civiko-scheduler which was not deployed
    'nightly-data-refresh-master',
    -- overruled official-only plan on this branch
    'official-data-refresh',
    'official-padova-listings-recompute',
    -- leftover QA (every minute)
    'qa-oneshot-classify',
    'qa-oneshot-snapshot',
    'qa-oneshot-nightly',
    'qa-oneshot-enqueue',
    -- wrong project (vault CRON_REFRESH_PORTALI_URL → nmlofzmubwugvxcztjqv radar-cron)
    'civiko-refresh-portali-notte',
    'civiko-refresh-portali-mattina',
    'civiko-refresh-portali-pomeriggio',
    'civiko-refresh-domenica-full',
    'civiko-one-leads-soft-0400',
    'civiko-one-leads-soft-1100',
    'civiko-one-leads-soft-1530',
    'civiko-one-leads-full-weekly',
    -- existing portal jobs that do not actually auth / mix all portals
    'central-core-apify-immobiliare-nightly',
    'padova-portal-scrapes-full',
    'padova-portal-scrapes-soft',
    -- stale recompute that called recompute_padova_contendibili()
    'central-core-padova-contendibili-recompute',
    'padova-contendibili-recompute',
    -- rebuild targets (idempotent reschedule)
    'portal-immobiliare-padova',
    'portal-idealista-padova',
    'portal-subito-padova',
    'portal-casa-padova',
    'portal-collect-pending',
    'padova-listings-contendibili-recompute',
    'official-istat-sdmx',
    'official-civici-ingest',
    'official-civici-resolve-omi',
    'official-osm-cantieri'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  FOR r IN SELECT jobid FROM cron.job WHERE jobname LIKE 'qa-oneshot-%' LOOP
    BEGIN
      PERFORM cron.unschedule(r.jobid);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- PORTALS FIRST (Padova). Fail-closed. Must be scheduled.
-- Write padova_listings when the source responds.
-- Casa.it historically 0/120: still a real job; empty is not success.
-- ═══════════════════════════════════════════════════════════════

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
  'portal-casa-padova',
  '30 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-casa-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-casa-nightly',
      '{}'::jsonb
    );
  $cmd$
);

-- Promotes async Apify runs into padova_listings
SELECT cron.schedule(
  'portal-collect-pending',
  '45 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-collect-pending',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-collect-pending',
      '{}'::jsonb
    );
  $cmd$
);

-- Matcher recompute after portal ingest. via+civico, 40m, pHash, aste out.
SELECT cron.schedule(
  'padova-listings-contendibili-recompute',
  '15 3 * * *',
  $cmd$
  DO $body$
  DECLARE
    v_log_id bigint;
    v_r jsonb;
    v_started timestamptz := now();
  BEGIN
    INSERT INTO public.cron_executions_log (job_name, status, triggered_at)
    VALUES ('padova-listings-contendibili-recompute', 'started', v_started)
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

-- ═══════════════════════════════════════════════════════════════
-- OFFICIAL — separate jobs, not mixed into the portal runner.
-- ═══════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'official-istat-sdmx',
  '0 4 1 * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-istat-sdmx',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/istat-sdmx-fetch',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'official-civici-ingest',
  '0 4 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-civici-ingest',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-civici-ingest?action=ingest',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'official-civici-resolve-omi',
  '30 4 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-civici-resolve-omi',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/padova-civici-ingest?action=resolve_omi',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'official-osm-cantieri',
  '0 5 * * 1',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-osm-cantieri',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/connector-osm-cantieri',
      '{}'::jsonb
    );
  $cmd$
);

COMMENT ON FUNCTION public.recompute_padova_listings_contendibili() IS
  'Padova matcher: via+civico, 40m grid, pHash, auctions out. 2+ agencies = contendibile; 3+ = caldo/HOT display. Runs after portal ingest via padova-listings-contendibili-recompute.';
