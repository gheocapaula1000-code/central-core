-- Drain pending Apify runs more than once a day.
-- Nightly portal jobs start at 02:00–02:30 UTC with async_start; actors often
-- finish after the 02:45 collect-pending tick. A 15-minute drain plus webhooks
-- lets SUCCEEDED datasets get ingested instead of leaving last_scrape_status
-- stuck on running.
-- Existing wrappers only. No secrets inlined.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'portal-collect-pending-drain') THEN
    PERFORM cron.unschedule('portal-collect-pending-drain');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'portal-collect-pending-drain',
  '*/15 * * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-collect-pending-drain',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-collect-pending',
      jsonb_build_object(
        'stale_minutes', 2,
        'max_runs', 20,
        'max_items_per_run', 10000,
        'drain_wait_seconds', 40
      )
    );
  $cmd$
);
