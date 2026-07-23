-- Aggiorna esclusivamente il comando del cron `apify-subito-weekly` per
-- iniettare l'header `x-job-secret` letto a runtime da `vault.decrypted_secrets`
-- (name = 'central_core_job_secret').
--
-- Invariati: jobname, schedule '30 3 * * 0', active=true, URL, body.
-- Il valore del secret NON viene hardcoded, stampato o copiato: la lookup
-- avviene runtime-side dal payload SQL del job.
--
-- Se il secret Vault non esiste, la migration FALLISCE prima di modificare
-- il job.

DO $$
DECLARE
  v_exists boolean;
  v_jobid  bigint;
  v_url    text;
  v_body   text;
  v_new_cmd text;
BEGIN
  -- 1) Verifica presenza secret Vault (fail-fast, senza leggerne il valore).
  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'vault secret central_core_job_secret missing: aborting cron update';
  END IF;

  -- 2) Trova il job per nome (jobid non è assumibile stabile).
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'apify-subito-weekly' LIMIT 1;
  IF v_jobid IS NULL THEN
    RAISE EXCEPTION 'cron job apify-subito-weekly not found';
  END IF;

  v_url  := current_setting('app.supabase_url', true);
  IF v_url IS NULL OR v_url = '' THEN
    v_url := 'https://jpunnzgixcghuydstdlt.supabase.co';
  END IF;
  v_body := '{"async_start": true, "max_items": 300}';

  -- 3) Nuovo comando: header x-job-secret risolto runtime dal Vault, mai stampato.
  v_new_cmd := format($cmd$
    SELECT net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-job-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret' LIMIT 1)
      ),
      body := %L::jsonb
    ) AS request_id;
  $cmd$, v_url || '/functions/v1/cron-apify-subito-nightly', v_body);

  -- 4) Aggiorna solo il command; schedule/nome/active invariati.
  PERFORM cron.alter_job(
    job_id  => v_jobid,
    command => v_new_cmd
  );
END $$;