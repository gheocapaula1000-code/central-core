BEGIN;

-- Produzione quotidiana dei contendibili Civiko One.
-- Isolata: usa solo padova_contendibili_quarantena/padova_listings e il
-- processor civiko_contendibile_detail_v1. Nessuna tabella di altre PWA.

CREATE TABLE IF NOT EXISTS public.civiko_contendibili_evidence_runs (
  id uuid PRIMARY KEY,
  run_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('started','success','failure')),
  requested_limit integer NOT NULL DEFAULT 24,
  groups_considered integer NOT NULL DEFAULT 0,
  groups_eligible integer NOT NULL DEFAULT 0,
  groups_forbidden integer NOT NULL DEFAULT 0,
  groups_invalid integer NOT NULL DEFAULT 0,
  candidates_found integer NOT NULL DEFAULT 0,
  enqueued integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  evidence_with_civico integer NOT NULL DEFAULT 0,
  evidence_with_piano integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS civiko_cont_evidence_runs_date_idx
  ON public.civiko_contendibili_evidence_runs (run_date DESC, started_at DESC);

CREATE TABLE IF NOT EXISTS public.civiko_contendibili_evidence_attempts (
  listing_id bigint PRIMARY KEY REFERENCES public.padova_listings(id) ON DELETE CASCADE,
  url text NOT NULL,
  commercial_zone_slug text NOT NULL,
  chiave_match text NOT NULL,
  queue_id uuid,
  run_id uuid REFERENCES public.civiko_contendibili_evidence_runs(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('queued','processing','succeeded','failed','dead')),
  evidence jsonb,
  error_code text,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS civiko_cont_evidence_attempts_status_idx
  ON public.civiko_contendibili_evidence_attempts (status, last_attempt_at);
CREATE INDEX IF NOT EXISTS civiko_cont_evidence_attempts_zone_idx
  ON public.civiko_contendibili_evidence_attempts (commercial_zone_slug);

ALTER TABLE public.civiko_contendibili_evidence_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.civiko_contendibili_evidence_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.civiko_contendibili_evidence_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.civiko_contendibili_evidence_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.civiko_contendibili_evidence_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.civiko_contendibili_evidence_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.process_civiko_contendibile_detail_v1(
  p_queue_id uuid,
  p_worker_id uuid,
  p_listing_id bigint,
  p_url text,
  p_commercial_zone_slug text,
  p_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15s'
SET lock_timeout TO '3s'
AS $fn$
DECLARE
  v_listing public.padova_listings%ROWTYPE;
  v_attempt public.civiko_contendibili_evidence_attempts%ROWTYPE;
  v_via text := NULLIF(btrim(p_evidence->>'via_norm'), '');
  v_civico text := NULLIF(lower(btrim(p_evidence->>'civico_norm')), '');
  v_piano text := NULLIF(upper(btrim(p_evidence->>'piano_key')), '');
  v_descr text := NULLIF(lower(btrim(p_evidence->>'descr_fp')), '');
  v_images jsonb := COALESCE(p_evidence->'image_refs', '[]'::jsonb);
  v_has_civico boolean := false;
  v_has_piano boolean := false;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF p_queue_id IS NULL OR p_worker_id IS NULL OR p_listing_id IS NULL THEN
    RAISE EXCEPTION 'invalid processor identity';
  END IF;
  IF p_commercial_zone_slug IS NULL OR NOT (p_commercial_zone_slug = ANY(ARRAY[
    'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza',
    'sud-ovest-mandria','ovest-chiesanuova-brentelle'
  ])) THEN
    RAISE EXCEPTION 'invalid commercial zone';
  END IF;
  IF p_url IS NULL OR p_url !~ '^https://' OR length(p_url) > 500 THEN
    RAISE EXCEPTION 'invalid url';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence,'{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'invalid evidence';
  END IF;
  IF v_via IS NOT NULL AND (length(v_via) > 200 OR public.padova_via_key(v_via) IS NULL) THEN
    RAISE EXCEPTION 'invalid via evidence';
  END IF;
  IF v_civico IS NOT NULL AND v_civico !~ '^[0-9]{1,3}[a-z]?$' THEN
    RAISE EXCEPTION 'invalid civico evidence';
  END IF;
  IF v_piano IS NOT NULL AND v_piano !~ '^(S|R|T|M|A|P([1-9]|[1-3][0-9]|40))$' THEN
    RAISE EXCEPTION 'invalid piano evidence';
  END IF;
  IF v_descr IS NOT NULL AND v_descr !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid description fingerprint';
  END IF;
  IF jsonb_typeof(v_images) <> 'array' OR jsonb_array_length(v_images) > 12 THEN
    RAISE EXCEPTION 'invalid image references';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_images) x
    WHERE x !~ '^https://' OR length(x) > 500
  ) THEN
    RAISE EXCEPTION 'invalid image reference';
  END IF;

  SELECT * INTO v_listing
  FROM public.padova_listings
  WHERE id = p_listing_id
  FOR UPDATE;
  IF NOT FOUND OR v_listing.url IS DISTINCT FROM p_url
     OR v_listing.commercial_zone_slug IS DISTINCT FROM p_commercial_zone_slug
     OR v_listing.expired_at IS NOT NULL THEN
    RAISE EXCEPTION 'listing scope mismatch';
  END IF;

  SELECT * INTO v_attempt
  FROM public.civiko_contendibili_evidence_attempts
  WHERE listing_id = p_listing_id
  FOR UPDATE;
  IF NOT FOUND OR v_attempt.queue_id IS DISTINCT FROM p_queue_id
     OR v_attempt.commercial_zone_slug IS DISTINCT FROM p_commercial_zone_slug THEN
    RAISE EXCEPTION 'attempt scope mismatch';
  END IF;

  -- Il dettaglio è più autorevole della card-lista. In caso di conflitto
  -- civico/piano si azzera il campo: il recompute resta fail-closed.
  UPDATE public.padova_listings l
     SET ev_via_norm = CASE
           WHEN v_via IS NULL THEN l.ev_via_norm
           WHEN l.ev_via_norm IS NULL OR l.ev_via_norm = v_via THEN v_via
           ELSE NULL
         END,
         ev_civico_norm = CASE
           WHEN v_civico IS NULL THEN l.ev_civico_norm
           WHEN l.ev_civico_norm IS NULL OR l.ev_civico_norm = v_civico THEN v_civico
           ELSE NULL
         END,
         ev_piano_key = CASE
           WHEN v_piano IS NULL THEN l.ev_piano_key
           WHEN l.ev_piano_key IS NULL OR l.ev_piano_key = v_piano THEN v_piano
           ELSE NULL
         END,
         ev_descr_fp = COALESCE(v_descr, l.ev_descr_fp),
         ev_image_refs = CASE
           WHEN jsonb_array_length(v_images) > 0 THEN v_images
           ELSE l.ev_image_refs
         END,
         ev_provenance = COALESCE(l.ev_provenance, '{}'::jsonb) ||
           jsonb_build_object(
             'detail', jsonb_strip_nulls(jsonb_build_object(
               'version', COALESCE(p_evidence->>'version','civiko-detail-v1'),
               'queue_id', p_queue_id,
               'derived_at', now(),
               'via', v_via,
               'civico', v_civico,
               'piano', v_piano,
               'description_fingerprint', v_descr,
               'unit_ref', NULLIF(p_evidence->>'unit_ref',''),
               'image_count', jsonb_array_length(v_images),
               'text_chars', COALESCE((p_evidence->>'text_chars')::int,0)
             ))
           ),
         ev_derived_at = now()
   WHERE l.id = p_listing_id;

  SELECT ev_civico_norm IS NOT NULL, ev_piano_key IS NOT NULL
    INTO v_has_civico, v_has_piano
    FROM public.padova_listings WHERE id = p_listing_id;

  UPDATE public.civiko_contendibili_evidence_attempts
     SET status = 'succeeded',
         evidence = jsonb_strip_nulls(p_evidence),
         error_code = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE listing_id = p_listing_id;

  IF v_attempt.run_id IS NOT NULL THEN
    UPDATE public.civiko_contendibili_evidence_runs
       SET processed = processed + 1,
           evidence_with_civico = evidence_with_civico + CASE WHEN v_has_civico THEN 1 ELSE 0 END,
           evidence_with_piano = evidence_with_piano + CASE WHEN v_has_piano THEN 1 ELSE 0 END
     WHERE id = v_attempt.run_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', p_listing_id,
    'commercial_zone_slug', p_commercial_zone_slug,
    'has_civico', v_has_civico,
    'has_piano', v_has_piano,
    'image_refs', jsonb_array_length(v_images)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.process_civiko_contendibile_detail_v1(
  uuid,uuid,bigint,text,text,jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_civiko_contendibile_detail_v1(
  uuid,uuid,bigint,text,text,jsonb
) TO service_role;

-- Alle 06:00 Europe/Rome durante CEST (04:00 UTC), dopo la raccolta portali
-- e prima del recompute autoritativo delle 06:30.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job
           WHERE jobname = 'civiko-contendibili-evidence-refresh'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END
$do$;

SELECT cron.schedule(
  'civiko-contendibili-evidence-refresh',
  '0 4 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-contendibili-evidence-refresh',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-job-secret', (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name='CENTRAL_CORE_JOB_SECRET' LIMIT 1
      )
    ),
    body := '{"limit":24,"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $job$
);

COMMIT;
