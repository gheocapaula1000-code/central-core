-- Create 4 controlled cron jobs central-core → Civiko One (radar-cron)
-- Idempotent: unschedule only the 4 target names, then recreate.
-- Auth: Bearer central_core_job_secret (read from Vault at runtime, never hardcoded).
-- Target URL: CRON_REFRESH_PORTALI_URL (= https://nmlofzmubwugvxcztjqv.supabase.co/functions/v1/radar-cron).
-- DB tz is UTC → schedules expressed in UTC (Rome = UTC+2 in DST window).

DO $$
DECLARE
  v_url_exists boolean;
  v_secret_exists boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM vault.secrets WHERE name = 'CRON_REFRESH_PORTALI_URL') INTO v_url_exists;
  SELECT EXISTS(SELECT 1 FROM vault.secrets WHERE name = 'central_core_job_secret') INTO v_secret_exists;
  IF NOT v_url_exists THEN
    RAISE EXCEPTION 'Vault secret CRON_REFRESH_PORTALI_URL missing — aborting';
  END IF;
  IF NOT v_secret_exists THEN
    RAISE EXCEPTION 'Vault secret central_core_job_secret missing — aborting';
  END IF;
END$$;

-- Ensure required extensions are available (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Unschedule ONLY the 4 target names (idempotent; ignore if not present)
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'civiko-one-leads-soft-0400',
    'civiko-one-leads-soft-1100',
    'civiko-one-leads-soft-1530',
    'civiko-one-leads-full-weekly'
  ] LOOP
    IF EXISTS(SELECT 1 FROM cron.job WHERE jobname = v_name) THEN
      PERFORM cron.unschedule(v_name);
    END IF;
  END LOOP;
END$$;

-- soft 04:00 Roma  (02:00 UTC)  lun-sab
SELECT cron.schedule(
  'civiko-one-leads-soft-0400',
  '0 2 * * 1-6',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_REFRESH_PORTALI_URL'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'mode','normal',
      'intent','soft',
      'scope','incremental',
      'trigger','civiko-one-leads-soft-0400',
      'source','central-core',
      'target','civiko-one',
      'goal','find_private_seller_and_non_exclusive_real_estate_leads',
      'business_goal','populate_civiko_one_with_real_estate_acquisition_opportunities',
      'tools_expected', jsonb_build_array('firecrawl','apify','perplexity','openai'),
      'comuni', jsonb_build_array('Padova')
    ),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- soft 11:00 Roma  (09:00 UTC)  lun-sab
SELECT cron.schedule(
  'civiko-one-leads-soft-1100',
  '0 9 * * 1-6',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_REFRESH_PORTALI_URL'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'mode','normal',
      'intent','soft',
      'scope','incremental',
      'trigger','civiko-one-leads-soft-1100',
      'source','central-core',
      'target','civiko-one',
      'goal','find_private_seller_and_non_exclusive_real_estate_leads',
      'business_goal','populate_civiko_one_with_real_estate_acquisition_opportunities',
      'tools_expected', jsonb_build_array('firecrawl','apify','perplexity','openai'),
      'comuni', jsonb_build_array('Padova')
    ),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- soft 15:30 Roma  (13:30 UTC)  lun-sab
SELECT cron.schedule(
  'civiko-one-leads-soft-1530',
  '30 13 * * 1-6',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_REFRESH_PORTALI_URL'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'mode','normal',
      'intent','soft',
      'scope','incremental',
      'trigger','civiko-one-leads-soft-1530',
      'source','central-core',
      'target','civiko-one',
      'goal','find_private_seller_and_non_exclusive_real_estate_leads',
      'business_goal','populate_civiko_one_with_real_estate_acquisition_opportunities',
      'tools_expected', jsonb_build_array('firecrawl','apify','perplexity','openai'),
      'comuni', jsonb_build_array('Padova')
    ),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- full weekly lunedì 02:00 Roma  (00:00 UTC)
SELECT cron.schedule(
  'civiko-one-leads-full-weekly',
  '0 0 * * 1',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_REFRESH_PORTALI_URL'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'central_core_job_secret'),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'mode','full',
      'intent','full',
      'scope','weekly',
      'trigger','civiko-one-leads-full-weekly',
      'source','central-core',
      'target','civiko-one',
      'goal','deep_real_estate_lead_discovery_enrichment_classification_and_price_snapshot',
      'business_goal','populate_civiko_one_with_high_value_real_estate_acquisition_opportunities',
      'tools_expected', jsonb_build_array('firecrawl','apify','perplexity','openai'),
      'comuni', jsonb_build_array('Padova')
    ),
    timeout_milliseconds := 540000
  );
  $cron$
);