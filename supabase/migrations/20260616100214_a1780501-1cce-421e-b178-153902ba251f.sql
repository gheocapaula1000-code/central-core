-- =====================================================================
-- Cleanup cronjob ridondanti (audit 2026-06-16)
-- ---------------------------------------------------------------------
-- Spegnimento dei trigger temporali duplicati ormai coperti dal master
-- 'nightly-data-refresh-master'. NON tocchiamo il codice delle edge
-- function: vengono rimossi SOLO gli schedule pg_cron.
--
-- NON toccati:
--   nightly-data-refresh-master, acquisitionradar-daily-radar,
--   civiko-sync-segnali-live, civiko-sync-zone-quartieri,
--   padova-zone-radar-04/-10/-20/-finalize, padova-successioni,
--   cleanup-error-logs-30d, cleanup-diagnostics-runs-90d,
--   cleanup-rate-limit-events-30d
--
-- Idempotente: ogni unschedule è guard-ato da EXISTS su cron.job.
-- =====================================================================

DO $$
DECLARE
  v_jobs text[] := ARRAY[
    'offmarket-chain-1-radar',
    'offmarket-chain-2-earlywarning',
    'offmarket-chain-3-discover',
    'offmarket-chain-4-padova',
    'offmarket-chain-5-scores',
    'padova-daily-radar',
    'build-padova-early-warning',
    'refresh-padova-auctions'
  ];
  v_job text;
BEGIN
  FOREACH v_job IN ARRAY v_jobs LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job) THEN
      PERFORM cron.unschedule(v_job);
      RAISE NOTICE 'Unscheduled cron job: %', v_job;
    ELSE
      RAISE NOTICE 'Cron job % not present, skipped.', v_job;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- Verifica manuale post-migration (eseguire a mano in SQL editor):
--
--   SELECT jobname, schedule, active
--   FROM cron.job
--   WHERE jobname IN (
--     'offmarket-chain-1-radar','offmarket-chain-2-earlywarning',
--     'offmarket-chain-3-discover','offmarket-chain-4-padova',
--     'offmarket-chain-5-scores','padova-daily-radar',
--     'build-padova-early-warning','refresh-padova-auctions'
--   );
--   -- Atteso: 0 righe.
--
--   SELECT jobname, schedule FROM cron.job ORDER BY jobname;
--   -- Verificare che restino attivi: nightly-data-refresh-master,
--   -- acquisitionradar-daily-radar, civiko-sync-*, padova-zone-radar-*,
--   -- padova-successioni, cleanup-*.
-- ---------------------------------------------------------------------