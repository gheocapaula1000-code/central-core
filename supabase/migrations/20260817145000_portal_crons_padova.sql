-- Portal crons on live Core (jpunnzgixcghuydstdlt). Existing wrappers only.
-- Immobiliare / Idealista / Subito / Casa.it + collect-pending + recompute.
-- Does not invent scrapers. Casa.it empty = fail, not fake success.

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'portal-immobiliare-padova',
    'portal-idealista-padova',
    'portal-subito-padova',
    'portal-casa-padova',
    'portal-collect-pending',
    'padova-listings-contendibili-recompute'
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

SELECT cron.schedule(
  'portal-idealista-padova',
  '10 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-idealista-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-idealista-nightly',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'portal-subito-padova',
  '20 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-subito-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-subito-nightly',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'portal-casa-padova',
  '30 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-casa-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-casa-nightly',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'portal-collect-pending',
  '45 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-collect-pending',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-collect-pending',
      '{}'::jsonb
    );
  $cmd$
);

SELECT cron.schedule(
  'padova-listings-contendibili-recompute',
  '15 3 * * *',
  $cmd$
  DO $body$
  DECLARE
    v_log_id bigint;
    v_r jsonb;
    v_started timestamptz := now();
  BEGIN
    INSERT INTO public.cron_executions_log (job_name, status, triggered_at)
    VALUES ('padova-listings-contendibili-recompute', 'started', v_started)
    RETURNING id INTO v_log_id;
    BEGIN
      PERFORM set_config('statement_timeout', '600s', true);
      v_r := public.recompute_padova_listings_contendibili();
      UPDATE public.cron_executions_log
         SET status = 'success',
             completed_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
             response_excerpt = LEFT(COALESCE(v_r::text, ''), 4000)
       WHERE id = v_log_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.cron_executions_log
         SET status = 'failure',
             completed_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - v_started)) * 1000)::int,
             error_message = LEFT(COALESCE(SQLSTATE, '') || ' ' || COALESCE(SQLERRM, ''), 4000)
       WHERE id = v_log_id;
    END;
  END;
  $body$;
  $cmd$
);
