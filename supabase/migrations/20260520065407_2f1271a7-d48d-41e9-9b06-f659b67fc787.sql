-- ─── Padova Daily Radar scheduler ───────────────────────────────
-- Calls civiko-radar-veneto/jobs/padova-daily-radar every morning.
-- Secret is read from supabase_vault, never embedded in code or repo.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.padova_daily_radar_trigger()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
  v_url    text := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-daily-radar';
  v_req_id bigint;
BEGIN
  SELECT decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'central_core_job_secret'
   LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE NOTICE 'padova_daily_radar_trigger: vault secret central_core_job_secret missing — skipping';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-job-secret', v_secret
               ),
    body    := jsonb_build_object('triggered_by', 'pg_cron', 'at', now())
  )
  INTO v_req_id;

  RETURN v_req_id;
END;
$$;

REVOKE ALL ON FUNCTION private.padova_daily_radar_trigger() FROM PUBLIC;

-- Remove any previous schedule with the same name (idempotent)
DO $$
BEGIN
  PERFORM cron.unschedule('padova-daily-radar');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Schedule: 04:00 UTC daily (06:00 Europe/Rome summer / 05:00 winter)
SELECT cron.schedule(
  'padova-daily-radar',
  '0 4 * * *',
  $cron$ SELECT private.padova_daily_radar_trigger(); $cron$
);
