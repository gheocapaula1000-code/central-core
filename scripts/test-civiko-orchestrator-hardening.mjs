import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const dispatcher = read("supabase/functions/civiko-orchestrator-dispatch/index.ts");
const config = read("supabase/config.toml");
const auditMigration = read(
  "supabase/migrations/20260806163000_civiko_orchestrator_action_audit.sql",
);
const territoryMigration = read(
  "supabase/migrations/20260806163500_civiko_padova_territory_guard.sql",
);
const compatibilityMigration = read(
  "supabase/migrations/20260806171000_civiko_orchestrator_contract_v2_repair.sql",
);
const ackSenderMigration = read(
  "supabase/migrations/20260806171500_civiko_pwa_sync_ack_sender_order.sql",
);
const releaseCandidateMigration = read(
  "supabase/migrations/20260806193000_civiko_release_candidate_v3.sql",
);
const runtimeContractMigration = read(
  "supabase/migrations/20260806223000_civiko_rc_runtime_contract.sql",
);
const pwaSyncAck = read("supabase/functions/civiko-pwa-sync-ack/index.ts");
const pwaSyncValidation = read("supabase/functions/civiko-pwa-sync-ack/validation.ts");
const pwaSyncBinding = read("supabase/functions/civiko-pwa-sync-ack/binding.ts");
const sharedHttp = read("supabase/functions/_shared/http.ts");
const manifest = JSON.parse(read("supabase/civiko-orchestrator-hardening-manifest.json"));
assert.equal(manifest.scope.municipality, "Padova");
assert.equal(manifest.scope.commercial_zones, 8);
assert.equal(manifest.scope.other_apps_modified, false);
assert.equal(manifest.deployment.performed, false);
assert.equal(manifest.release_gate.pwa_ack_pipeline_run_bound_server_side, true);
assert.equal(manifest.release_gate.pwa_ack_client_pipeline_run_id_allowed, false);

const paidEntrypoints = [
  "cron-apify-immobiliare-nightly",
  "cron-apify-idealista-nightly",
  "cron-apify-subito-nightly",
  "cron-apify-casa-nightly",
  "cron-offmarket-padova-nightly",
  "cron-radar-padova-nightly",
  "civiko-private-leads-nightly",
  "civiko-padova-apify-launch-batch",
  "padova-apify-multi-launch",
  "padova-apify-immobiliare-collect",
  "padova-apify-idealista-collect",
  "padova-apify-subito-collect",
  "padova-apify-casa-collect",
  "padova-apify-collect-pending",
  "enqueue-padova-portal-scrapes",
  "civiko-contendibili-evidence-refresh",
];

for (const name of paidEntrypoints) {
  const src = read(`supabase/functions/${name}/index.ts`);
  const handler = src.slice(src.indexOf("Deno.serve"));
  const guardInline = handler.indexOf('req.headers.get("x-job-secret")');
  const guardShared = handler.indexOf("isJobSecretAuthorized");
  const guard = guardInline >= 0 ? guardInline : guardShared;
  const provider = handler.search(/fetch\(|startApifyRun\(/);
  assert.ok(guard >= 0, `${name}: x-job-secret guard missing`);
  assert.ok(provider < 0 || guard < provider, `${name}: provider reachable before auth guard`);
}

for (const name of [
  "cron-apify-immobiliare-nightly",
  "cron-apify-idealista-nightly",
  "cron-apify-subito-nightly",
  "cron-apify-casa-nightly",
]) {
  const src = read(`supabase/functions/${name}/index.ts`);
  const hasInlineSkip = /typeof (?:obj|parsed)\?\.skipped === "string"/.test(src) && /!skipped/.test(src);
  const hasSharedClassifier = src.includes("classifyNightlyCollectResult") && src.includes("skipped:");
  assert.ok(
    hasInlineSkip || hasSharedClassifier,
    `${name}: skipped semantic check missing`,
  );
}

for (const name of [
  ...paidEntrypoints,
  "civiko-private-leads-classify",
  "civiko-private-leads-price-snapshot",
  "civiko-contendibili-image-certify",
  "civiko-pwa-sync-ack",
]) {
  assert.match(config, new RegExp(`\\[functions\\.${name.replaceAll("-", "\\-")}\\]\\nverify_jwt = false`));
}

for (const portal of ["immobiliare", "idealista", "subito", "casa"]) {
  assert.ok(dispatcher.includes(`{ key: "${portal}"`), `gate missing ${portal}`);
}
assert.match(dispatcher, /`collect_\$\{portal\.key\}_current`/);
assert.match(dispatcher, /`listings_\$\{portal\.key\}_current`/);
assert.match(dispatcher, /`collect_\$\{portal\.key\}_created_current`/);

assert.match(dispatcher, /GATE_WINDOW_HOURS = 4/);
assert.match(dispatcher, /signals_classified_current/);
assert.match(dispatcher, /fingerprints_current/);
assert.match(dispatcher, /commercial_zone_slug=in\.\(\$\{scope\}\)/);
assert.match(dispatcher, /PIPELINE_BUDGET_MS = 165_000/);
assert.match(dispatcher, /require_candidates: true/);
assert.match(dispatcher, /require_terminal: true/);
assert.match(dispatcher, /required_portals: \["immobiliare", "idealista", "subito"\]/);
assert.match(dispatcher, /IMAGE_BATCH_MAX_INVOCATIONS = 6/);
assert.match(dispatcher, /steps\.includes\("image_certify"\) \? IMAGE_BATCH_MAX_INVOCATIONS - 1 : 0/);
assert.match(dispatcher, /IMAGE_BATCH_DOWNSTREAM_RESERVE_MS = 85_000/);
assert.match(dispatcher, /attemptNo <= IMAGE_BATCH_MAX_INVOCATIONS/);
assert.match(dispatcher, /action === "image_certify"/);
assert.match(dispatcher, /pipeline_run_id: context\.pipelineRunId/);
assert.match(dispatcher, /return json\(responseStatus/);
assert.match(dispatcher, /typeof src\.skipped === "string" && src\.skipped\.trim\(\) !== ""/);
assert.match(dispatcher, /unexpected_zero_enqueued/);
assert.match(dispatcher, /unexpected_zero_provider_runs/);
assert.match(dispatcher, /collect_pending_no_current_evidence/);
assert.match(dispatcher, /semanticFailure\(payload, action\)/);
assert.match(dispatcher, /for \(const nested of Object\.values\(src\)\)/);
assert.match(dispatcher, /downstream_payload_too_deep/);
assert.match(dispatcher, /civiko_orchestrator_action_runs/);
assert.match(dispatcher, /resolution=merge-duplicates,return=minimal/);
const pipelineStartAudit = dispatcher.indexOf("const startAuditOk = await persistPipelineAudit(");
const pipelineStageLoop = dispatcher.indexOf("for (const stage of pipeline.stages)", pipelineStartAudit);
assert.ok(pipelineStartAudit >= 0, "pipeline fail-closed start audit missing");
assert.ok(pipelineStageLoop > pipelineStartAudit, "provider stages reachable before start audit");
assert.match(dispatcher, /error: "audit_start_failed"/);
const actionStartAudit = dispatcher.indexOf("const startAuditOk = await persistActionAudit(");
const downstreamFetch = dispatcher.indexOf("const res = await fetch(url", actionStartAudit);
assert.ok(actionStartAudit >= 0, "action fail-closed start audit missing");
assert.ok(downstreamFetch > actionStartAudit, "downstream reachable before action start audit");
assert.match(dispatcher, /auditStep[\s\S]*?\}, true\);/);
assert.match(dispatcher, /candidate\.action === "__pipeline__"/);
assert.match(dispatcher, /latestRunActionOk\("pipeline_0510", "portal_casa"\)/);
assert.match(dispatcher, /latestRunActionOk\("pipeline_0545", "collect_pending"\)/);
assert.match(dispatcher, /latestRunActionOk\("pipeline_0545", "contendibili_recompute"\)/);
assert.match(dispatcher, /latestRunActionOk\("pipeline_0710", "signals_classify"\)/);
assert.match(dispatcher, /currentImageFingerprintWritten &&/);
assert.match(dispatcher, /latestPipelineOk\("pipeline_0510"\)/);
assert.match(dispatcher, /latestPipelineOk\("pipeline_0545"\)/);
assert.match(dispatcher, /latestPipelineOk\("pipeline_0710"\)/);
assert.match(dispatcher, /civiko_pwa_sync_acks\?select=/);
assert.match(dispatcher, /candidate\.pipeline_run_id === pipeline0710RunId/);
assert.match(dispatcher, /pwaStartedMs > pipelineFinishedMs/);
assert.match(dispatcher, /pwaFinishedMs > pwaStartedMs/);
assert.match(dispatcher, /pipeline0510FinishedMs < pipeline0545StartedMs/);
assert.match(dispatcher, /pipeline0545FinishedMs < pipeline0710StartedMs/);
assert.match(dispatcher, /pwaFinishedMs < gateStartedAtMs/);
assert.match(dispatcher, /passed: pipelineSequenceOk/);
assert.match(dispatcher, /providerFamiliesPresent/);
assert.match(dispatcher, /launchedProviderIds\.every/);
assert.match(dispatcher, /collectByRunId\.get\(runId\)/);
assert.match(dispatcher, /providerByRunId\.get\(runId\)/);
assert.match(dispatcher, /itemCount > 0 \|\| collected\?\.zero_novelty === true/);
assert.match(dispatcher, /collectPendingResult\?\.zero_novelty === true/);
assert.match(dispatcher, /casaQueueIds\.every/);
assert.match(dispatcher, /row\?\.processing_status === "succeeded"/);
assert.match(dispatcher, /key: "four_portal_data_fresh"/);
assert.match(dispatcher, /fourPortalCurrentRunEvidence/);
assert.match(dispatcher, /pwaFinishedMs > pipelineFinishedMs/);
assert.match(dispatcher, /pwaSyncAck\?\.municipality === "Padova"/);
assert.match(dispatcher, /commercial_zone_slugs/);
assert.match(dispatcher, /pwaCount\("contendibili"\) === g\("categories", "contendibili_scope"\)/);
assert.match(dispatcher, /pwaCount\("radar"\) === g\("categories", "radar"\)/);
assert.match(dispatcher, /passed: pwaSyncAckOk/);
assert.match(dispatcher, /mode: initialValidation \? "initial_validation" : "routine"/);
assert.match(dispatcher, /key: "initial_real_imports_all_portals"/);
assert.match(dispatcher, /`collect_\$\{portal\}_created_exact_run`/);
assert.match(dispatcher, /\["immobiliare", "idealista", "subito", "casa"\]\n\s+\.every/);
assert.match(dispatcher, /!initialValidation \|\| g\("derived", "contendibili_exact_recompute"\) > 0/);
assert.match(dispatcher, /contendibili_recomputed_current/);
assert.match(dispatcher, /padova_recompute_last_result/);
assert.match(dispatcher, /professional_private_mismatch/);
assert.match(auditMigration, /CREATE TABLE IF NOT EXISTS public\.civiko_orchestrator_action_runs/);
assert.match(auditMigration, /CREATE TABLE IF NOT EXISTS public\.civiko_pwa_sync_acks/);
assert.match(auditMigration, /run_id uuid NOT NULL UNIQUE/);
assert.match(auditMigration, /municipality text NOT NULL/);
assert.match(auditMigration, /commercial_zone_slugs text\[\] NOT NULL/);
assert.match(auditMigration, /error_code text/);
assert.match(auditMigration, /UNIQUE \(pipeline_run_id, action, attempt_no\)/);
assert.match(auditMigration, /civiko_pwa_sync_acks_pipeline_run_uq UNIQUE \(pipeline_run_id\)/);
assert.match(auditMigration, /GRANT SELECT, INSERT, UPDATE ON public\.civiko_orchestrator_action_runs/);
assert.match(auditMigration, /ENABLE ROW LEVEL SECURITY/);
assert.match(compatibilityMigration, /ADD COLUMN IF NOT EXISTS pipeline_run_id uuid/);
assert.match(compatibilityMigration, /ADD COLUMN IF NOT EXISTS municipality text/);
assert.match(compatibilityMigration, /coalesce\(pipeline_run_id, run_id\)/);
assert.match(compatibilityMigration, /civiko_orchestrator_action_runs_identity_uq/);
assert.match(compatibilityMigration, /civiko_pwa_sync_acks_pipeline_run_uq/);
assert.match(compatibilityMigration, /GRANT SELECT, INSERT, UPDATE ON public\.civiko_orchestrator_action_runs/);
assert.match(compatibilityMigration, /Server-bound latest successful pipeline_0710/);
const ackHandler = pwaSyncAck.slice(pwaSyncAck.indexOf("Deno.serve"));
const ackCanonicalGuard = ackHandler.indexOf("requireCivikoCostSecret(req, debugId)");
const ackBodyRead = ackHandler.indexOf("const raw = await req.text()");
const ackWrite = ackHandler.indexOf("const written = await insertAck(payload)");
assert.match(sharedHttp, /export function requireCivikoCostSecret/);
assert.match(sharedHttp, /req\.headers\.get\("x-internal-secret"\)/);
assert.ok(ackCanonicalGuard >= 0, "PWA ack: canonical auth guard missing");
assert.ok(ackBodyRead > ackCanonicalGuard, "PWA ack: body reachable before auth guard");
assert.ok(ackWrite > ackCanonicalGuard, "PWA ack: DB write reachable before auth guard");
assert.match(pwaSyncValidation, /typeof b\.run_id !== "string"/);
assert.match(pwaSyncValidation, /idempotencyHeader/);
assert.match(pwaSyncValidation, /header !== runId/);
assert.match(pwaSyncAck, /civiko_orchestrator_action_runs/);
assert.match(pwaSyncAck, /pipeline=eq\.\$\{PIPELINE_ACK\}/);
assert.match(pwaSyncAck, /action=eq\.\$\{PIPELINE_MARKER_ACTION\}/);
assert.match(pwaSyncValidation, /CIVIKO_SOURCE_APPS = new Set\(\["civiko-one"\]\)/);
assert.match(pwaSyncAck, /order=started_at\.desc,attempt_no\.desc,created_at\.desc,id\.desc/);
assert.doesNotMatch(pwaSyncAck, /finished_at=lt/);
assert.doesNotMatch(pwaSyncValidation, /CIVIKO_SOURCE_APPS[^\n]*acquisitionradar/);
assert.match(pwaSyncValidation, /export function isIdenticalAck/);
assert.match(pwaSyncBinding, /PIPELINE_RUN_NOT_FOUND/);
assert.match(pwaSyncAck, /run_id=eq\.\$\{runId\}/);
assert.match(pwaSyncAck, /ACK_IMMUTABLE_CONFLICT/);
assert.match(pwaSyncAck, /method: "POST"/);
for (const key of [
  "dashboard", "radar", "mappa", "contendibili", "privati", "ribassi",
  "cambi_agenzia", "offmarket", "quartieri",
]) {
  assert.ok(pwaSyncValidation.includes(`"${key}"`), `PWA ack count missing ${key}`);
}
assert.match(pwaSyncValidation, /b\.municipality !== PADOVA_MUNICIPALITY/);
assert.match(pwaSyncValidation, /PADOVA_ZONE_SLUGS/);
assert.match(pwaSyncValidation, /ERROR_CODE_INVALID/);
assert.match(ackSenderMigration, /CHECK \(source_app = 'civiko-one'\)/);
assert.doesNotMatch(ackSenderMigration, /acquisitionradar[^\n]*\)/);
assert.match(dispatcher, /order=started_at\.desc,created_at\.desc/);
assert.match(dispatcher, /pwaSyncAck\?\.source_app === "civiko-one"/);
assert.match(territoryMigration, /civiko_guard_padova_listing_municipality/);
assert.match(territoryMigration, /updated_at DESC NULLS LAST/);
assert.match(territoryMigration, /latest_city = 'padova'/);
assert.match(territoryMigration, /IF NOT coalesce\(v_has_source, false\) OR v_latest_city IS DISTINCT FROM 'padova'/);
assert.match(territoryMigration, /FROM public\.padova_subito_staging s/);
assert.match(releaseCandidateMigration, /civiko_only_comune_padova/);
assert.match(releaseCandidateMigration, /civiko_padova_zone_unresolved/);
assert.match(releaseCandidateMigration, /civiko_padova_release_sequence_v/);
assert.match(releaseCandidateMigration, /ack\.finished_at < gate\.started_at/);
assert.match(releaseCandidateMigration, /civiko_orchestrator_action_runs_attempt_uniq_v3/);
assert.match(runtimeContractMigration, /civiko_padova_release_sequence_v/);
assert.match(runtimeContractMigration, /p0510\.started_at < p0510\.finished_at/);
assert.match(runtimeContractMigration, /p0710\.finished_at < ack\.started_at/);
assert.match(runtimeContractMigration, /ack\.finished_at < gate\.started_at/);
assert.match(runtimeContractMigration, /CHECK \(source_app = 'civiko-one'\)/);
for (const view of [
  "padova_totali_v", "padova_listings_totali_v", "padova_listings_zone_v",
  "padova_quartieri_stats_v", "padova_contendibili_by_zone_v",
  "padova_multi_portale_by_zone_v",
]) {
  assert.ok(territoryMigration.includes(`VIEW public.${view}`), `territory view missing ${view}`);
}

const privateClassify = read("supabase/functions/civiko-private-leads-classify/index.ts");
assert.match(privateClassify, /const basePadova = base\.filter\(\(b\) => b\.isPadova\)/);
assert.ok(!privateClassify.includes("canPromoteUnknown"));
const privateSnapshot = read("supabase/functions/civiko-private-leads-price-snapshot/index.ts");
assert.match(privateSnapshot, /\.eq\("comune", "Padova"\)/);
assert.match(privateSnapshot, /\.in\("commercial_zone_slug", CIVIKO_SCOPE_SLUGS\)/);
const paidBatch = read("supabase/functions/civiko-padova-apify-launch-batch/index.ts");
const privateNightly = read("supabase/functions/civiko-private-leads-nightly/index.ts");
assert.match(paidBatch, /\["private_leads", "civiko-private-leads-nightly", \{ trigger: "orchestrator" \}\]/);
assert.match(privateNightly, /requestBody\.trigger === "orchestrator"/);
assert.match(privateNightly, /if \(!gate\.run && !orchestratorTrigger\)/);
assert.match(privateNightly, /const budget = await getPrivateLeadsBudget\(\)/);
assert.match(privateNightly, /launchedIdentifiers\.length === launchedCount/);
assert.match(privateNightly, /launch_identifiers_missing/);
assert.match(paidBatch, /uniqueIdentifierBundles/);
assert.match(paidBatch, /defaultDatasetId/);

const p0545 = dispatcher.slice(
  dispatcher.indexOf("pipeline_0545:"),
  dispatcher.indexOf("pipeline_0710:"),
);
for (const [before, after] of [
  ["contendibili_backfill", "contendibili_evidence"],
  ["contendibili_evidence", "image_certify"],
  ["image_certify", "image_pairs"],
  ["image_pairs", "contendibili_recompute"],
]) {
  assert.ok(p0545.indexOf(before) < p0545.indexOf(after), `pipeline order ${before} -> ${after}`);
}

const imageCertify = read("supabase/functions/civiko-contendibili-image-certify/index.ts");
assert.match(imageCertify, /TOTAL_LISTINGS_PER_INVOCATION = 4/);
assert.match(imageCertify, /last_pipeline_run_id: pipelineRunId/);
assert.match(imageCertify, /last_pipeline_run_id", pipelineRunId/);
assert.match(imageCertify, /pairs_snapshot_complete: pairsOnly/);
assert.match(imageCertify, /queue_complete: pairsOnly \? true : \(remainingExact && remainingEligible === 0\)/);
assert.match(imageCertify, /civiko_replace_photo_pair_evidence/);

const offmarket = read("supabase/functions/cron-offmarket-padova-nightly/index.ts");
assert.match(offmarket, /const COMUNI_PD = \["Padova"\]/);
for (const forbidden of ["Rubano", "Albignasego", "Cadoneghe", "Vigonza", "Abano Terme"]) {
  assert.ok(!offmarket.includes(`"${forbidden}"`), `offmarket scope leaked to ${forbidden}`);
}

for (const name of [
  "padova-apify-immobiliare-collect",
  "padova-apify-idealista-collect",
  "padova-apify-subito-collect",
  "padova-apify-casa-collect",
  "padova-apify-collect-pending",
]) {
  const src = read(`supabase/functions/${name}/index.ts`);
  assert.match(src, /ok: false/);
  assert.match(src, /status: (?:ok \? 200 :|semanticOk \? 200 :|429|502)/);
}

const collectPending = read("supabase/functions/padova-apify-collect-pending/index.ts");
assert.match(collectPending, /const candidatesOk = !requireCandidates \|\| candidates\.length > 0/);
assert.match(collectPending, /const terminalOk = !requireTerminal/);
assert.match(collectPending, /const requiredPortalsOk = requiredPortals\.every/);
assert.match(collectPending, /"no_current_provider_candidates"/);
assert.match(collectPending, /"provider_runs_not_terminal"/);
assert.match(collectPending, /"required_portals_incomplete"/);
assert.match(collectPending, /isExplicitPadovaMunicipality\(city\)/);
assert.match(collectPending, /classifyProviderMunicipality/);
assert.match(collectPending, /rejected_out_of_scope/);
assert.match(collectPending, /out_of_scope_written: 0/);

console.log("civiko_orchestrator_hardening_tests=passed");
