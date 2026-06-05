
DO $$
DECLARE
  v_url_base TEXT := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/';
  v_body JSONB := '{"triggered_by":"pg_cron_offmarket_chain"}'::jsonb;
  v_headers TEXT := $hdr$jsonb_build_object('Content-Type','application/json','x-job-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1),''))$hdr$;
BEGIN
  NULL;
END $$;

DO $$ BEGIN PERFORM cron.unschedule('offmarket-chain-1-radar');        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('offmarket-chain-2-earlywarning'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('offmarket-chain-3-discover');     EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('offmarket-chain-4-padova');       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('offmarket-chain-5-scores');       EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'offmarket-chain-1-radar',
  '10 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-daily-radar',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1),'')
    ),
    body := '{"triggered_by":"pg_cron_offmarket_chain"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

SELECT cron.schedule(
  'offmarket-chain-2-earlywarning',
  '20 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/build-padova-early-warning',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1),'')
    ),
    body := '{"triggered_by":"pg_cron_offmarket_chain"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

SELECT cron.schedule(
  'offmarket-chain-3-discover',
  '30 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/discover-early-offmarket-signals',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1),'')
    ),
    body := '{"triggered_by":"pg_cron_offmarket_chain"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

SELECT cron.schedule(
  'offmarket-chain-4-padova',
  '40 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/offmarket-padova',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1),'')
    ),
    body := '{"triggered_by":"pg_cron_offmarket_chain"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

SELECT cron.schedule(
  'offmarket-chain-5-scores',
  '50 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/build-offmarket-opportunity-scores',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='central_core_job_secret' LIMIT 1),'')
    ),
    body := '{"triggered_by":"pg_cron_offmarket_chain"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
