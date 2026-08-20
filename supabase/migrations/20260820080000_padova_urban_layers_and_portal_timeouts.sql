-- Padova urban layers + portal timeout/throughput on live Core (jpunnzgixcghuydstdlt).
-- Vault lookup stays inside log_cron_http_invocation (CENTRAL_CORE_JOB_SECRET).
-- Does not target central-core-prod. Does not invent permits or sentiment.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
ALTER TABLE public.sue_padova_permits
  ADD COLUMN IF NOT EXISTS commercial_zone_slug text,
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS fetched_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS raw_ref jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.sue_padova_permits
   SET external_id = COALESCE(NULLIF(external_id, ''), id::text),
       source_url = COALESCE(NULLIF(source_url, ''), 'legacy://sue/' || id::text)
 WHERE external_id IS NULL OR source_url IS NULL OR source_url = '';

ALTER TABLE public.sue_padova_permits
  ALTER COLUMN external_id SET DEFAULT gen_random_uuid()::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sue_padova_permits_source_ext_uniq'
  ) THEN
    ALTER TABLE public.sue_padova_permits
      ADD CONSTRAINT sue_padova_permits_source_ext_uniq
      UNIQUE (source_url, external_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sue_padova_permits_zone_idx
  ON public.sue_padova_permits (commercial_zone_slug, fetched_at DESC);

CREATE TABLE IF NOT EXISTS public.padova_piano_regolatore (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commercial_zone_slug text,
  layer_kind text NOT NULL,
  zone_code text,
  designation text,
  title text NOT NULL,
  geometry_geojson jsonb,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS padova_piano_regolatore_fp_uniq
  ON public.padova_piano_regolatore (fingerprint);
CREATE INDEX IF NOT EXISTS padova_piano_regolatore_zone_idx
  ON public.padova_piano_regolatore (commercial_zone_slug, fetched_at DESC);

ALTER TABLE public.padova_piano_regolatore ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY piano_admin_select ON public.padova_piano_regolatore
    FOR SELECT TO authenticated
    USING (public.has_role(auth.uid(), 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public.padova_piano_regolatore TO authenticated;
GRANT ALL ON public.padova_piano_regolatore TO service_role;

ALTER TABLE public.microzone_sentiment
  ADD COLUMN IF NOT EXISTS commercial_zone_slug text;

CREATE INDEX IF NOT EXISTS microzone_sentiment_zone_idx
  ON public.microzone_sentiment (commercial_zone_slug, computed_at DESC);

-- Zone-isolated read views (PWA). Only official slugs.
DROP VIEW IF EXISTS public.sue_padova_permits_by_zone_v;
CREATE VIEW public.sue_padova_permits_by_zone_v AS
SELECT p.*
  FROM public.sue_padova_permits p
 WHERE p.commercial_zone_slug IN (
   'centro-storico','nord-arcella','est-brenta','nord-est',
   'sud-est-sant-osvaldo','sud-voltabarozzo-guizza',
   'sud-ovest-mandria','ovest-chiesanuova-brentelle'
 );

DROP VIEW IF EXISTS public.padova_piano_regolatore_by_zone_v;
CREATE VIEW public.padova_piano_regolatore_by_zone_v AS
SELECT r.*
  FROM public.padova_piano_regolatore r
 WHERE r.commercial_zone_slug IN (
   'centro-storico','nord-arcella','est-brenta','nord-est',
   'sud-est-sant-osvaldo','sud-voltabarozzo-guizza',
   'sud-ovest-mandria','ovest-chiesanuova-brentelle'
 );

DROP VIEW IF EXISTS public.microzone_sentiment_by_zone_v;
CREATE VIEW public.microzone_sentiment_by_zone_v AS
SELECT s.*
  FROM public.microzone_sentiment s
 WHERE s.commercial_zone_slug IN (
   'centro-storico','nord-arcella','est-brenta','nord-est',
   'sud-est-sant-osvaldo','sud-voltabarozzo-guizza',
   'sud-ovest-mandria','ovest-chiesanuova-brentelle'
 );

REVOKE ALL ON public.sue_padova_permits_by_zone_v FROM PUBLIC, anon;
REVOKE ALL ON public.padova_piano_regolatore_by_zone_v FROM PUBLIC, anon;
REVOKE ALL ON public.microzone_sentiment_by_zone_v FROM PUBLIC, anon;
GRANT SELECT ON public.sue_padova_permits_by_zone_v TO authenticated, service_role;
GRANT SELECT ON public.padova_piano_regolatore_by_zone_v TO authenticated, service_role;
GRANT SELECT ON public.microzone_sentiment_by_zone_v TO authenticated, service_role;

-- F18 now has a real collector.
UPDATE public.civiko_source_registry
SET
  automation_status = 'automated',
  scheduler_job_name = 'civiko-sue-padova-collect',
  ingestion_endpoint = '/civiko-sue-padova-collect',
  implementation_status = 'live',
  access_type = 'public_api',
  notes = 'Official Comune / CKAN / OSM construction → sue_padova_permits. Empty OK if sources up; fail-closed if unread.'
WHERE source_code = 'F18';

-- ---------------------------------------------------------------------------
-- log_cron_http_invocation: vault CENTRAL_CORE_JOB_SECRET only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_cron_http_invocation(
  p_job_name text,
  p_url text,
  p_body jsonb DEFAULT '{}'::jsonb,
  p_timeout_ms integer DEFAULT 120000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_secret TEXT;
  v_request_id BIGINT;
  v_log_id BIGINT;
  v_timeout INTEGER;
BEGIN
  INSERT INTO public.cron_executions_log (job_name, status)
  VALUES (p_job_name, 'started')
  RETURNING id INTO v_log_id;

  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'CENTRAL_CORE_JOB_SECRET'
    LIMIT 1;

    IF v_secret IS NULL OR length(v_secret) = 0 THEN
      RAISE EXCEPTION 'job secret not configured';
    END IF;

    v_timeout := GREATEST(COALESCE(p_timeout_ms, 120000), 5000);

    SELECT net.http_post(
      url := p_url,
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-job-secret', v_secret
      ),
      body := p_body,
      timeout_milliseconds := v_timeout
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

REVOKE EXECUTE ON FUNCTION public.log_cron_http_invocation(TEXT, TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_cron_http_invocation(TEXT, TEXT, JSONB, INTEGER) TO service_role, postgres;

-- ---------------------------------------------------------------------------
-- Crons: keep collect-pending + watchdog. Reschedule portals with timeouts.
-- ---------------------------------------------------------------------------
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
    'civiko-bakeca-scrape',
    'official-sue-padova',
    'official-piano-regolatore',
    'official-sentiment-refresh'
  ] LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
        PERFORM cron.unschedule(j);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- Watchdog + drain stay as already scheduled. Do not unschedule them.

SELECT cron.schedule(
  'portal-immobiliare-padova',
  '0 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'portal-immobiliare-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/cron-apify-immobiliare-nightly',
      '{}'::jsonb,
      60000
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
      '{}'::jsonb,
      60000
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
      '{"max_items":500}'::jsonb,
      60000
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
      '{}'::jsonb,
      60000
    );
  $cmd$
);

SELECT cron.schedule(
  'civiko-bakeca-scrape',
  '35 2 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'civiko-bakeca-scrape',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-bakeca-scrape',
      '{"trigger":"cron"}'::jsonb,
      100000
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
      '{"stale_minutes":2,"max_runs":30,"max_items_per_run":10000}'::jsonb,
      120000
    );
  $cmd$
);

SELECT cron.schedule(
  'official-sue-padova',
  '0 5 2 * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-sue-padova',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-sue-padova-collect',
      '{"triggered_by":"pg_cron"}'::jsonb,
      120000
    );
  $cmd$
);

SELECT cron.schedule(
  'official-piano-regolatore',
  '20 5 2 * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-piano-regolatore',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-piano-regolatore-collect',
      '{"triggered_by":"pg_cron"}'::jsonb,
      120000
    );
  $cmd$
);

SELECT cron.schedule(
  'official-sentiment-refresh',
  '40 5 * * *',
  $cmd$
    SELECT public.log_cron_http_invocation(
      'official-sentiment-refresh',
      'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-sentiment-refresh',
      '{"triggered_by":"pg_cron"}'::jsonb,
      90000
    );
  $cmd$
);
