-- Civiko One / Padova — P0 sync-ack forward fix (isolato).
ALTER TABLE public.civiko_pwa_sync_acks
  ADD COLUMN IF NOT EXISTS pipeline_run_id uuid;

DELETE FROM public.civiko_pwa_sync_acks WHERE pipeline_run_id IS NULL;

ALTER TABLE public.civiko_pwa_sync_acks
  ALTER COLUMN pipeline_run_id SET NOT NULL;

ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_pipeline_run_uq;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_pipeline_run_uq UNIQUE (pipeline_run_id);

ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_scope_slugs_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_scope_slugs_ck CHECK (
    array_length(scope_slugs, 1) = 8
    AND scope_slugs <@ ARRAY[
      'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria',
      'ovest-chiesanuova-brentelle'
    ]::text[]
    AND ARRAY[
      'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria',
      'ovest-chiesanuova-brentelle'
    ]::text[] <@ scope_slugs
  );

CREATE OR REPLACE FUNCTION public.civiko_pwa_counts_contract_ok(p_counts jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT jsonb_typeof(p_counts) = 'object'
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_counts) AS k)
         = ARRAY['cambi_agenzia','contendibili','dashboard','mappa','offmarket',
                 'privati','quartieri','radar','ribassi']::text[]
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_each(p_counts) AS e(k, v)
            WHERE jsonb_typeof(e.v) <> 'number'
               OR (e.v)::text::numeric < 0
               OR (e.v)::text::numeric <> trunc((e.v)::text::numeric)
         )
$fn$;

ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_counts_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_counts_ck
  CHECK (public.civiko_pwa_counts_contract_ok(counts));

ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_window_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_window_ck CHECK (finished_at > started_at);

CREATE INDEX IF NOT EXISTS civiko_pwa_sync_acks_pipeline_run_idx
  ON public.civiko_pwa_sync_acks (pipeline_run_id);

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
tot AS (SELECT count(*) AS contendibili_totali FROM public.padova_contendibili),
pipe AS (
  SELECT r.run_id, r.finished_at, r.ok
    FROM public.civiko_pipeline_runs r, w
   WHERE r.pipeline = 'pipeline_0710'
     AND r.finished_at IS NOT NULL
     AND r.finished_at >= w.since
   ORDER BY r.finished_at DESC
   LIMIT 1
),
ack AS (
  SELECT a.run_id, a.pipeline_run_id, a.finished_at, a.counts
    FROM public.civiko_pwa_sync_acks a
    JOIN pipe p ON p.run_id = a.pipeline_run_id
   WHERE a.ok IS TRUE
     AND a.error_code IS NULL
     AND a.scope_comune = 'Padova'
     AND array_length(a.scope_slugs, 1) = 8
     AND a.started_at > p.finished_at
     AND a.finished_at > a.started_at
   ORDER BY a.finished_at DESC
   LIMIT 1
),
reco AS (
  SELECT ar.finished_at AS recompute_ultimo, ar.ok AS recompute_ok
    FROM public.civiko_orchestrator_action_runs ar
    JOIN pipe p ON p.run_id = ar.run_id
   WHERE ar.action ILIKE '%recompute%'
     AND ar.finished_at IS NOT NULL
   ORDER BY ar.finished_at DESC
   LIMIT 1
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
  tot.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ok IS TRUE) AS recompute_corrente,
  pipe.run_id AS pipeline_0710_run_id,
  pipe.finished_at AS pipeline_0710_ultimo,
  (pipe.ok IS TRUE) AS pipeline_0710_ok,
  ack.finished_at AS pwa_sync_ack_ultimo_ok,
  ack.counts AS pwa_sync_ack_counts,
  (pipe.ok IS TRUE AND ack.run_id IS NOT NULL) AS pwa_sync_ack_corrente,
  (pipe.ok IS TRUE
   AND ack.run_id IS NOT NULL
   AND reco.recompute_ok IS TRUE
   AND promo.classificazione_ultima IS NOT NULL
   AND ack.finished_at >= promo.classificazione_ultima) AS sync_pwa_dopo_classificazione,
  perim.contendibili_fuori_perimetro,
  perim.privati_fuori_perimetro
FROM portali, mism, promo, tot, perim
LEFT JOIN pipe ON true
LEFT JOIN ack ON true
LEFT JOIN reco ON true;

REVOKE ALL ON public.civiko_padova_release_gate_v FROM PUBLIC;
GRANT SELECT ON public.civiko_padova_release_gate_v TO service_role;