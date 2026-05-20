-- ═══════════════════════════════════════════════════════════════
-- Sostituisce il cron monolitico con uno staggerato zone-by-zone.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION private.padova_zone_radar_trigger(p_max_zones int DEFAULT 6, p_finalize boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
  v_url    text;
  v_req_id bigint;
  v_body   jsonb;
BEGIN
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'central_core_job_secret' LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE NOTICE 'padova_zone_radar_trigger: vault secret missing — skipping';
    RETURN NULL;
  END IF;

  IF p_finalize THEN
    v_url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-zone-radar-finalize';
    v_body := jsonb_build_object('triggered_by','pg_cron','at', now());
  ELSE
    v_url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-radar-veneto/jobs/padova-zone-radar';
    v_body := jsonb_build_object('mode','next','max_zones', p_max_zones,'triggered_by','pg_cron');
  END IF;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-job-secret', v_secret),
    body := v_body,
    timeout_milliseconds := 60000
  ) INTO v_req_id;

  RETURN v_req_id;
END;
$$;

REVOKE ALL ON FUNCTION private.padova_zone_radar_trigger(int, boolean) FROM PUBLIC;

-- Disattiva il vecchio cron monolitico
DO $$
BEGIN
  PERFORM cron.unschedule('padova-daily-radar');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Pulizia eventuali vecchi schedule zone
DO $$
DECLARE n text;
BEGIN
  FOR n IN SELECT jobname FROM cron.job
           WHERE jobname IN ('padova-zone-radar-04','padova-zone-radar-10','padova-zone-radar-20','padova-zone-radar-finalize')
  LOOP
    PERFORM cron.unschedule(n);
  END LOOP;
END $$;

-- Schedula i 4 trigger staggerati
SELECT cron.schedule('padova-zone-radar-04', '0 4 * * *',  $cron$ SELECT private.padova_zone_radar_trigger(6, false); $cron$);
SELECT cron.schedule('padova-zone-radar-10', '10 4 * * *', $cron$ SELECT private.padova_zone_radar_trigger(6, false); $cron$);
SELECT cron.schedule('padova-zone-radar-20', '20 4 * * *', $cron$ SELECT private.padova_zone_radar_trigger(6, false); $cron$);
SELECT cron.schedule('padova-zone-radar-finalize', '30 4 * * *', $cron$ SELECT private.padova_zone_radar_trigger(0, true); $cron$);