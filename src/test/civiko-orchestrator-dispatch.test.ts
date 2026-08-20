import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const SRC = read("supabase/functions/civiko-orchestrator-dispatch/index.ts");
const CONFIG = read("supabase/config.toml");

const ALLOW = SRC.slice(SRC.indexOf("const ALLOWED"), SRC.indexOf("interface PipelineSpec"));
const PIPELINES = SRC.slice(
  SRC.indexOf("const PIPELINES"),
  SRC.indexOf("function pipelineSteps"),
);
const GATE = SRC.slice(SRC.indexOf("async function releaseGate"), SRC.indexOf("Deno.serve"));

describe("civiko-orchestrator-dispatch — release candidate contract", () => {
  it("is an explicitly registered fail-closed non-JWT gateway", () => {
    expect(CONFIG).toMatch(/\[functions\.civiko-orchestrator-dispatch\]\nverify_jwt = false/);
    expect(SRC).toContain('Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET")');
    expect(SRC).toContain("function timingSafeEqual");
    expect(SRC).toContain('req.method !== "POST"');
    expect(SRC).toContain('"unsupported_media_type"');
    expect(SRC).toContain("MAX_BODY_BYTES");
    expect(SRC).toContain('"action_not_allowed"');
  });

  it("accepts bearer dispatch secret or x-job-secret, never anonymous", () => {
    expect(SRC).toContain('const bearerOk = bearer.length > 0 && timingSafeEqual(bearer, DISPATCH_SECRET)');
    expect(SRC).toContain('req.headers.get("x-job-secret")');
    expect(SRC).toContain("timingSafeEqual(jobHeader, JOB_SECRET)");
    expect(SRC).toContain("JOB_SECRET.length > 0");
    expect(SRC).toContain("if (!bearerOk && !jobOk)");
    expect(SRC).toContain('return json(401, { ok: false, error: "unauthorized" })');
  });

  it("keeps pipeline_0710 in the allowlist", () => {
    expect(PIPELINES).toContain("pipeline_0710:");
  });


  it("does not accept an arbitrary downstream URL or endpoint", () => {
    expect(SRC).not.toMatch(/body\.(url|target_url|path|endpoint|fn)\b/);
    expect(SRC).toContain("/functions/v1/${target.fn}");
    expect(SRC).toContain("/rest/v1/rpc/${target.rpc}");
  });

  it("has exactly three disabled Civiko schedules in Europe/Rome", () => {
    expect(SRC).toContain('const SCHEDULE_TIMEZONE = "Europe/Rome"');
    expect(SRC).toContain("const CRON_ENABLED = false");
    for (const [pipeline, at] of [
      ["pipeline_0510", "05:10"],
      ["pipeline_0545", "05:45"],
      ["pipeline_0710", "07:10"],
    ]) {
      expect(PIPELINES).toContain(`${pipeline}:`);
      expect(PIPELINES).toContain(`at: "${at}"`);
    }
    expect(PIPELINES.match(/pipeline_\d{4}:/g)).toHaveLength(3);
    expect(SRC).not.toMatch(/cron\.schedule|cron\.alter_job|cron\.unschedule/);
  });

  it("launches all paid families through the serial Civiko-only batch", () => {
    expect(ALLOW).toContain('fn: "civiko-padova-apify-launch-batch"');
    expect(PIPELINES).toContain('["apify_batch", "portal_casa"]');
    expect(SRC).toContain('["immobiliare", "idealista", "subito", "private_leads"]');
    expect(SRC).toContain("apify_batch_incomplete");
  });

  it("uses Casa queue only and requires a current queue id", () => {
    expect(ALLOW).toContain('fn: "enqueue-padova-portal-scrapes"');
    expect(ALLOW).toContain('portals: ["casa.it"]');
    expect(SRC).toContain("unexpected_zero_enqueued");
    expect(SRC).not.toContain('fn: "cron-apify-casa-nightly"');
  });

  it("preserves the dependency-ordered 0545 DAG", () => {
    const order = [
      "collect_pending",
      "contendibili_backfill",
      "contendibili_evidence",
      "image_certify",
      "image_pairs",
      "contendibili_recompute",
      "contendibili_extras",
    ];
    for (let i = 1; i < order.length; i++) {
      expect(PIPELINES.indexOf(order[i - 1])).toBeLessThan(PIPELINES.indexOf(order[i]));
    }
    expect(PIPELINES).toContain('["private_classify", "contendibili_backfill"]');
    expect(PIPELINES).toContain('["private_price_snapshot", "contendibili_recompute"]');
  });

  it("bounds every pipeline under the 165-second external budget", () => {
    expect(SRC).toContain("PIPELINE_BUDGET_MS = 165_000");
    expect(SRC).toContain("PIPELINE_RESERVE_MS = 12_000");
    expect(SRC).toContain("pipelineWorstCaseMs(spec) + PIPELINE_RESERVE_MS");
    expect(SRC).toContain("invalid_pipeline_budget");
    expect(ALLOW).toContain("timeoutMs: 85_000");
    expect(ALLOW).toContain("timeoutMs: 80_000");
  });

  it("runs independent actions in parallel but stops after a failed stage", () => {
    const runner = SRC.slice(SRC.indexOf("if (action in PIPELINES)"));
    expect(runner).toContain("for (const stage of pipeline.stages)");
    expect(runner).toContain("Promise.all(stage.map");
    expect(runner).toContain("if (failed)");
    expect(runner).toContain("break;");
    expect(runner).toContain('result.action === "radar_full"');
    expect(runner).toContain('result.reason === "timeout"');
  });

  it("pages image work as max six hard-four micro-batches and reserves downstream", () => {
    expect(SRC).toContain("IMAGE_BATCH_MAX_INVOCATIONS = 6");
    expect(SRC).toContain("IMAGE_BATCH_DOWNSTREAM_RESERVE_MS = 85_000");
    expect(SRC).toContain("attemptNo <= IMAGE_BATCH_MAX_INVOCATIONS");
    expect(SRC).toContain('failedAt = "image_queue_remaining_after_limit"');
    expect(ALLOW).toContain("limit: 4");
    expect(ALLOW).toContain("fingerprints_only: true");
    expect(ALLOW).toContain("pairs_only: true");
  });

  it("fails closed on HTTP-200 payload failures and unexpected zero", () => {
    expect(SRC).toContain("semanticFailure(payload, action)");
    expect(SRC).toContain("downstream_ok_false");
    expect(SRC).toContain("downstream_status_failed");
    expect(SRC).toContain("downstream_errors");
    expect(SRC).toContain("unexpected_zero_provider_runs");
    expect(SRC).toContain("collect_pending_no_current_evidence");
    expect(SRC).toContain("private_classification_no_current_write");
  });

  it("writes an in-progress audit before every provider and finalizes the same identity", () => {
    const runAction = SRC.slice(SRC.indexOf("async function runAction"), SRC.indexOf("async function realCount"));
    expect(runAction.indexOf("persistActionAudit")).toBeLessThan(runAction.indexOf("await fetch(url"));
    expect(SRC).toContain("pipeline_run_id,action,attempt_no");
    expect(SRC).toContain("resolution=merge-duplicates,return=minimal");
    expect(SRC).toContain("audit_start_failed");
  });

  it("release gate selects latest-wins rows and only exact current-run actions", () => {
    expect(GATE).toContain("order=started_at.desc,created_at.desc,id.desc");
    expect(GATE).toContain("candidate.pipeline_run_id === runId");
    expect(GATE).toContain("latestRunActionOk");
    expect(GATE).toContain('candidate.action === "__pipeline__"');
    expect(GATE).toContain("Date.parse(String(row.started_at)) < Date.parse(String(row.finished_at))");
  });

  it("requires correlated current-run evidence for all four portals", () => {
    for (const portal of ["immobiliare", "idealista", "subito", "casa"]) {
      expect(GATE).toContain(`key: "${portal}"`);
    }
    expect(GATE).toContain("collectByRunId.get(runId)");
    expect(GATE).toContain("providerByRunId.get(runId)");
    expect(GATE).toContain("casaQueueIds.every");
    expect(GATE).toContain("fourPortalCurrentRunEvidence");
  });

  it("accepts routine zero novelty only with terminal correlated evidence", () => {
    expect(GATE).toContain("collectPendingResult?.zero_novelty === true");
    expect(GATE).toContain("itemCount > 0 || collected?.zero_novelty === true");
    expect(GATE).toContain("providerFamiliesPresent");
    expect(GATE).toContain("launchedProviderIds.every");
  });

  it("requires image queue completion, atomic pair snapshot and current recompute", () => {
    expect(GATE).toContain("currentImageQueueComplete");
    expect(GATE).toContain("currentImagePairsComplete");
    expect(GATE).toContain("recomputeCurrentAuditOk");
    expect(GATE).toContain("contendibili_recomputed_current");
  });

  it("requires the strict 0510→0545→0710→PWA→gate order", () => {
    expect(GATE).toContain("pipeline0510FinishedMs < pipeline0545StartedMs");
    expect(GATE).toContain("pipeline0545FinishedMs < pipeline0710StartedMs");
    expect(GATE).toContain("pwaStartedMs > pipelineFinishedMs");
    expect(GATE).toContain("pwaFinishedMs > pwaStartedMs");
    expect(GATE).toContain("pwaFinishedMs < gateStartedAtMs");
  });

  it("binds the PWA ACK to Civiko One, the same 0710 run, Padova and exact eight zones", () => {
    expect(GATE).toContain('pwaSyncAck?.source_app === "civiko-one"');
    expect(GATE).toContain("candidate.pipeline_run_id === pipeline0710RunId");
    expect(GATE).toContain('pwaSyncAck?.municipality === "Padova"');
    expect(GATE).toContain("commercial_zone_slugs");
    expect(GATE).toContain("pwaZoneSlugs.length === CIVIKO_SCOPE_SLUGS.length");
    expect(GATE).toContain("[...pwaZoneSlugs].sort().every");
  });

  it("compares the nine ACK counts to real Core categories", () => {
    for (const count of [
      "dashboard", "radar", "mappa", "contendibili", "privati", "ribassi",
      "cambi_agenzia", "offmarket", "quartieri",
    ]) {
      expect(GATE).toContain(`"${count}"`);
    }
    expect(GATE).toContain('pwaCount("contendibili") === g("categories", "contendibili_scope")');
    expect(GATE).toContain('pwaCount("radar") === g("categories", "radar")');
  });

  it("fails the gate on current-window territory leakage", () => {
    expect(GATE).toContain('g("scope", "new_active_non_padova") === 0');
    expect(GATE).toContain('g("scope", "new_padova_null_zone") === 0');
    expect(GATE).toContain('g("scope", "invalid_assigned_zone") === 0');
    expect(GATE).toContain('g("scope", "professional_private_mismatch") === 0');
  });

  it("keeps initial validation stronger than routine release", () => {
    expect(GATE).toContain('mode: initialValidation ? "initial_validation" : "routine"');
    expect(GATE).toContain('key: "initial_real_imports_all_portals"');
    expect(GATE).toContain('key: "initial_real_contendibile"');
    expect(GATE).toContain('key: "initial_fingerprint_evidence"');
  });

  it("never leaks secrets, provider payloads or stack traces", () => {
    const safe = SRC.slice(SRC.indexOf("function safeIdentifiers"), SRC.indexOf("function hasNestedIdentifier"));
    expect(safe).not.toContain("JOB_SECRET");
    expect(safe).not.toContain("SERVICE_KEY");
    expect(SRC).not.toContain(".stack");
    expect(SRC).not.toMatch(/job_secret:\s*JOB_SECRET|service_key:\s*SERVICE_KEY/);
  });
});
