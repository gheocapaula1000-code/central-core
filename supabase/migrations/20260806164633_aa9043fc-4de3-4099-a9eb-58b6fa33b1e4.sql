-- ═══════════════════════════════════════════════════════════════════
-- Civiko One / Padova — P0 release gate: prova reale del sync PWA.
-- Additivo e isolato: nessun altro dominio, nessun cron, nessun provider.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Audit dedicato delle conferme di sincronizzazione della PWA Civiko.
CREATE TABLE IF NOT EXISTS public.civiko_pwa_sync_acks (
  run_id            uuid PRIMARY KEY,
  idempotency_key   text NOT NULL,
  source_app        text NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  ok                boolean NOT NULL,
  counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope_comune      text NOT NULL,
  scope_slugs       text[] NOT NULL,
  error_code        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT civiko_pwa_sync_acks_idempotency_key_uq UNIQUE (idempotency_key),
  CONSTRAINT civiko_pwa_sync_acks_scope_comune_ck CHECK (scope_comune = 'Padova'),
  CONSTRAINT civiko_pwa_sync_acks_window_ck CHECK (finished_at >= started_at),
  CONSTRAINT civiko_pwa_sync_acks_counts_ck CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT civiko_pwa_sync_acks_error_code_ck
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  CONSTRAINT civiko_pwa_sync_acks_scope_slugs_ck CHECK (
    array_length(scope_slugs, 1) BETWEEN 1 AND 8
    AND scope_slugs <@ ARRAY[
      'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria',
      'ovest-chiesanuova-brentelle'
    ]::text[]
  )
);

CREATE INDEX IF NOT EXISTS civiko_pwa_sync_acks_finished_idx
  ON public.civiko_pwa_sync_acks (finished_at DESC);

-- Nessuna scrittura né lettura dai client: solo servizi interni.
REVOKE ALL ON public.civiko_pwa_sync_acks FROM PUBLIC;
GRANT ALL ON public.civiko_pwa_sync_acks TO service_role;
ALTER TABLE public.civiko_pwa_sync_acks ENABLE ROW LEVEL SECURITY;

-- 2) Prova reale dell'esecuzione delle pipeline Civiko (nessun cron attivato).
CREATE TABLE IF NOT EXISTS public.civiko_pipeline_runs (
  run_id       uuid PRIMARY KEY,
  pipeline     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  steps        jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT civiko_pipeline_runs_pipeline_ck
    CHECK (pipeline IN ('pipeline_0510','pipeline_0545','pipeline_0710')),
  CONSTRAINT civiko_pipeline_runs_window_ck
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS civiko_pipeline_runs_pipeline_finished_idx
  ON public.civiko_pipeline_runs (pipeline, finished_at DESC);

REVOKE ALL ON public.civiko_pipeline_runs FROM PUBLIC;
GRANT ALL ON public.civiko_pipeline_runs TO service_role;
ALTER TABLE public.civiko_pipeline_runs ENABLE ROW LEVEL SECURITY;

-- 3) updated_at automatico su entrambe le tabelle di audit.
CREATE OR REPLACE FUNCTION public.civiko_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS civiko_pwa_sync_acks_touch ON public.civiko_pwa_sync_acks;
CREATE TRIGGER civiko_pwa_sync_acks_touch
  BEFORE UPDATE ON public.civiko_pwa_sync_acks
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

DROP TRIGGER IF EXISTS civiko_pipeline_runs_touch ON public.civiko_pipeline_runs;
CREATE TRIGGER civiko_pipeline_runs_touch
  BEFORE UPDATE ON public.civiko_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION public.civiko_touch_updated_at();

-- 4) Release gate: il sync PWA è provato soltanto da un ack recente e ok,
--    successivo alla fine dell'ultima pipeline_0710 riuscita in finestra e
--    successivo all'ultima classificazione. Nessuna prova indiretta.
DROP VIEW IF EXISTS public.civiko_padova_release_gate_v;
CREATE VIEW public.civiko_padova_release_gate_v
WITH (security_invoker = true) AS
WITH w AS (SELECT (now() - interval '4 hours') AS since),
portali AS (
  SELECT count(DISTINCT lower(i.portal)) AS portali_freschi
    FROM public.padova_collect_v2_items i, w
   WHERE lower(coalesce(i.citta,'')) = 'padova'
     AND lower(i.portal) IN ('casa','immobiliare','idealista','subito')
     AND (i.created_at >= w.since OR i.updated_at >= w.since)
),
mism AS (SELECT count(*) AS mismatch_professionale FROM public.civiko_padova_tipo_lead_mismatch_v),
promo AS (
  SELECT count(*) AS listings_freschi, max(l.last_seen_at) AS classificazione_ultima
    FROM public.padova_listings l, w
   WHERE l.expired_at IS NULL
     AND lower(coalesce(l.comune,'')) = 'padova'
     AND l.tipo_lead IS NOT NULL
     AND l.last_seen_at >= w.since
),
reco AS (SELECT max(pc.updated_at) AS recompute_ultimo, count(*) AS contendibili_totali
           FROM public.padova_contendibili pc),
pipe AS (
  SELECT max(r.finished_at) AS pipeline_0710_ultimo_ok
    FROM public.civiko_pipeline_runs r, w
   WHERE r.pipeline = 'pipeline_0710'
     AND r.ok IS TRUE
     AND r.finished_at IS NOT NULL
     AND r.finished_at >= w.since
),
ack AS (
  SELECT max(a.finished_at) AS ack_ultimo_ok
    FROM public.civiko_pwa_sync_acks a, w
   WHERE a.ok IS TRUE
     AND a.error_code IS NULL
     AND a.scope_comune = 'Padova'
     AND a.finished_at >= w.since
     AND a.finished_at <= now() + interval '5 minutes'
),
perim AS (
  SELECT
    (SELECT count(*) FROM public.padova_contendibili pc
      WHERE pc.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                         WHERE z.slug = pc.commercial_zone_slug)) AS contendibili_fuori_perimetro,
    (SELECT count(*) FROM public.padova_listings l
      WHERE l.expired_at IS NULL
        AND upper(coalesce(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
        AND lower(coalesce(l.comune,'')) = 'padova'
        AND l.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z
                         WHERE z.slug = l.commercial_zone_slug)) AS privati_fuori_perimetro
)
SELECT
  portali.portali_freschi,
  mism.mismatch_professionale,
  promo.listings_freschi,
  promo.classificazione_ultima,
  reco.recompute_ultimo,
  reco.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ultimo >= (SELECT since FROM w)) AS recompute_corrente,
  pipe.pipeline_0710_ultimo_ok,
  ack.ack_ultimo_ok AS pwa_sync_ack_ultimo_ok,
  (ack.ack_ultimo_ok IS NOT NULL
   AND pipe.pipeline_0710_ultimo_ok IS NOT NULL
   AND ack.ack_ultimo_ok >= pipe.pipeline_0710_ultimo_ok) AS pwa_sync_ack_corrente,
  (ack.ack_ultimo_ok IS NOT NULL
   AND pipe.pipeline_0710_ultimo_ok IS NOT NULL
   AND ack.ack_ultimo_ok >= pipe.pipeline_0710_ultimo_ok
   AND promo.classificazione_ultima IS NOT NULL
   AND ack.ack_ultimo_ok >= promo.classificazione_ultima
   AND reco.recompute_ultimo IS NOT NULL
   AND ack.ack_ultimo_ok >= reco.recompute_ultimo) AS sync_pwa_dopo_classificazione,
  perim.contendibili_fuori_perimetro,
  perim.privati_fuori_perimetro
FROM portali, mism, promo, reco, pipe, ack, perim;

REVOKE ALL ON public.civiko_padova_release_gate_v FROM PUBLIC;
GRANT SELECT ON public.civiko_padova_release_gate_v TO service_role;