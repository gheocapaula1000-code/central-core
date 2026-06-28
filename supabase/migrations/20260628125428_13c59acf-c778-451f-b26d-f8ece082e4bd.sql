-- 1) Cleanup duplicate cron jobs
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
      RAISE NOTICE 'Rimosso job duplicato: %', j;
    END IF;
  END LOOP;
END $$;

-- 2) Ensure vault secret exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'CIVIKO_PRIVATE_LEADS_URL') THEN
    PERFORM vault.create_secret(
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-private-leads-nightly',
      'CIVIKO_PRIVATE_LEADS_URL',
      'URL edge function civiko-private-leads-nightly per cron'
    );
  END IF;
END $$;

-- 3) Reschedule cron to read URL from vault
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'civiko-private-leads-nightly') THEN
    PERFORM cron.unschedule('civiko-private-leads-nightly');
  END IF;
END $$;

SELECT cron.schedule(
  'civiko-private-leads-nightly',
  '25 2 * * *',
  $cron$
  SELECT public.log_cron_http_invocation(
    'civiko-private-leads-nightly',
    (SELECT decrypted_secret FROM vault.decrypted_secrets
     WHERE name = 'CIVIKO_PRIVATE_LEADS_URL'),
    '{"trigger":"cron"}'::jsonb
  );
  $cron$
);