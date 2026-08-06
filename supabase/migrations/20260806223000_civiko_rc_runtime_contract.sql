-- Civiko One-only runtime contract for the reviewed release candidate.
-- Forward-only, additive, no provider call and no listing mutation.
BEGIN;

-- A failed/in-progress latest attempt must shadow every older success.
CREATE UNIQUE INDEX IF NOT EXISTS civiko_orchestrator_action_runs_identity_rc
  ON public.civiko_orchestrator_action_runs
  (pipeline_run_id, action, attempt_no);

CREATE INDEX IF NOT EXISTS civiko_orchestrator_action_runs_latest_rc
  ON public.civiko_orchestrator_action_runs
  (pipeline_action, started_at DESC, created_at DESC, id DESC);

-- The canonical sender is singular. Other PWA aliases are intentionally not
-- accepted by this Civiko-only table/endpoint contract.
ALTER TABLE public.civiko_pwa_sync_acks
  DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_source_app_rc_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_source_app_rc_ck
  CHECK (source_app = 'civiko-one') NOT VALID;
ALTER TABLE public.civiko_pwa_sync_acks
  VALIDATE CONSTRAINT civiko_pwa_sync_acks_source_app_rc_ck;

CREATE UNIQUE INDEX IF NOT EXISTS civiko_pwa_sync_acks_source_idempotency_rc
  ON public.civiko_pwa_sync_acks (source_app, idempotency_key);

-- Read-only sequence proof. release_gate is a separate invocation and must
-- start strictly after the PWA semantic-sync acknowledgement.
CREATE OR REPLACE VIEW public.civiko_padova_release_sequence_v
WITH (security_invoker = true) AS
WITH p0510 AS (
  SELECT * FROM public.civiko_orchestrator_action_runs
   WHERE pipeline_action = 'pipeline_0510' AND action = '__pipeline__'
   ORDER BY started_at DESC, created_at DESC, id DESC LIMIT 1
), p0545 AS (
  SELECT * FROM public.civiko_orchestrator_action_runs
   WHERE pipeline_action = 'pipeline_0545' AND action = '__pipeline__'
   ORDER BY started_at DESC, created_at DESC, id DESC LIMIT 1
), p0710 AS (
  SELECT * FROM public.civiko_orchestrator_action_runs
   WHERE pipeline_action = 'pipeline_0710' AND action = '__pipeline__'
   ORDER BY started_at DESC, created_at DESC, id DESC LIMIT 1
), ack AS (
  SELECT a.* FROM public.civiko_pwa_sync_acks a
  JOIN p0710 p ON p.pipeline_run_id = a.pipeline_run_id
  ORDER BY a.started_at DESC, a.created_at DESC, a.run_id DESC LIMIT 1
), gate AS (
  SELECT * FROM public.civiko_orchestrator_action_runs
   WHERE pipeline_action = 'release_gate' AND action = '__release_gate__'
   ORDER BY started_at DESC, created_at DESC, id DESC LIMIT 1
)
SELECT
  p0510.pipeline_run_id AS pipeline_0510_run_id,
  p0545.pipeline_run_id AS pipeline_0545_run_id,
  p0710.pipeline_run_id AS pipeline_0710_run_id,
  ack.run_id AS pwa_sync_run_id,
  gate.pipeline_run_id AS release_gate_run_id,
  p0510.started_at AS pipeline_0510_started_at,
  p0510.finished_at AS pipeline_0510_finished_at,
  p0545.started_at AS pipeline_0545_started_at,
  p0545.finished_at AS pipeline_0545_finished_at,
  p0710.started_at AS pipeline_0710_started_at,
  p0710.finished_at AS pipeline_0710_finished_at,
  ack.started_at AS pwa_sync_started_at,
  ack.finished_at AS pwa_sync_finished_at,
  gate.started_at AS release_gate_started_at,
  gate.finished_at AS release_gate_finished_at,
  (
    p0510.ok IS TRUE AND p0510.http_status BETWEEN 200 AND 299
    AND p0545.ok IS TRUE AND p0545.http_status BETWEEN 200 AND 299
    AND p0710.ok IS TRUE AND p0710.http_status BETWEEN 200 AND 299
    AND ack.ok IS TRUE AND ack.source_app = 'civiko-one'
    AND gate.ok IS TRUE AND gate.http_status BETWEEN 200 AND 299
    AND p0510.started_at < p0510.finished_at
    AND p0510.finished_at < p0545.started_at
    AND p0545.started_at < p0545.finished_at
    AND p0545.finished_at < p0710.started_at
    AND p0710.started_at < p0710.finished_at
    AND p0710.finished_at < ack.started_at
    AND ack.started_at < ack.finished_at
    AND ack.finished_at < gate.started_at
    AND gate.started_at < gate.finished_at
    AND ack.municipality = 'Padova'
    AND cardinality(ack.commercial_zone_slugs) = 8
    AND ack.commercial_zone_slugs @> ARRAY[
      'centro-storico', 'nord-arcella', 'est-brenta',
      'est-forcellini-camin', 'sud-est-sant-osvaldo',
      'sud-voltabarozzo-guizza', 'sud-ovest-mandria',
      'ovest-chiesanuova-brentelle'
    ]::text[]
    AND jsonb_typeof(ack.counts) = 'object'
    AND jsonb_object_length(ack.counts) = 9
  ) AS sequence_ok
FROM p0510 CROSS JOIN p0545 CROSS JOIN p0710 CROSS JOIN ack CROSS JOIN gate;

REVOKE ALL ON public.civiko_padova_release_sequence_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.civiko_padova_release_sequence_v TO service_role;

-- Static/live prerequisites fail the migration transaction rather than
-- leaving a half-promoted runtime contract.
DO $qa$
BEGIN
  IF public.civiko_normalize_comune('Padova') IS DISTINCT FROM 'padova'
     OR public.civiko_is_comune_padova('Padova') IS NOT TRUE
     OR public.civiko_is_comune_padova('Vigonza') IS NOT FALSE THEN
    RAISE EXCEPTION 'CIVIKO_RC_MUNICIPALITY_HOTFIX_MISSING';
  END IF;

  IF (SELECT count(*) FROM public.civiko_commercial_zones
       WHERE slug IN (
         'centro-storico', 'nord-arcella', 'est-brenta',
         'est-forcellini-camin', 'sud-est-sant-osvaldo',
         'sud-voltabarozzo-guizza', 'sud-ovest-mandria',
         'ovest-chiesanuova-brentelle'
       )) <> 8 THEN
    RAISE EXCEPTION 'CIVIKO_RC_EXACT8_CONTRACT_MISSING';
  END IF;

  IF to_regprocedure('public.civiko_replace_photo_pair_evidence(jsonb,timestamptz)') IS NULL
     OR to_regprocedure('public.recompute_padova_listings_contendibili()') IS NULL THEN
    RAISE EXCEPTION 'CIVIKO_RC_MATCHER_RUNTIME_MISSING';
  END IF;
END
$qa$;

COMMIT;
