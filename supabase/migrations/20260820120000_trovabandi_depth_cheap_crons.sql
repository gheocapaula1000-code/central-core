-- TrovaBandi — crons notturni per corsia + backfill cheap-first.
-- Isolato: unschedula soltanto job trovabandi-*. Non tocca Civiko/Padova.
-- Live Core: jpunnzgixcghuydstdlt. pg_cron è in UTC; orari documentati in
-- Europe/Rome (CEST = UTC+2) in docs/TROVABANDI_REPLIT_CRON.md.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.trovabandi_cron_invoke(
  p_body jsonb,
  p_timeout_ms integer DEFAULT 180000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_secret TEXT;
  v_request_id BIGINT;
  v_timeout INTEGER;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'CENTRAL_CORE_JOB_SECRET'
  LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'trovabandi job secret not configured';
  END IF;

  v_timeout := GREATEST(COALESCE(p_timeout_ms, 180000), 5000);

  -- Entrambi gli header: l'engine accetta x-internal-secret (live) e
  -- x-job-secret (stesso valore). Il secret non viene loggato.
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/trovabandi-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', v_secret,
      'x-job-secret', v_secret
    ),
    body := p_body,
    timeout_milliseconds := v_timeout
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.trovabandi_cron_invoke(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trovabandi_cron_invoke(jsonb, integer) TO service_role, postgres;

-- Riattiva corsie ufficiali disabilitate (albo, femminile, regioni).
UPDATE public.trovabandi_sources
SET
  enabled = true,
  next_scan_at = now(),
  updated_at = now()
WHERE enabled = false
  AND official_domain IN (
    'padovanet.it',
    'pariopportunita.gov.it',
    'regione.basilicata.it',
    'regione.molise.it',
    'regione.sicilia.it'
  );

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'trovabandi-collect-supabase',
    'trovabandi-night-1',
    'trovabandi-night-2',
    'trovabandi-night-deep',
    'trovabandi-night-wide',
    'trovabandi-maintenance',
    'trovabandi-release-gate',
    'trovabandi-night-backfill',
    'trovabandi-night-locale',
    'trovabandi-night-camerale',
    'trovabandi-night-regionale',
    'trovabandi-night-nazionale',
    'trovabandi-night-pnrr',
    'trovabandi-night-ue',
    'trovabandi-night-femminile',
    'trovabandi-night-giovanile',
    'trovabandi-night-wide-due',
    'trovabandi-day-backfill',
    'trovabandi-day-cheap'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- 01:10 Europe/Rome (CEST) — backfill incompleti, zero paid.
SELECT cron.schedule(
  'trovabandi-night-backfill',
  '10 23 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"backfill_nulls","max_batch":16,"dry_run":false,"allow_paid_extract":false,"trigger_source":"supabase-cron"}'::jsonb,
    180000
  ); $c$
);

-- 01:20–02:30 Europe/Rome — una corsia per job, concorrenza 1, paid last-resort.
SELECT cron.schedule(
  'trovabandi-night-locale',
  '20 23 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"locale","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-camerale',
  '30 23 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"camerale","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-regionale',
  '40 23 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"regionale","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-nazionale',
  '50 23 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"nazionale","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-pnrr',
  '0 0 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"pnrr","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-ue',
  '10 0 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"ue","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-femminile',
  '20 0 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"femminile","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-night-giovanile',
  '30 0 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","lane":"giovanile","max_pages":3,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);

-- 04:20 Europe/Rome — wide sui dovuti residui (stesso slot del vecchio night-2).
SELECT cron.schedule(
  'trovabandi-night-wide-due',
  '20 2 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","max_pages":2,"allow_paid":true,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);

SELECT cron.schedule(
  'trovabandi-maintenance',
  '15 4 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"maintenance","trigger_source":"supabase-cron"}'::jsonb,
    120000
  ); $c$
);
SELECT cron.schedule(
  'trovabandi-release-gate',
  '25 4 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"release_gate","trigger_source":"supabase-cron"}'::jsonb,
    120000
  ); $c$
);

-- 10:30 Europe/Rome — backfill diurno free. Nessun full-scan a pagamento.
SELECT cron.schedule(
  'trovabandi-day-backfill',
  '30 8 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"backfill_nulls","max_batch":10,"dry_run":false,"allow_paid_extract":false,"trigger_source":"supabase-cron"}'::jsonb,
    180000
  ); $c$
);

-- 14:30 Europe/Rome — incrementale cheap (seed + HTTP ufficiale, zero paid).
SELECT cron.schedule(
  'trovabandi-day-cheap',
  '30 12 * * *',
  $c$ SELECT public.trovabandi_cron_invoke(
    '{"action":"collect","max_pages":2,"allow_paid":false,"trigger_source":"supabase-cron"}'::jsonb
  ); $c$
);
