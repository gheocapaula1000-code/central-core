
-- 1) Vault: upsert CRON_REFRESH_PORTALI_URL
DO $$
DECLARE
  v_url text := 'https://nmlofzmubwugvxcztjqv.supabase.co/functions/v1/radar-cron';
  v_existing uuid;
BEGIN
  SELECT id INTO v_existing FROM vault.secrets WHERE name = 'CRON_REFRESH_PORTALI_URL' LIMIT 1;
  IF v_existing IS NULL THEN
    PERFORM vault.create_secret(v_url, 'CRON_REFRESH_PORTALI_URL');
  ELSE
    PERFORM vault.update_secret(v_existing, v_url, 'CRON_REFRESH_PORTALI_URL');
  END IF;
END $$;

-- 2) Verifica presenza central_core_job_secret (stop con errore se assente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'central_core_job_secret') THEN
    RAISE EXCEPTION 'Vault secret central_core_job_secret missing — abort migration';
  END IF;
END $$;

-- 3) Disattiva (unschedule) i cron aste — idempotente
DO $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'refresh-padova-auctions',
    'fetch-aste-nascoste',
    'fetch-aste-nascoste-daily',
    'padova-aste-refresh',
    'padova-aste-discovery'
  ] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END $$;

-- 4) Helper SQL inline per i 4 nuovi cron: legge i secret dal vault a runtime
--    e fa net.http_post con Authorization: Bearer <central_core_job_secret>

-- Unschedule preesistenti per idempotenza
DO $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'civiko-refresh-portali-notte',
    'civiko-refresh-portali-mattina',
    'civiko-refresh-portali-pomeriggio',
    'civiko-refresh-domenica-full'
  ] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END $$;

-- 4a) civiko-refresh-portali-notte
SELECT cron.schedule(
  'civiko-refresh-portali-notte',
  '0 2 * * 1-6',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_REFRESH_PORTALI_URL' LIMIT 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)
    ),
    body := '{"mode":"normal","trigger":"refresh-notte","comuni":["Padova"]}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);

-- 4b) civiko-refresh-portali-mattina
SELECT cron.schedule(
  'civiko-refresh-portali-mattina',
  '0 9 * * 1-6',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_REFRESH_PORTALI_URL' LIMIT 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)
    ),
    body := '{"mode":"normal","trigger":"refresh-mattina","comuni":["Padova"]}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);

-- 4c) civiko-refresh-portali-pomeriggio
SELECT cron.schedule(
  'civiko-refresh-portali-pomeriggio',
  '30 13 * * 1-6',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_REFRESH_PORTALI_URL' LIMIT 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)
    ),
    body := '{"mode":"normal","trigger":"refresh-pomeriggio","comuni":["Padova"]}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);

-- 4d) civiko-refresh-domenica-full
SELECT cron.schedule(
  'civiko-refresh-domenica-full',
  '0 2 * * 0',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_REFRESH_PORTALI_URL' LIMIT 1),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1)
    ),
    body := '{"mode":"full","trigger":"refresh-domenica-full","comuni":["Padova"]}'::jsonb,
    timeout_milliseconds := 300000
  );
  $cron$
);
