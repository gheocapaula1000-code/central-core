CREATE TABLE IF NOT EXISTS public.civiko_apify_run_reconciliations (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  portal text NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  reason text NOT NULL,
  rule text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.civiko_apify_run_reconciliations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.civiko_apify_run_reconciliations_id_seq TO service_role;

ALTER TABLE public.civiko_apify_run_reconciliations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_apify_reconciliations" ON public.civiko_apify_run_reconciliations;
CREATE POLICY "service_role_all_apify_reconciliations"
  ON public.civiko_apify_run_reconciliations
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_civiko_apify_run_reconciliations_run
  ON public.civiko_apify_run_reconciliations (run_id, reconciled_at DESC);

CREATE OR REPLACE VIEW public.civiko_padova_release_gate_v AS
WITH pipe0510 AS (
  SELECT ar.pipeline_run_id, ar.pipeline, ar.started_at, ar.finished_at, ar.ok, ar.status
  FROM public.civiko_orchestrator_action_runs ar
  WHERE ar.action = '__pipeline__'
    AND ar.pipeline = ANY (ARRAY['pipeline_0510'::text, 'pipeline_0510_capped'::text])
    AND ar.pipeline_run_id IS NOT NULL
  ORDER BY ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
  LIMIT 1
), pipe0545 AS (
  SELECT ar.pipeline_run_id, ar.started_at, ar.finished_at, ar.ok, ar.status
  FROM public.civiko_orchestrator_action_runs ar
  WHERE ar.action = '__pipeline__' AND ar.pipeline = 'pipeline_0545' AND ar.pipeline_run_id IS NOT NULL
  ORDER BY ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
  LIMIT 1
), pipe AS (
  SELECT ar.pipeline_run_id, ar.started_at, ar.finished_at, ar.ok, ar.status
  FROM public.civiko_orchestrator_action_runs ar
  WHERE ar.action = '__pipeline__' AND ar.pipeline = 'pipeline_0710' AND ar.pipeline_run_id IS NOT NULL
  ORDER BY ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
  LIMIT 1
), steps0510 AS (
  SELECT DISTINCT ON (ar.action) ar.action, ar.ok, ar.status, ar.started_at, ar.finished_at, ar.result
  FROM public.civiko_orchestrator_action_runs ar
  JOIN pipe0510 p ON p.pipeline_run_id = ar.pipeline_run_id
  WHERE ar.action = ANY (ARRAY[
    'portal_casa'::text, 'apify_immobiliare'::text, 'apify_idealista'::text, 'apify_subito'::text,
    'portal_casa_capped'::text, 'apify_batch_capped'::text])
  ORDER BY ar.action, ar.started_at DESC, ar.attempt_no DESC, ar.created_at DESC, ar.id DESC
), casa_capped AS (
  SELECT bool_or(
           q.status = 'succeeded'::public.scraping_queue_status
           AND q.processing_status = 'succeeded'
           AND q.processed_at IS NOT NULL
           AND p.started_at IS NOT NULL
           AND q.processed_at >= p.started_at
         ) AS casa_capped_ok
  FROM steps0510 s
  CROSS JOIN pipe0510 p
  JOIN LATERAL jsonb_array_elements(COALESCE(s.result -> 'enqueued', '[]'::jsonb)) e ON true
  JOIN public.scraping_queue q ON q.id = NULLIF(e ->> 'queue_id', '')::uuid
  WHERE s.action = 'portal_casa_capped'
    AND s.ok IS TRUE AND s.status BETWEEN 200 AND 299 AND s.finished_at IS NOT NULL
), apify_capped_runs AS (
  SELECT e ->> 'portal' AS portal,
         r.run_id,
         r.status AS run_status,
         r.items_count,
         r.cost_usd,
         r.cost_cap_usd,
         r.finished_at,
         (NULLIF(e ->> 'dataset_id', '') IS NOT NULL) AS dataset_ok,
         p.started_at AS pipe_started_at
  FROM steps0510 s
  CROSS JOIN pipe0510 p
  JOIN LATERAL jsonb_array_elements(COALESCE(s.result -> 'launched', '[]'::jsonb)) e ON true
  JOIN public.padova_apify_runs r ON r.run_id = NULLIF(e ->> 'run_id', '')
  WHERE s.action = 'apify_batch_capped'
    AND s.ok IS TRUE AND s.status BETWEEN 200 AND 299 AND s.finished_at IS NOT NULL
), apify_capped AS (
  SELECT portal,
         bool_or(
           run_status = 'SUCCEEDED'
           AND finished_at IS NOT NULL
           AND dataset_ok
           AND COALESCE(items_count, 0) > 0
           AND COALESCE(items_count, 0) <= 25
           AND cost_cap_usd IS NOT NULL
           AND (cost_usd IS NULL OR cost_usd <= cost_cap_usd)
           AND pipe_started_at IS NOT NULL
         ) AS portal_ok
  FROM apify_capped_runs
  GROUP BY portal
), capped_cost AS (
  SELECT bool_and(cost_cap_usd IS NOT NULL) AND COALESCE(sum(cost_cap_usd), 0) <= 2.0 AS cap_ok
  FROM (SELECT DISTINCT run_id, cost_cap_usd FROM apify_capped_runs) d
), down_raw AS (
  SELECT m.canon AS action, ar.ok, ar.status, ar.started_at, ar.finished_at, ar.result,
         ar.attempt_no, ar.created_at, ar.id
  FROM public.civiko_orchestrator_action_runs ar
  CROSS JOIN pipe0510 p
  CROSS JOIN LATERAL (
    SELECT CASE ar.action
      WHEN 'collect_pending' THEN 'collect_pending'
      WHEN 'private_leads_classify' THEN 'private_leads_classify'
      WHEN 'private_classify' THEN 'private_leads_classify'
      WHEN 'contendibili_recompute' THEN 'contendibili_recompute'
      WHEN 'contendibili_image_certify' THEN 'contendibili_image_certify'
      WHEN 'image_certify' THEN 'contendibili_image_certify'
      WHEN 'contendibili_pairs' THEN 'contendibili_pairs'
      WHEN 'image_pairs' THEN 'contendibili_pairs'
      ELSE NULL
    END
  ) m(canon)
  WHERE m.canon IS NOT NULL
    AND p.finished_at IS NOT NULL
    AND ar.started_at > p.finished_at
    AND (
      ar.pipeline_run_id = (SELECT pipeline_run_id FROM pipe0545)
      OR ar.pipeline_action = 'standalone'
    )
), down_agg AS (
  SELECT d.action,
         bool_or(d.ok IS TRUE AND d.status BETWEEN 200 AND 299 AND d.finished_at IS NOT NULL) AS has_success,
         max(d.finished_at) FILTER (WHERE d.ok IS TRUE AND d.status BETWEEN 200 AND 299) AS last_success_at,
         min(d.started_at) FILTER (WHERE d.ok IS TRUE AND d.status BETWEEN 200 AND 299) AS first_success_started_at,
         (array_agg(d.result ORDER BY d.started_at DESC, d.attempt_no DESC, d.created_at DESC, d.id DESC)
            FILTER (WHERE d.ok IS TRUE AND d.status BETWEEN 200 AND 299))[1] AS result
  FROM down_raw d
  GROUP BY d.action
), down_flags_real AS (
  SELECT a.action,
         a.result,
         a.last_success_at AS finished_at,
         a.first_success_started_at,
         a.has_success
           AND NOT EXISTS (
             SELECT 1 FROM down_raw f
             WHERE f.action = a.action
               AND f.ok IS FALSE
               AND f.status BETWEEN 200 AND 299
               AND f.started_at > a.last_success_at
           ) AS ok_now
  FROM down_agg a
), classify_na AS (
  -- Non applicabile SOLO con prova DB: nessun grezzo Subito successivo alla
  -- raccolta, run Subito privati terminale positivo e registrazione esplicita
  -- "no_recent_subito_staging" successiva alla raccolta stessa.
  SELECT r.created_at AS observed_at,
         (r.id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.padova_apify_runs pr, pipe0510 p
            WHERE pr.portal = 'subito_full' AND pr.status = 'SUCCEEDED'
              AND pr.finished_at IS NOT NULL AND pr.finished_at >= p.started_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.padova_subito_staging st, pipe0510 p
            WHERE st.fetched_at >= p.started_at
          )
         ) AS na_ok
  FROM public.private_leads_run_status r, pipe0510 p
  WHERE r.source = 'subito'
    AND r.status = 'skipped_no_data'
    AND r.notes ->> 'reason' = 'no_recent_subito_staging'
    AND p.finished_at IS NOT NULL
    AND r.created_at > p.finished_at
  ORDER BY r.created_at DESC
  LIMIT 1
), down_flags AS (
  SELECT action, result, finished_at, first_success_started_at, ok_now, false AS is_na
  FROM down_flags_real
  UNION ALL
  SELECT 'private_leads_classify'::text, NULL::jsonb, na.observed_at, na.observed_at, true, true
  FROM classify_na na
  WHERE na.na_ok
    AND NOT EXISTS (
      SELECT 1 FROM down_flags_real d WHERE d.action = 'private_leads_classify' AND d.ok_now
    )
), downwin AS (
  SELECT min(first_success_started_at) AS started_at,
         max(finished_at) AS finished_at,
         count(DISTINCT action) FILTER (WHERE ok_now) AS ok_actions
  FROM down_flags
), down_pick AS (
  SELECT DISTINCT ON (f.action) f.action, COALESCE(f.ok_now, false) AS ok_now, f.result, f.finished_at
  FROM down_flags f
  ORDER BY f.action, f.ok_now DESC NULLS LAST, f.finished_at DESC
), step_ok AS (
  SELECT s.action,
         (s.ok IS TRUE AND s.status BETWEEN 200 AND 299 AND s.finished_at IS NOT NULL) AS ok_now,
         s.result, s.finished_at
  FROM steps0510 s
  UNION ALL
  SELECT p.action, p.ok_now, p.result, p.finished_at FROM down_pick p
), portali AS (
  SELECT
    bool_or(s.action = 'portal_casa' AND s.ok_now AND jsonb_path_exists(s.result, '$.**."queue_id"')) AS casa_legacy_ok,
    bool_or(s.action = 'apify_immobiliare' AND s.ok_now AND jsonb_path_exists(s.result, '$.**."started_count"?(@ > 0)') AND (jsonb_path_exists(s.result, '$.**."run_id"') OR jsonb_path_exists(s.result, '$.**."dataset_id"'))) AS immobiliare_legacy_ok,
    bool_or(s.action = 'apify_idealista' AND s.ok_now AND jsonb_path_exists(s.result, '$.**."started_count"?(@ > 0)') AND (jsonb_path_exists(s.result, '$.**."run_id"') OR jsonb_path_exists(s.result, '$.**."dataset_id"'))) AS idealista_legacy_ok,
    bool_or(s.action = 'apify_subito' AND s.ok_now AND jsonb_path_exists(s.result, '$.**."started_count"?(@ > 0)') AND (jsonb_path_exists(s.result, '$.**."run_id"') OR jsonb_path_exists(s.result, '$.**."dataset_id"'))) AS subito_legacy_ok
  FROM step_ok s
  WHERE s.action = ANY (ARRAY['portal_casa'::text, 'apify_immobiliare'::text, 'apify_idealista'::text, 'apify_subito'::text])
), imports AS (
  SELECT bool_or(s.ok_now AND (jsonb_path_exists(s.result, '$.**."imports_count"?(@ > 0)') OR (jsonb_path_exists(s.result, '$.**."zero_novelty"?(@ == true)') AND jsonb_path_exists(s.result, '$.**."scanned"?(@ > 0)')))) AS import_corrente_ok,
         bool_or(s.ok_now AND jsonb_path_exists(s.result, '$.**."imports_count"?(@ > 0)')) AS import_nuovi_ok
  FROM step_ok s
  WHERE s.action = 'collect_pending'
), classif AS (
  SELECT s.finished_at AS classificazione_ultima, s.ok_now AS classificazione_ok
  FROM step_ok s WHERE s.action = 'private_leads_classify'
), reco AS (
  SELECT s.finished_at AS recompute_ultimo,
         s.ok_now AS recompute_ok,
         (jsonb_typeof(s.result) = 'object' AND s.result <> '{}'::jsonb) AS recompute_snapshot_ok
  FROM step_ok s WHERE s.action = 'contendibili_recompute'
), imgstep AS (
  SELECT bool_or(s.ok_now) AS image_step_ok FROM step_ok s WHERE s.action = 'contendibili_image_certify'
), imgattempt AS (
  SELECT count(*) AS image_attempts_correnti
  FROM public.civiko_image_certify_attempts a
  WHERE a.last_pipeline_run_id = (SELECT pipeline_run_id FROM pipe0545)
     OR (a.last_attempt_at >= (SELECT started_at FROM downwin) AND (SELECT started_at FROM downwin) IS NOT NULL)
), fingerprints AS (
  SELECT count(*) AS fingerprint_correnti
  FROM public.civiko_listing_image_fingerprints f
  WHERE f.created_at >= COALESCE((SELECT started_at FROM downwin), (SELECT started_at FROM pipe0545))
), snapshot AS (
  SELECT count(*) AS contendibili_snapshot_correnti
  FROM public.padova_contendibili c
  WHERE c.created_at >= COALESCE((SELECT started_at FROM downwin), (SELECT started_at FROM pipe0545))
), ack AS (
  SELECT a.run_id, a.pipeline_run_id, a.started_at, a.finished_at, a.counts
  FROM public.civiko_pwa_sync_acks a
  CROSS JOIN downwin w
  WHERE a.ok IS TRUE
    AND a.error_code IS NULL
    AND COALESCE(a.municipality, a.scope_comune) = 'Padova'
    AND array_length(a.commercial_zone_slugs, 1) = 8
    AND public.civiko_pwa_counts_contract_ok(a.counts)
    AND a.started_at IS NOT NULL AND a.finished_at IS NOT NULL AND a.finished_at > a.started_at
    AND w.finished_at IS NOT NULL AND a.started_at > w.finished_at
    AND (
      a.pipeline_run_id = (SELECT pipeline_run_id FROM pipe)
      OR a.pipeline_run_id = (SELECT pipeline_run_id FROM pipe0510)
    )
  ORDER BY a.started_at DESC, a.finished_at DESC
  LIMIT 1
), mism AS (
  SELECT count(*) AS mismatch_professionale FROM public.civiko_padova_tipo_lead_mismatch_v
), promo AS (
  SELECT count(*) AS listings_freschi
  FROM public.padova_listings l
  WHERE l.expired_at IS NULL AND lower(COALESCE(l.comune, '')) = 'padova' AND l.tipo_lead IS NOT NULL
), tot AS (
  SELECT count(*) AS contendibili_totali FROM public.padova_contendibili
), perim AS (
  SELECT (SELECT count(*) FROM public.padova_contendibili pc
          WHERE pc.commercial_zone_slug IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = pc.commercial_zone_slug)) AS contendibili_fuori_perimetro,
         (SELECT count(*) FROM public.padova_listings l
          WHERE l.expired_at IS NULL
            AND upper(COALESCE(l.tipo_lead, '')) = ANY (ARRAY['PRIVATO'::text, 'PRIVATO_STANCO'::text])
            AND lower(COALESCE(l.comune, '')) = 'padova'
            AND l.commercial_zone_slug IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.civiko_commercial_zones z WHERE z.slug = l.commercial_zone_slug)) AS privati_fuori_perimetro
), flags AS (
  SELECT
    COALESCE(portali.casa_legacy_ok, false) OR COALESCE((SELECT casa_capped_ok FROM casa_capped), false) AS casa_ok,
    COALESCE(portali.immobiliare_legacy_ok, false) OR COALESCE((SELECT portal_ok FROM apify_capped WHERE portal = 'immobiliare'), false) AS immobiliare_ok,
    COALESCE(portali.idealista_legacy_ok, false) OR COALESCE((SELECT portal_ok FROM apify_capped WHERE portal = 'idealista'), false) AS idealista_ok,
    COALESCE(portali.subito_legacy_ok, false) OR COALESCE((SELECT portal_ok FROM apify_capped WHERE portal = 'subito'), false) AS subito_ok,
    COALESCE((SELECT cap_ok FROM capped_cost), false) AS cap_ok,
    COALESCE((SELECT casa_capped_ok FROM casa_capped), false) AS casa_queue_processed_ok
  FROM portali
)
SELECT now() AS checked_at,
  (CASE WHEN flags.casa_ok THEN 1 ELSE 0 END + CASE WHEN flags.immobiliare_ok THEN 1 ELSE 0 END
   + CASE WHEN flags.idealista_ok THEN 1 ELSE 0 END + CASE WHEN flags.subito_ok THEN 1 ELSE 0 END)::bigint AS portali_freschi,
  mism.mismatch_professionale,
  promo.listings_freschi,
  classif.classificazione_ultima,
  reco.recompute_ultimo,
  tot.contendibili_totali,
  (reco.recompute_ultimo IS NOT NULL AND reco.recompute_ok IS TRUE) AS recompute_corrente,
  COALESCE(reco.recompute_snapshot_ok, false) AS categoria_snapshot_corrente,
  COALESCE(snapshot.contendibili_snapshot_correnti, 0::bigint) AS contendibili_snapshot_correnti,
  COALESCE(imgstep.image_step_ok, false) AS image_certify_corrente,
  COALESCE(imgattempt.image_attempts_correnti, 0::bigint) AS image_attempts_correnti,
  COALESCE(fingerprints.fingerprint_correnti, 0::bigint) AS fingerprint_correnti,
  COALESCE(imports.import_corrente_ok, false) AS import_corrente_ok,
  COALESCE(imports.import_nuovi_ok, false) AS import_nuovi_ok,
  (flags.casa_ok AND flags.immobiliare_ok AND flags.idealista_ok AND flags.subito_ok
     AND (pipe0510.pipeline <> 'pipeline_0510_capped' OR flags.cap_ok)) AS portali_lancio_corrente_ok,
  flags.casa_ok AS portale_casa_lancio_ok,
  flags.immobiliare_ok AS portale_immobiliare_lancio_ok,
  flags.idealista_ok AS portale_idealista_lancio_ok,
  flags.subito_ok AS portale_subito_lancio_ok,
  pipe0510.pipeline_run_id AS pipeline_0510_run_id,
  pipe0510.started_at AS pipeline_0510_avvio,
  pipe0510.finished_at AS pipeline_0510_ultimo,
  (pipe0510.ok IS TRUE AND pipe0510.status BETWEEN 200 AND 299 AND pipe0510.started_at IS NOT NULL
     AND pipe0510.finished_at IS NOT NULL AND pipe0510.started_at < pipe0510.finished_at) AS pipeline_0510_ok,
  pipe0545.pipeline_run_id AS pipeline_0545_run_id,
  pipe0545.started_at AS pipeline_0545_avvio,
  pipe0545.finished_at AS pipeline_0545_ultimo,
  (COALESCE(downwin.ok_actions, 0) >= 5) AS pipeline_0545_ok,
  pipe.pipeline_run_id AS pipeline_0710_run_id,
  pipe.started_at AS pipeline_0710_avvio,
  pipe.finished_at AS pipeline_0710_ultimo,
  (ack.run_id IS NOT NULL) AS pipeline_0710_ok,
  ack.pipeline_run_id AS pwa_sync_ack_pipeline_run_id,
  ack.started_at AS pwa_sync_ack_avvio,
  ack.finished_at AS pwa_sync_ack_ultimo_ok,
  ack.counts AS pwa_sync_ack_counts,
  (ack.run_id IS NOT NULL) AS pwa_sync_ack_corrente,
  (pipe0510.ok IS TRUE AND pipe0510.status BETWEEN 200 AND 299
     AND pipe0510.started_at IS NOT NULL AND pipe0510.finished_at IS NOT NULL
     AND pipe0510.started_at < pipe0510.finished_at
     AND COALESCE(downwin.ok_actions, 0) >= 5
     AND downwin.started_at IS NOT NULL AND downwin.finished_at IS NOT NULL
     AND pipe0510.finished_at < downwin.started_at
     AND downwin.started_at <= downwin.finished_at
     AND ack.started_at IS NOT NULL AND ack.finished_at IS NOT NULL
     AND downwin.finished_at < ack.started_at
     AND ack.started_at < ack.finished_at
     AND ack.finished_at < now()) AS release_order_ok,
  (ack.run_id IS NOT NULL AND reco.recompute_ok IS TRUE AND classif.classificazione_ok IS TRUE
     AND classif.classificazione_ultima IS NOT NULL AND reco.recompute_ultimo IS NOT NULL
     AND ack.started_at > classif.classificazione_ultima
     AND ack.started_at > reco.recompute_ultimo) AS sync_pwa_dopo_classificazione,
  perim.contendibili_fuori_perimetro,
  perim.privati_fuori_perimetro,
  pipe0510.pipeline AS pipeline_0510_kind,
  (pipe0510.pipeline = 'pipeline_0510_capped'
     AND flags.casa_ok AND flags.immobiliare_ok AND flags.idealista_ok AND flags.subito_ok
     AND flags.cap_ok) AS capped_semantic_equivalence_ok,
  flags.cap_ok AS capped_cost_cap_ok,
  flags.casa_queue_processed_ok AS casa_queue_processed_ok,
  COALESCE(downwin.ok_actions, 0) AS downstream_actions_ok,
  downwin.started_at AS downstream_avvio,
  downwin.finished_at AS downstream_ultimo,
  COALESCE((SELECT na_ok FROM classify_na), false) AS private_classify_na_ok
FROM mism, promo, tot, perim
LEFT JOIN pipe0510 ON true
LEFT JOIN pipe0545 ON true
LEFT JOIN pipe ON true
LEFT JOIN portali ON true
LEFT JOIN flags ON true
LEFT JOIN downwin ON true
LEFT JOIN imports ON true
LEFT JOIN classif ON true
LEFT JOIN reco ON true
LEFT JOIN imgstep ON true
LEFT JOIN imgattempt ON true
LEFT JOIN fingerprints ON true
LEFT JOIN snapshot ON true
LEFT JOIN ack ON true;