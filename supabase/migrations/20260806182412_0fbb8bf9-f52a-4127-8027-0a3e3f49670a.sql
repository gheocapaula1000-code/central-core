-- Gate3: prove derivate dall'audit reale della corsa corrente, latest-attempt by started_at.
DROP VIEW IF EXISTS public.civiko_padova_release_gate_v;
CREATE VIEW public.civiko_padova_release_gate_v AS
WITH pipe0510 AS (
  SELECT ar.pipeline_run_id, ar.started_at, ar.finished_at, ar.ok, ar.status
  FROM public.civiko_orchestrator_action_runs ar
  WHERE ar.action = '__pipeline__' AND ar.pipeline = 'pipeline_0510'
    AND ar.pipeline_run_id IS NOT NULL
  ORDER BY ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
  LIMIT 1
), pipe0545 AS (
  SELECT ar.pipeline_run_id, ar.started_at, ar.finished_at, ar.ok, ar.status
  FROM public.civiko_orchestrator_action_runs ar
  WHERE ar.action = '__pipeline__' AND ar.pipeline = 'pipeline_0545'
    AND ar.pipeline_run_id IS NOT NULL
  ORDER BY ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
  LIMIT 1
), pipe AS (
  SELECT ar.pipeline_run_id, ar.started_at, ar.finished_at, ar.ok, ar.status
  FROM public.civiko_orchestrator_action_runs ar
  WHERE ar.action = '__pipeline__' AND ar.pipeline = 'pipeline_0710'
    AND ar.pipeline_run_id IS NOT NULL
  ORDER BY ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
  LIMIT 1
),
-- Ultimo tentativo per azione DENTRO la corsa 0510 corrente (match esatto su pipeline_run_id).
steps0510 AS (
  SELECT DISTINCT ON (ar.action) ar.action, ar.ok, ar.status, ar.finished_at, ar.result
  FROM public.civiko_orchestrator_action_runs ar
  JOIN pipe0510 p ON p.pipeline_run_id = ar.pipeline_run_id
  WHERE ar.action IN ('portal_casa','apify_immobiliare','apify_idealista','apify_subito')
  ORDER BY ar.action, ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
),
steps0545 AS (
  SELECT DISTINCT ON (ar.action) ar.action, ar.ok, ar.status, ar.finished_at, ar.result
  FROM public.civiko_orchestrator_action_runs ar
  JOIN pipe0545 p ON p.pipeline_run_id = ar.pipeline_run_id
  WHERE ar.action IN ('collect_pending','private_leads_classify','contendibili_recompute')
  ORDER BY ar.action, ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
),
portali AS (
  SELECT count(*)::bigint AS portali_freschi
  FROM steps0510 s
  WHERE s.ok IS TRUE
    AND s.finished_at IS NOT NULL
    AND s.status BETWEEN 200 AND 299
),
classif AS (
  SELECT s.finished_at AS classificazione_ultima,
         (s.ok IS TRUE AND s.status BETWEEN 200 AND 299) AS classificazione_ok
  FROM steps0545 s
  WHERE s.action = 'private_leads_classify'
),
reco AS (
  SELECT s.finished_at AS recompute_ultimo,
         (s.ok IS TRUE AND s.status BETWEEN 200 AND 299) AS recompute_ok
  FROM steps0545 s
  WHERE s.action = 'contendibili_recompute'
),
ack AS (
  SELECT a.run_id, a.pipeline_run_id, a.started_at, a.finished_at, a.counts
  FROM public.civiko_pwa_sync_acks a
  JOIN pipe p ON p.pipeline_run_id = a.pipeline_run_id
  WHERE a.ok IS TRUE
    AND a.error_code IS NULL
    AND COALESCE(a.municipality, a.scope_comune) = 'Padova'
    AND array_length(a.commercial_zone_slugs, 1) = 8
    AND public.civiko_pwa_counts_contract_ok(a.counts)
    AND p.finished_at IS NOT NULL
    AND a.started_at > p.finished_at
    AND a.finished_at > a.started_at
  ORDER BY a.finished_at DESC
  LIMIT 1
),
mism AS (SELECT count(*) AS mismatch_professionale FROM public.civiko_padova_tipo_lead_mismatch_v),
promo AS (
  SELECT count(*) AS listings_freschi
  FROM public.padova_listings l
  WHERE l.expired_at IS NULL
    AND lower(COALESCE(l.comune,'')) = 'padova'
    AND l.tipo_lead IS NOT NULL
),
tot AS (SELECT count(*) AS contendibili_totali FROM public.padova_contendibili),
perim AS (
  SELECT
    (SELECT count(*) FROM public.padova_contendibili pc
      WHERE pc.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = pc.commercial_zone_slug)
    ) AS contendibili_fuori_perimetro,
    (SELECT count(*) FROM public.padova_listings l
      WHERE l.expired_at IS NULL
        AND upper(COALESCE(l.tipo_lead,'')) IN ('PRIVATO','PRIVATO_STANCO')
        AND lower(COALESCE(l.comune,'')) = 'padova'
        AND l.commercial_zone_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = l.commercial_zone_slug)
    ) AS privati_fuori_perimetro
)
SELECT
  COALESCE(portali.portali_freschi, 0) AS portali_freschi,
  mism.mismatch_professionale,
  promo.listings_freschi,
  classif.classificazione_ultima,
  reco.recompute_ultimo,
  tot.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ok IS TRUE) AS recompute_corrente,
  pipe0510.pipeline_run_id AS pipeline_0510_run_id,
  pipe0545.pipeline_run_id AS pipeline_0545_run_id,
  pipe.pipeline_run_id AS pipeline_0710_run_id,
  pipe.finished_at AS pipeline_0710_ultimo,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299) AS pipeline_0710_ok,
  ack.finished_at AS pwa_sync_ack_ultimo_ok,
  ack.counts AS pwa_sync_ack_counts,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299 AND ack.run_id IS NOT NULL) AS pwa_sync_ack_corrente,
  (
    pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299
    AND ack.run_id IS NOT NULL
    AND reco.recompute_ok IS TRUE
    AND classif.classificazione_ok IS TRUE
    AND classif.classificazione_ultima IS NOT NULL
    AND ack.started_at > classif.classificazione_ultima
  ) AS sync_pwa_dopo_classificazione,
  perim.contendibili_fuori_perimetro,
  perim.privati_fuori_perimetro
FROM mism, promo, tot, perim
LEFT JOIN pipe0510 ON true
LEFT JOIN pipe0545 ON true
LEFT JOIN pipe ON true
LEFT JOIN portali ON true
LEFT JOIN classif ON true
LEFT JOIN reco ON true
LEFT JOIN ack ON true;