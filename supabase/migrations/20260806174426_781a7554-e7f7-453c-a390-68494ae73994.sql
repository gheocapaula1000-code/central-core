-- ═══════════════════════════════════════════════════════════════════════════
-- Civiko One / Padova — repair forward dell'ack di sincronizzazione PWA.
-- Additivo: nessun DELETE, nessun DROP di dati (tabella live a 0 righe).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Colonne canoniche del contratto PWA -------------------------------------
ALTER TABLE public.civiko_pwa_sync_acks
  ADD COLUMN IF NOT EXISTS municipality text,
  ADD COLUMN IF NOT EXISTS commercial_zone_slugs text[];

-- Backfill difensivo dagli alias legacy (tabella vuota: no-op in pratica).
UPDATE public.civiko_pwa_sync_acks
   SET municipality = COALESCE(municipality, scope_comune),
       commercial_zone_slugs = COALESCE(commercial_zone_slugs, scope_slugs)
 WHERE municipality IS NULL OR commercial_zone_slugs IS NULL;

ALTER TABLE public.civiko_pwa_sync_acks
  ALTER COLUMN municipality SET NOT NULL,
  ALTER COLUMN commercial_zone_slugs SET NOT NULL;

-- Gli alias legacy restano in tabella ma non sono più parte del contratto.
ALTER TABLE public.civiko_pwa_sync_acks
  ALTER COLUMN scope_comune DROP NOT NULL,
  ALTER COLUMN scope_slugs DROP NOT NULL,
  ALTER COLUMN idempotency_key DROP NOT NULL;

-- 2) Vincoli canonici --------------------------------------------------------
ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_municipality_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_municipality_ck
  CHECK (municipality = 'Padova');

ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_zone_slugs_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_zone_slugs_ck
  CHECK (
    array_length(commercial_zone_slugs, 1) = 8
    AND commercial_zone_slugs <@ ARRAY[
      'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria',
      'ovest-chiesanuova-brentelle']
    AND ARRAY[
      'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria',
      'ovest-chiesanuova-brentelle'] <@ commercial_zone_slugs
  );

-- Alias legacy: se valorizzati devono restare coerenti, ma possono mancare.
ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_scope_comune_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_scope_comune_ck
  CHECK (scope_comune IS NULL OR scope_comune = 'Padova');

ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_scope_slugs_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_scope_slugs_ck
  CHECK (scope_slugs IS NULL OR array_length(scope_slugs, 1) = 8);

-- error_code obbligatorio SOLO quando ok = false, assente quando ok = true.
ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_error_coherence_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_error_coherence_ck
  CHECK ((ok IS TRUE AND error_code IS NULL) OR (ok IS FALSE AND error_code IS NOT NULL));

-- run_id (PK) e pipeline_run_id restano unici: garanzia di immutabilità.
CREATE UNIQUE INDEX IF NOT EXISTS civiko_pwa_sync_acks_run_id_uq
  ON public.civiko_pwa_sync_acks (run_id);

-- 3) Contratto dei 9 conteggi: chiavi esatte, interi >= 0 --------------------
CREATE OR REPLACE FUNCTION public.civiko_pwa_counts_contract_ok(p_counts jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_counts IS NOT NULL
     AND jsonb_typeof(p_counts) = 'object'
     AND (
       SELECT array_agg(k ORDER BY k)
         FROM jsonb_object_keys(p_counts) k
     ) = ARRAY[
       'cambi_agenzia','contendibili','dashboard','mappa','offmarket',
       'privati','quartieri','radar','ribassi']
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_each(p_counts) e
        WHERE jsonb_typeof(e.value) <> 'number'
           OR (e.value)::numeric < 0
           OR (e.value)::numeric <> trunc((e.value)::numeric)
     )
$$;

-- 4) Release gate: recompute dal 0545, ack dall'ESATTO ultimo 0710 -----------
DROP VIEW IF EXISTS public.civiko_padova_release_gate_v;
CREATE VIEW public.civiko_padova_release_gate_v AS
WITH w AS (
  SELECT now() - interval '4 hours' AS since
), portali AS (
  SELECT count(DISTINCT lower(i.portal)) AS portali_freschi
    FROM padova_collect_v2_items i, w
   WHERE lower(coalesce(i.citta,'')) = 'padova'
     AND lower(i.portal) = ANY (ARRAY['casa','immobiliare','idealista','subito'])
     AND (i.created_at >= w.since OR i.updated_at >= w.since)
), mism AS (
  SELECT count(*) AS mismatch_professionale FROM civiko_padova_tipo_lead_mismatch_v
), promo AS (
  SELECT count(*) AS listings_freschi, max(l.last_seen_at) AS classificazione_ultima
    FROM padova_listings l, w
   WHERE l.expired_at IS NULL
     AND lower(coalesce(l.comune,'')) = 'padova'
     AND l.tipo_lead IS NOT NULL
     AND l.last_seen_at >= w.since
), tot AS (
  SELECT count(*) AS contendibili_totali FROM padova_contendibili
),
-- ESATTO ultimo tentativo 0710 (anche fallito o in corso): latest-wins.
pipe AS (
  SELECT ar.pipeline_run_id, ar.finished_at, ar.ok, ar.status
    FROM civiko_orchestrator_action_runs ar, w
   WHERE ar.action = '__pipeline__'
     AND ar.pipeline = 'pipeline_0710'
     AND ar.pipeline_run_id IS NOT NULL
     AND coalesce(ar.finished_at, ar.started_at) >= w.since
   ORDER BY coalesce(ar.finished_at, ar.started_at) DESC
   LIMIT 1
), ack AS (
  SELECT a.run_id, a.pipeline_run_id, a.finished_at, a.counts
    FROM civiko_pwa_sync_acks a
    JOIN pipe p ON p.pipeline_run_id = a.pipeline_run_id
   WHERE a.ok IS TRUE
     AND a.error_code IS NULL
     AND coalesce(a.municipality, a.scope_comune) = 'Padova'
     AND array_length(a.commercial_zone_slugs, 1) = 8
     AND public.civiko_pwa_counts_contract_ok(a.counts)
     AND p.finished_at IS NOT NULL
     AND a.started_at > p.finished_at
     AND a.finished_at > a.started_at
   ORDER BY a.finished_at DESC
   LIMIT 1
),
-- Il recompute appartiene all'ESATTO ultimo 0545, non al run 0710.
pipe0545 AS (
  SELECT ar.pipeline_run_id, ar.finished_at, ar.ok, ar.status
    FROM civiko_orchestrator_action_runs ar, w
   WHERE ar.action = '__pipeline__'
     AND ar.pipeline = 'pipeline_0545'
     AND ar.pipeline_run_id IS NOT NULL
     AND coalesce(ar.finished_at, ar.started_at) >= w.since
   ORDER BY coalesce(ar.finished_at, ar.started_at) DESC
   LIMIT 1
), reco AS (
  SELECT ar.finished_at AS recompute_ultimo, ar.ok AS recompute_ok
    FROM civiko_orchestrator_action_runs ar
    JOIN pipe0545 p ON p.pipeline_run_id = ar.pipeline_run_id
   WHERE ar.action ILIKE '%recompute%'
     AND ar.finished_at IS NOT NULL
   ORDER BY ar.finished_at DESC
   LIMIT 1
), perim AS (
  SELECT
    (SELECT count(*) FROM padova_contendibili pc
      WHERE pc.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM civiko_commercial_zones z WHERE z.slug = pc.commercial_zone_slug)
    ) AS contendibili_fuori_perimetro,
    (SELECT count(*) FROM padova_listings l
      WHERE l.expired_at IS NULL
        AND upper(coalesce(l.tipo_lead,'')) = ANY (ARRAY['PRIVATO','PRIVATO_STANCO'])
        AND lower(coalesce(l.comune,'')) = 'padova'
        AND l.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM civiko_commercial_zones z WHERE z.slug = l.commercial_zone_slug)
    ) AS privati_fuori_perimetro
)
SELECT
  portali.portali_freschi,
  mism.mismatch_professionale,
  promo.listings_freschi,
  promo.classificazione_ultima,
  reco.recompute_ultimo,
  tot.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ok IS TRUE) AS recompute_corrente,
  pipe0545.pipeline_run_id AS pipeline_0545_run_id,
  pipe.pipeline_run_id AS pipeline_0710_run_id,
  pipe.finished_at AS pipeline_0710_ultimo,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299) AS pipeline_0710_ok,
  ack.finished_at AS pwa_sync_ack_ultimo_ok,
  ack.counts AS pwa_sync_ack_counts,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299 AND ack.run_id IS NOT NULL) AS pwa_sync_ack_corrente,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299 AND ack.run_id IS NOT NULL
   AND reco.recompute_ok IS TRUE
   AND promo.classificazione_ultima IS NOT NULL
   AND ack.finished_at >= promo.classificazione_ultima) AS sync_pwa_dopo_classificazione,
  perim.contendibili_fuori_perimetro,
  perim.privati_fuori_perimetro
FROM portali, mism, promo, tot, perim
LEFT JOIN pipe ON true
LEFT JOIN pipe0545 ON true
LEFT JOIN ack ON true
LEFT JOIN reco ON true;