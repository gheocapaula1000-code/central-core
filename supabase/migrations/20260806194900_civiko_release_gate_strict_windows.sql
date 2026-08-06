-- ─────────────────────────────────────────────────────────────────────────
-- CIVIKO-ONLY forward addendum (release window). Ricrea SOLO la view
-- public.civiko_padova_release_gate_v aggiungendo la validità INTERNA
-- STRETTA della finestra di ogni latest attempt (started_at < finished_at)
-- per pipeline_0510 / pipeline_0545 / pipeline_0710 / ack, e richiedendo un
-- checked_at finito strettamente successivo a ack.finished_at.
-- L'ordine cross-run preesistente resta invariato. Nessun'altra modifica.
-- ─────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.civiko_padova_release_gate_v;
CREATE VIEW public.civiko_padova_release_gate_v
WITH (security_invoker = true)
AS
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
), steps0510 AS (
  SELECT DISTINCT ON (ar.action) ar.action, ar.ok, ar.status, ar.finished_at, ar.result
  FROM public.civiko_orchestrator_action_runs ar
  JOIN pipe0510 p ON p.pipeline_run_id = ar.pipeline_run_id
  WHERE ar.action IN ('portal_casa','apify_immobiliare','apify_idealista','apify_subito')
  ORDER BY ar.action, ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
), steps0545 AS (
  SELECT DISTINCT ON (ar.action) ar.action, ar.ok, ar.status, ar.finished_at, ar.result
  FROM public.civiko_orchestrator_action_runs ar
  JOIN pipe0545 p ON p.pipeline_run_id = ar.pipeline_run_id
  WHERE ar.action IN ('collect_pending','private_leads_classify',
                      'contendibili_recompute','contendibili_image_certify',
                      'contendibili_pairs')
  ORDER BY ar.action, ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
), step_ok AS (
  SELECT s.action,
         (s.ok IS TRUE AND s.status BETWEEN 200 AND 299 AND s.finished_at IS NOT NULL) AS ok_now,
         s.result, s.finished_at
  FROM steps0510 s
  UNION ALL
  SELECT s.action,
         (s.ok IS TRUE AND s.status BETWEEN 200 AND 299 AND s.finished_at IS NOT NULL) AS ok_now,
         s.result, s.finished_at
  FROM steps0545 s
), portali AS (
  SELECT count(*) FILTER (WHERE s.ok_now) AS portali_freschi,
    -- Prova di LANCIO corrente per ciascun portale.
    bool_or(s.action = 'portal_casa' AND s.ok_now
            AND jsonb_path_exists(s.result, '$.**.queue_id')) AS casa_launch_ok,
    bool_or(s.action = 'apify_immobiliare' AND s.ok_now
            AND jsonb_path_exists(s.result, '$.**.started_count ? (@ > 0)')
            AND (jsonb_path_exists(s.result, '$.**.run_id')
                 OR jsonb_path_exists(s.result, '$.**.dataset_id'))) AS immobiliare_launch_ok,
    bool_or(s.action = 'apify_idealista' AND s.ok_now
            AND jsonb_path_exists(s.result, '$.**.started_count ? (@ > 0)')
            AND (jsonb_path_exists(s.result, '$.**.run_id')
                 OR jsonb_path_exists(s.result, '$.**.dataset_id'))) AS idealista_launch_ok,
    bool_or(s.action = 'apify_subito' AND s.ok_now
            AND jsonb_path_exists(s.result, '$.**.started_count ? (@ > 0)')
            AND (jsonb_path_exists(s.result, '$.**.run_id')
                 OR jsonb_path_exists(s.result, '$.**.dataset_id'))) AS subito_launch_ok
  FROM step_ok s
  WHERE s.action IN ('portal_casa','apify_immobiliare','apify_idealista','apify_subito')
), imports AS (
  SELECT
    bool_or(s.ok_now AND (
      jsonb_path_exists(s.result, '$.**.imports_count ? (@ > 0)')
      OR (jsonb_path_exists(s.result, '$.**.zero_novelty ? (@ == true)')
          AND jsonb_path_exists(s.result, '$.**.scanned ? (@ > 0)'))
    )) AS import_corrente_ok,
    bool_or(s.ok_now AND jsonb_path_exists(s.result, '$.**.imports_count ? (@ > 0)')) AS import_nuovi_ok
  FROM step_ok s WHERE s.action = 'collect_pending'
), classif AS (
  SELECT s.finished_at AS classificazione_ultima, s.ok_now AS classificazione_ok
  FROM step_ok s WHERE s.action = 'private_leads_classify'
), reco AS (
  SELECT s.finished_at AS recompute_ultimo, s.ok_now AS recompute_ok,
         jsonb_typeof(s.result) = 'object' AND s.result <> '{}'::jsonb AS recompute_snapshot_ok
  FROM step_ok s WHERE s.action = 'contendibili_recompute'
), imgstep AS (
  SELECT bool_or(s.ok_now) AS image_step_ok
  FROM step_ok s WHERE s.action = 'contendibili_image_certify'
), imgattempt AS (
  SELECT count(*) AS image_attempts_correnti
  FROM public.civiko_image_certify_attempts a
  JOIN pipe0545 p ON p.pipeline_run_id = a.last_pipeline_run_id
), fingerprints AS (
  SELECT count(*) AS fingerprint_correnti
  FROM public.civiko_listing_image_fingerprints f, pipe0545 p
  WHERE p.started_at IS NOT NULL AND f.created_at >= p.started_at
), snapshot AS (
  SELECT count(*) AS contendibili_snapshot_correnti
  FROM public.padova_contendibili c, pipe0545 p
  WHERE p.started_at IS NOT NULL AND c.created_at >= p.started_at
), ack AS (
  SELECT a.run_id, a.pipeline_run_id, a.started_at, a.finished_at, a.counts
  FROM public.civiko_pwa_sync_acks a
  JOIN pipe p ON p.pipeline_run_id = a.pipeline_run_id
  WHERE a.ok IS TRUE AND a.error_code IS NULL
    AND COALESCE(a.municipality, a.scope_comune) = 'Padova'
    AND array_length(a.commercial_zone_slugs, 1) = 8
    AND public.civiko_pwa_counts_contract_ok(a.counts)
    AND p.finished_at IS NOT NULL
    AND a.started_at IS NOT NULL AND a.finished_at IS NOT NULL
    AND p.started_at IS NOT NULL AND p.started_at < p.finished_at
    AND a.started_at > p.finished_at
    AND a.finished_at > a.started_at
  ORDER BY a.started_at DESC, a.finished_at DESC
  LIMIT 1
), mism AS (
  SELECT count(*) AS mismatch_professionale FROM public.civiko_padova_tipo_lead_mismatch_v
), promo AS (
  SELECT count(*) AS listings_freschi
  FROM public.padova_listings l
  WHERE l.expired_at IS NULL AND lower(COALESCE(l.comune,'')) = 'padova' AND l.tipo_lead IS NOT NULL
), tot AS (
  SELECT count(*) AS contendibili_totali FROM public.padova_contendibili
), perim AS (
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
  now() AS checked_at,
  COALESCE(portali.portali_freschi, 0) AS portali_freschi,
  mism.mismatch_professionale,
  promo.listings_freschi,
  classif.classificazione_ultima,
  reco.recompute_ultimo,
  tot.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ok IS TRUE) AS recompute_corrente,
  COALESCE(reco.recompute_snapshot_ok, false) AS categoria_snapshot_corrente,
  COALESCE(snapshot.contendibili_snapshot_correnti, 0) AS contendibili_snapshot_correnti,
  COALESCE(imgstep.image_step_ok, false) AS image_certify_corrente,
  COALESCE(imgattempt.image_attempts_correnti, 0) AS image_attempts_correnti,
  COALESCE(fingerprints.fingerprint_correnti, 0) AS fingerprint_correnti,
  COALESCE(imports.import_corrente_ok, false) AS import_corrente_ok,
  COALESCE(imports.import_nuovi_ok, false) AS import_nuovi_ok,
  (COALESCE(portali.casa_launch_ok,false) AND COALESCE(portali.immobiliare_launch_ok,false)
   AND COALESCE(portali.idealista_launch_ok,false) AND COALESCE(portali.subito_launch_ok,false))
    AS portali_lancio_corrente_ok,
  COALESCE(portali.casa_launch_ok,false) AS portale_casa_lancio_ok,
  COALESCE(portali.immobiliare_launch_ok,false) AS portale_immobiliare_lancio_ok,
  COALESCE(portali.idealista_launch_ok,false) AS portale_idealista_lancio_ok,
  COALESCE(portali.subito_launch_ok,false) AS portale_subito_lancio_ok,
  pipe0510.pipeline_run_id AS pipeline_0510_run_id,
  pipe0510.started_at AS pipeline_0510_avvio,
  pipe0510.finished_at AS pipeline_0510_ultimo,
  (pipe0510.ok IS TRUE AND pipe0510.status BETWEEN 200 AND 299 AND (pipe0510.started_at IS NOT NULL AND pipe0510.finished_at IS NOT NULL AND pipe0510.started_at < pipe0510.finished_at)) AS pipeline_0510_ok,
  pipe0545.pipeline_run_id AS pipeline_0545_run_id,
  pipe0545.started_at AS pipeline_0545_avvio,
  pipe0545.finished_at AS pipeline_0545_ultimo,
  (pipe0545.ok IS TRUE AND pipe0545.status BETWEEN 200 AND 299 AND (pipe0545.started_at IS NOT NULL AND pipe0545.finished_at IS NOT NULL AND pipe0545.started_at < pipe0545.finished_at)) AS pipeline_0545_ok,
  pipe.pipeline_run_id AS pipeline_0710_run_id,
  pipe.started_at AS pipeline_0710_avvio,
  pipe.finished_at AS pipeline_0710_ultimo,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299 AND (pipe.started_at IS NOT NULL AND pipe.finished_at IS NOT NULL AND pipe.started_at < pipe.finished_at)) AS pipeline_0710_ok,
  ack.pipeline_run_id AS pwa_sync_ack_pipeline_run_id,
  ack.started_at AS pwa_sync_ack_avvio,
  ack.finished_at AS pwa_sync_ack_ultimo_ok,
  ack.counts AS pwa_sync_ack_counts,
  (pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299 AND ack.run_id IS NOT NULL) AS pwa_sync_ack_corrente,
  (
    pipe0510.ok IS TRUE AND pipe0510.status BETWEEN 200 AND 299
    AND (pipe0510.started_at IS NOT NULL AND pipe0510.finished_at IS NOT NULL AND pipe0510.started_at < pipe0510.finished_at)
    AND pipe0545.ok IS TRUE AND pipe0545.status BETWEEN 200 AND 299
    AND (pipe0545.started_at IS NOT NULL AND pipe0545.finished_at IS NOT NULL AND pipe0545.started_at < pipe0545.finished_at)
    AND pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299
    AND (pipe.started_at IS NOT NULL AND pipe.finished_at IS NOT NULL AND pipe.started_at < pipe.finished_at)
    AND pipe0510.finished_at < pipe0545.started_at
    AND pipe0545.finished_at < pipe.started_at
    AND ack.started_at IS NOT NULL AND ack.finished_at IS NOT NULL
    AND pipe.finished_at < ack.started_at
    AND ack.started_at < ack.finished_at
    AND now() IS NOT NULL AND ack.finished_at < now()
  ) AS release_order_ok,
  (
    pipe.ok IS TRUE AND pipe.status BETWEEN 200 AND 299 AND ack.run_id IS NOT NULL
    AND reco.recompute_ok IS TRUE AND classif.classificazione_ok IS TRUE
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
LEFT JOIN imports ON true
LEFT JOIN classif ON true
LEFT JOIN reco ON true
LEFT JOIN imgstep ON true
LEFT JOIN imgattempt ON true
LEFT JOIN fingerprints ON true
LEFT JOIN snapshot ON true
LEFT JOIN ack ON true;

REVOKE ALL ON public.civiko_padova_release_gate_v FROM anon, authenticated;
GRANT SELECT ON public.civiko_padova_release_gate_v TO service_role;