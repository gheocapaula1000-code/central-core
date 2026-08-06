// Test statici della logica pura dell'orchestratore Civiko.
// Nessun provider, nessun DB, nessuna rete.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ackAfterPipeline,
  ACTION_TIMEOUT_MS,
  buildGateRequirements,
  expandedSteps,
  failingActions,
  IMAGE_CERTIFY_HARD_LIMIT,
  IMAGE_CERTIFY_MAX_INVOCATIONS,
  latestRunsByAction,
  MAX_ACTION_TIMEOUT_MS,
  missingActions,
  parseGateMode,
  PIPELINE_BUDGET_MS,
  PIPELINES,
  pipelineStatus,
  semanticFailure,
  stepTimeoutMs,
  type ActionRunRow,
  type GateIntegrity,
  type SimpleAction,
} from "./orchestrator.ts";

// ── 1) Budget e timeout ────────────────────────────────────────────────────
Deno.test("budget totale massimo 165000 ms", () => {
  assertEquals(PIPELINE_BUDGET_MS, 165_000);
});

Deno.test("ogni azione ha timeout esplicito bounded (mai 150s)", () => {
  for (const [action, ms] of Object.entries(ACTION_TIMEOUT_MS)) {
    assert(ms > 0 && ms <= MAX_ACTION_TIMEOUT_MS, `${action} timeout fuori range: ${ms}`);
    assert(ms < 150_000, `${action} usa il vecchio default`);
  }
});

Deno.test("stepTimeoutMs lascia sempre margine al budget residuo", () => {
  const t = stepTimeoutMs("contendibili_recompute", 10_000);
  assert(t <= 7_000, `timeout troppo grande: ${t}`);
  assert(t >= 1_000);
  const full = stepTimeoutMs("contendibili_recompute", PIPELINE_BUDGET_MS);
  assertEquals(full, ACTION_TIMEOUT_MS.contendibili_recompute);
});

// ── 2) Propagazione di stato ───────────────────────────────────────────────
Deno.test("status: qualunque step non ok produce non-2xx", () => {
  assertEquals(pipelineStatus([{ ok: true, status: 200 }], false), 200);
  assertEquals(pipelineStatus([{ ok: true, status: 200 }, { ok: false, status: 401 }], false), 401);
  assertEquals(pipelineStatus([{ ok: false, status: 200 }], false), 502);
  assertEquals(pipelineStatus([{ ok: false, status: 504 }], true), 504);
});

Deno.test("semanticFailure: 200 con ok:false/skipped/error/zero è guasto", () => {
  assertEquals(semanticFailure("radar_full", { ok: false }), "ok_false");
  assertEquals(semanticFailure("radar_full", { skipped: true }), "skipped");
  assertEquals(semanticFailure("radar_full", { error: "boom" }), "error");
  assertEquals(semanticFailure("apify_subito", { processed: 0 }), "zero_provider_result");
  assertEquals(semanticFailure("apify_subito", { processed: 3 }), null);
});

// ── 3) Ordine pipeline e hard limit 4x6 ────────────────────────────────────
Deno.test("pipeline_0510: casa + 3 apify + classificazione privati", () => {
  assertEquals(expandedSteps("pipeline_0510"), [
    "portal_casa",
    "apify_immobiliare",
    "apify_idealista",
    "apify_subito",
    "private_leads_classify",
  ]);
});

Deno.test("pipeline_0545: image certify dopo evidence e prima di pairs/recompute", () => {
  const steps = expandedSteps("pipeline_0545");
  const evidence = steps.indexOf("contendibili_evidence");
  const certify = steps.indexOf("contendibili_image_certify");
  const pairs = steps.indexOf("contendibili_pairs");
  const recompute = steps.indexOf("contendibili_recompute");
  assert(evidence < certify, "evidence deve precedere image certify");
  assert(certify < pairs, "image certify deve precedere pairs");
  assert(pairs < recompute, "pairs deve precedere il recompute");
  assertEquals(steps[0], "collect_pending");
  assertEquals(steps[steps.length - 1], "contendibili_extras");
});

Deno.test("image fingerprint: hard limit 4 e massimo 6 invocazioni", () => {
  assertEquals(IMAGE_CERTIFY_HARD_LIMIT, 4);
  assertEquals(IMAGE_CERTIFY_MAX_INVOCATIONS, 6);
  const occurrences = expandedSteps("pipeline_0545")
    .filter((s) => s === "contendibili_image_certify").length;
  assertEquals(occurrences, 6);
  const declared = PIPELINES.pipeline_0545.steps
    .find((s) => s.action === "contendibili_image_certify");
  assertEquals(declared?.repeat, 6);
});

Deno.test("pipeline_0710: radar/offmarket, scores/warning e classificazione finale", () => {
  assertEquals(expandedSteps("pipeline_0710"), [
    "radar_full",
    "offmarket_discover",
    "offmarket_scores",
    "early_warning",
    "signals_classify",
  ]);
});

Deno.test("isolamento: nessuna azione fuori dal perimetro Civiko/Padova", () => {
  const all = (Object.keys(PIPELINES) as Array<keyof typeof PIPELINES>)
    .flatMap((p) => expandedSteps(p));
  const forbidden = /(trovabandi|wyloni|sottra|keydraft|apify_reservoir)/i;
  for (const a of all) assert(!forbidden.test(a), `azione fuori perimetro: ${a}`);
});

// ── 4) Latest-wins ─────────────────────────────────────────────────────────
const run = (
  action: SimpleAction | string,
  finished: string,
  ok: boolean,
): ActionRunRow => ({
  action,
  started_at: finished,
  finished_at: finished,
  ok,
  status: ok ? 200 : 502,
  error_code: ok ? null : "error",
});

Deno.test("latest-wins: un vecchio successo non copre un fallimento recente", () => {
  const rows = [
    run("radar_full", "2026-08-06T01:00:00Z", true),
    run("radar_full", "2026-08-06T05:00:00Z", false),
  ];
  assertEquals(latestRunsByAction(rows).get("radar_full")?.ok, false);
  assertEquals(failingActions(rows), ["radar_full"]);
});

Deno.test("latest-wins: un successo successivo sana un fallimento precedente", () => {
  const rows = [
    run("radar_full", "2026-08-06T01:00:00Z", false),
    run("radar_full", "2026-08-06T05:00:00Z", true),
  ];
  assertEquals(failingActions(rows), []);
});

// ── 5) Ack PWA ordering ────────────────────────────────────────────────────
Deno.test("ack deve essere concluso DOPO l'ultima pipeline_0710 riuscita", () => {
  assert(ackAfterPipeline("2026-08-06T07:30:00Z", "2026-08-06T07:20:00Z"));
  assert(!ackAfterPipeline("2026-08-06T07:10:00Z", "2026-08-06T07:20:00Z"));
  assert(!ackAfterPipeline(null, "2026-08-06T07:20:00Z"));
  assert(!ackAfterPipeline("2026-08-06T07:30:00Z", null));
});

// ── 6) Release gate: routine vs initial_validation ─────────────────────────
const okIntegrity: GateIntegrity = {
  portali_freschi: 4,
  mismatch_professionale: 0,
  listings_freschi: 12,
  classificazione_ultima: "2026-08-06T07:00:00Z",
  recompute_ultimo: "2026-08-06T07:05:00Z",
  contendibili_totali: 5,
  recompute_corrente: true,
  pipeline_0710_ultimo_ok: "2026-08-06T07:20:00Z",
  pwa_sync_ack_ultimo_ok: "2026-08-06T07:40:00Z",
  pwa_sync_ack_corrente: true,
  contendibili_fuori_perimetro: 0,
  privati_fuori_perimetro: 0,
};

const allActionsOk: ActionRunRow[] = Array.from(
  new Set(
    (Object.keys(PIPELINES) as Array<keyof typeof PIPELINES>).flatMap((p) => expandedSteps(p)),
  ),
).map((a) => run(a, "2026-08-06T07:00:00Z", true));

// Ultimo run OK di ciascuna pipeline (audit vincolante lato gate).
const okPipelines = new Map<PipelineAction, PipelineRunRow>(
  (Object.keys(PIPELINES) as PipelineAction[]).map((p) => [p, {
    pipeline_run_id: `run-${p}`,
    pipeline: p,
    started_at: "2026-08-06T07:00:00Z",
    finished_at: "2026-08-06T07:20:00Z",
    ok: true,
    error_code: null,
  }]),
);

function metricFn(overrides: Record<string, number> = {}) {
  const base: Record<string, number> = {
    "portals.collect_items_casa_fresh": 3,
    "portals.collect_items_immobiliare_fresh": 3,
    "portals.collect_items_idealista_fresh": 3,
    "portals.collect_items_subito_fresh": 3,
    "casa_pipeline.queue_processor_dead": 0,
    "classified_in_window.signals_classified_updated": 7,
    "imported.listings_casa_imported_in_window": 0,
    "imported.listings_imported_in_window": 0,
    "categories.contendibili_total": 0,
    "categories.image_fingerprints_fresh": 0,
  };
  const all = { ...base, ...overrides };
  return (group: string, name: string) => all[`${group}.${name}`] ?? 0;
}

Deno.test("routine: zero novità è valido se tutti gli step hanno lavorato", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  const failed = reqs.filter((r) => !r.passed).map((r) => r.key);
  assertEquals(failed, []);
  // Nessuna categoria imposta >0 nelle notti ordinarie.
  assert(!reqs.some((r) => r.key.startsWith("initial_")));
  assert(!reqs.some((r) => r.key.startsWith("pwa_contendibili")));
});

Deno.test("routine: fallisce se una azione recente è in errore", () => {
  const runs = [...allActionsOk, run("contendibili_recompute", "2026-08-06T07:30:00Z", false)];
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: runs,
    pipelineRuns: okPipelines,
  });
  assert(reqs.find((r) => r.key === "nessun_fallimento_recente")?.passed === false);
});

Deno.test("routine: fallisce se un portale non è fresco", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn({ "portals.collect_items_subito_fresh": 0 }),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assert(reqs.find((r) => r.key === "portale_subito_fresh")?.passed === false);
});

Deno.test("routine: fallisce se manca la ricevuta PWA dopo la pipeline_0710", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: { ...okIntegrity, pwa_sync_ack_ultimo_ok: "2026-08-06T07:00:00Z" },
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assert(reqs.find((r) => r.key === "pwa_sync_ack_dopo_pipeline_0710")?.passed === false);
});

Deno.test("routine: il recompute non è surrogato dell'ack PWA", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: { ...okIntegrity, pwa_sync_ack_corrente: false, recompute_corrente: true },
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assert(reqs.find((r) => r.key === "pwa_sync_ack_dopo_pipeline_0710")?.passed === false);
});

Deno.test("initial_validation: richiede import reali, contendibile 2+ e fingerprint", () => {
  const failing = buildGateRequirements({
    mode: "initial_validation",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  }).filter((r) => !r.passed).map((r) => r.key);
  assertEquals(failing, [
    "initial_nuovi_import_reali",
    "initial_contendibile_certificato_2_piu",
    "initial_fingerprint_fresco",
  ]);

  const passing = buildGateRequirements({
    mode: "initial_validation",
    metric: metricFn({
      "imported.listings_imported_in_window": 9,
      "categories.contendibili_total": 1,
      "categories.image_fingerprints_fresh": 12,
    }),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assertEquals(passing.filter((r) => !r.passed).map((r) => r.key), []);
});

Deno.test("gate: step mai eseguito blocca il gate", () => {
  const runs = allActionsOk.filter((r) => r.action !== "contendibili_pairs");
  assertEquals(missingActions(runs), ["contendibili_pairs"]);
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: runs,
    pipelineRuns: okPipelines,
  });
  assert(reqs.find((r) => r.key === "tutti_gli_step_hanno_lavorato")?.passed === false);
});

Deno.test("parseGateMode: default routine, fail-closed su input arbitrario", () => {
  assertEquals(parseGateMode(undefined), "routine");
  assertEquals(parseGateMode("qualsiasi"), "routine");
  assertEquals(parseGateMode("initial_validation"), "initial_validation");
});
