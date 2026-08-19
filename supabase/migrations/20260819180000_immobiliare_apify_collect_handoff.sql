-- Immobiliare nightly launch + collect-pending handoff on live Core
-- (jpunnzgixcghuydstdlt). No secrets in this file.
--
-- Fixes:
--   1. Unschedule the legacy 03:10 job that POSTed without x-job-secret
--      (only an anon JWT) so nightly always 401'd.
--   2. Keep portal-immobiliare-padova @ 02:00 UTC via log_cron_http_invocation.
--   3. Send vault CENTRAL_CORE_JOB_SECRET and vault SUPABASE_ANON_KEY so the
--      Edge gateway does not 401 the collect handoff.
--   4. Do not rewrite portal-collect-pending: main already has
--      portal-collect-pending @ 02:45 and portal-collect-pending-drain
--      every 15 minutes (20260819170100).

CREATE OR REPLACE FUNCTION public.log_cron_http_invocation(
  p_job_name text,
  p_url text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_secret TEXT;
  v_apikey TEXT;
  v_headers jsonb;
  v_request_id BIGINT;
  v_log_id BIGINT;
BEGIN
  INSERT INTO public.cron_executions_log (job_name, status)
  VALUES (p_job_name, 'started')
  RETURNING id INTO v_log_id;

  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'CENTRAL_CORE_JOB_SECRET'
    LIMIT 1;

    SELECT decrypted_secret INTO v_apikey
    FROM vault.decrypted_secrets
    WHERE name IN ('SUPABASE_ANON_KEY', 'anon', 'SB_ANON_KEY')
    ORDER BY CASE name
      WHEN 'SUPABASE_ANON_KEY' THEN 0
      WHEN 'anon' THEN 1
      ELSE 2
    END
    LIMIT 1;

    IF v_secret IS NULL OR length(v_secret) = 0 THEN
      RAISE EXCEPTION 'job secret not configured';
    END IF;

    v_headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-job-secret', v_secret,
      'x-internal-secret', v_secret
    );
    IF v_apikey IS NOT NULL AND length(v_apikey) > 0 THEN
      v_headers := v_headers || jsonb_build_object(
        'apikey', v_apikey,
        'Authorization', 'Bearer ' || v_apikey
      );
    END IF;

    SELECT net.http_post(
      url := p_url,
      headers := v_headers,
      body := p_body,
      timeout_milliseconds := 120000
    ) INTO v_request_id;

    UPDATE public.cron_executions_log
       SET status = 'success',
           http_request_id = v_request_id,
           completed_at = now(),
           duration_ms = EXTRACT(MILLISECOND FROM (now() - triggered_at))::int
     WHERE id = v_log_id;

    RETURN v_log_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.cron_executions_log
       SET status = 'failure',
           error_message = SQLERRM,
           completed_at = now(),
           duration_ms = EXTRACT(MILLISECOND FROM (now() - triggered_at))::int
     WHERE id = v_log_id;
    RETURN v_log_id;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.log_cron_http_invocation(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_cron_http_invocation(TEXT, TEXT, JSONB) TO service_role, postgres;

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'central-core-apify-immobiliare-nightly',
    'portal-immobiliare-padova'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

SELECT cron.schedule(
  'portal-immobiliare-padova',
  '0 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-immobiliare-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-immobiliare-nightly',
      '{}'::jsonb
    );
  $cmd$
);
