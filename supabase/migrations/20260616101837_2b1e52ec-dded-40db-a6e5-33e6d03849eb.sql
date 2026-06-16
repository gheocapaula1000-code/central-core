-- Reactivate ONLY 'padova-daily-radar' cron job.
--
-- Rationale: l'audit di copertura post-cleanup ha dimostrato che il cron
-- 'nightly-data-refresh-master' NON copre 5 fasi critiche del radar Padova:
--   1. deep-scan-padova (listing_price_snapshots non aggiornati)
--   2. refresh-padova-auctions (segnali aste fermi)
--   3. perplexity-deep-padova + ping-snapshots-orchestrator
--   4. build-advanced-veneto-opportunities (velocity engine)
--   5. build-padova-early-warning (aggregator)
--
-- Riattivando solo 'padova-daily-radar' (che internamente concatena tutte e
-- 6 le fasi via padovaDailyRadar.ts) recuperiamo l'intera copertura con UN
-- solo cron, senza riattivare i job standalone già rimossi.
--
-- Schedule: '5 2 * * *' UTC (5 minuti dopo nightly-data-refresh-master alle
-- 02:00 UTC, così evitiamo sovrapposizioni I/O).
--
-- Endpoint/payload/header presi ESATTAMENTE dalla migration storica
-- 20260530024125_b35b039e-9b30-430b-a330-5ec56be63e0d.sql (ultima
-- definizione attiva prima dello spegnimento).
--
-- Idempotente: se il job esiste già lo unschedule prima, poi schedule.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'padova-daily-radar') THEN
    PERFORM cron.unschedule('padova-daily-radar');
  END IF;
END $$;

SELECT cron.schedule(
  'padova-daily-radar',
  '5 2 * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-daily-radar',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)
    ),
    body := '{"triggered_by":"pg_cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- ── Verifica manuale (commentata) ──────────────────────────────
-- 1) padova-daily-radar deve risultare attivo e schedulato a '5 2 * * *':
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'padova-daily-radar';
--
-- 2) Gli altri 4 cron coperti dal sub-chain interno devono restare SPENTI
--    (0 righe attese):
-- SELECT jobname, schedule, active FROM cron.job
--  WHERE jobname IN (
--    'refresh-padova-auctions',
--    'build-padova-early-warning',
--    'offmarket-chain-1-radar',
--    'offmarket-chain-2-earlywarning'
--  );
--
-- 3) Vista completa cron attivi:
-- SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;