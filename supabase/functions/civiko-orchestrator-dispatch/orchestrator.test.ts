// Test statici della logica pura dell'orchestratore Civiko.
// Nessun provider, nessun DB, nessuna rete.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ackAfterPipeline,
  ACTION_TIMEOUT_MS,
  buildGateRequirements,
  collectProviderFailure,
  compareRuns,
  CONTINUATION_RESERVE_MS,
  downstreamBudgetOk,
  expandedSteps,
  failingActions,
  IMAGE_CERTIFY_HARD_LIMIT,
  IMAGE_CERTIFY_MAX_INVOCATIONS,
  imageBudgetAllows,
  latestRunsByAction,
  MAX_ACTION_TIMEOUT_MS,
  missingActions,
  nestedFailure,
  parseGateMode,
  payloadFailure,
  PIPELINE_BUDGET_MS,
  PIPELINE_MARKER_ACTION,
  PIPELINES,
  pipelineStatus,
  remainingStagesWorstCaseMs,
  SEGMENT_CAPACITY_MS,
  segmentPipeline,
  segmentStartingAt,
  semanticFailure,
  stageWorstCaseMs,
  stepTimeoutMs,
  type ActionRunRow,
  type GateIntegrity,
  type PipelineAction,
  type SimpleAction,
} from "./orchestrator.ts";

const ALL_PIPELINES = Object.keys(PIPELINES) as PipelineAction[];

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

// ── 2) Segmentazione: ogni stage è raggiungibile con riserva dimostrabile ──
Deno.test("segmenti: nessun segmento supera la capacità di una invocazione", () => {
  assert(SEGMENT_CAPACITY_MS < PIPELINE_BUDGET_MS);
  for (const p of ALL_PIPELINES) {
    for (const seg of segmentPipeline(p)) {
      assert(
        seg.worstCaseMs <= SEGMENT_CAPACITY_MS,
        `${p} segmento ${seg.from}-${seg.to} = ${seg.worstCaseMs}ms`,
      );
    }
  }
});

Deno.test("segmenti: coprono TUTTI gli stage, in ordine e senza buchi", () => {
  for (const p of ALL_PIPELINES) {
    const segs = segmentPipeline(p);
    assertEquals(segs[0].from, 0);
    assertEquals(segs[segs.length - 1].to, PIPELINES[p].stages.length - 1);
    for (let i = 1; i < segs.length; i++) assertEquals(segs[i].from, segs[i - 1].to + 1);
    // Ogni continuazione è indirizzabile in modo esatto.
    for (const s of segs) assertEquals(segmentStartingAt(p, s.from)?.to, s.to);
    assertEquals(segmentStartingAt(p, PIPELINES[p].stages.length), null);
  }
});

Deno.test("fake clock worst-case: ogni stage parte entro il budget hard", () => {
  for (const p of ALL_PIPELINES) {
    for (const seg of segmentPipeline(p)) {
      let clock = 0; // ms trascorsi nella invocazione del segmento
      for (let i = seg.from; i <= seg.to; i++) {
        const remaining = PIPELINE_BUDGET_MS - clock;
        assert(remaining > 0, `${p} stage ${i} avviato oltre il budget`);
        const reserve = remainingStagesWorstCaseMs(p, i, seg.to) +
          (seg.to === PIPELINES[p].stages.length - 1 ? 0 : CONTINUATION_RESERVE_MS);
        if (PIPELINES[p].stages[i][0].action === "contendibili_image_certify") {
          // Almeno un batch hard-4 deve essere sempre eseguibile.
          assert(imageBudgetAllows(remaining, reserve), `${p} stage ${i}: zero tentativi immagine`);
          clock += ACTION_TIMEOUT_MS.contendibili_image_certify;
          assert(downstreamBudgetOk(PIPELINE_BUDGET_MS - clock, reserve));
        } else {
          clock += stageWorstCaseMs(PIPELINES[p].stages[i]);
        }
      }
      assert(clock <= SEGMENT_CAPACITY_MS, `${p} segmento ${seg.from}-${seg.to}: ${clock}ms`);
    }
  }
});

Deno.test("worst-case 0545: image certify + recompute restano raggiungibili", () => {
  const stages = PIPELINES.pipeline_0545.stages.map((s) => s.map((x) => x.action));
  const imageStage = stages.findIndex((s) => s.includes("contendibili_image_certify"));
  const recomputeStage = stages.findIndex((s) => s.includes("contendibili_recompute"));
  assert(imageStage >= 0 && recomputeStage > imageStage);
  const seg = segmentPipeline("pipeline_0545").find((s) =>
    imageStage >= s.from && imageStage <= s.to
  )!;
  const reserve = remainingStagesWorstCaseMs("pipeline_0545", imageStage, seg.to);
  assert(imageBudgetAllows(PIPELINE_BUDGET_MS, reserve));
});

// ── 3) Propagazione di stato ───────────────────────────────────────────────
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
  assertEquals(semanticFailure("apify_subito", { processed: 0 }), "apify_started_count_zero");
});

Deno.test("nestedFailure: guasti a qualunque profondità, counters inclusi", () => {
  assertEquals(nestedFailure({ data: { report: { ok: false } } }), "nested_ok_false");
  assertEquals(nestedFailure({ a: { success: false } }), "nested_success_false");
  assertEquals(nestedFailure({ a: { status: "FAILED" } }), "nested_status_failed");
  assertEquals(nestedFailure({ counters: { errors: 2 } }), "nested_errors_count");
  assertEquals(nestedFailure({ metrics: { errors_count: 1 } }), "nested_errors_count");
  assertEquals(nestedFailure({ counters: { errors: 0, imports: 3 } }), null);
});

// ── 4) Contratti di payload reali ──────────────────────────────────────────
Deno.test("apify: servono started_count, run_id E dataset_id", () => {
  assertEquals(payloadFailure("apify_subito", { started_count: 0 }), "apify_started_count_zero");
  assertEquals(
    payloadFailure("apify_subito", { started_count: 1, dataset_id: "d1" }),
    "apify_run_id_missing",
  );
  assertEquals(
    payloadFailure("apify_subito", { started_count: 1, run_id: "r1" }),
    "apify_dataset_id_missing",
  );
  assertEquals(
    payloadFailure("apify_subito", { started_count: 1, run_id: "r1", dataset_id: "d1" }),
    null,
  );
});

const provider = (over: Record<string, unknown> = {}) => ({
  status: "SUCCEEDED",
  items: 10,
  run_id: "r1",
  dataset_id: "d1",
  created: 3,
  updated: 1,
  deduped: 6,
  skipped: 0,
  ...over,
});

const collectBody = (over: Record<string, unknown> = {}) => ({
  scanned: 12,
  completed_count: 3,
  required_portals_complete: true,
  errors_count: 0,
  imports_count: 12,
  results: [provider(), provider(), provider()],
  ...over,
});

Deno.test("collect-pending: contratto completo del run corrente", () => {
  assertEquals(payloadFailure("collect_pending", collectBody()), null);
  assertEquals(
    payloadFailure("collect_pending", collectBody({ scanned: 0 })),
    "collect_scanned_zero",
  );
  assertEquals(
    payloadFailure("collect_pending", collectBody({ completed_count: 2 })),
    "collect_completed_insufficient",
  );
  assertEquals(
    payloadFailure("collect_pending", collectBody({ required_portals_complete: false })),
    "collect_required_portals_incomplete",
  );
  const noErrors = collectBody();
  delete (noErrors as Record<string, unknown>).errors_count;
  assertEquals(payloadFailure("collect_pending", noErrors), "collect_errors_count_missing");
  assertEquals(
    payloadFailure("collect_pending", collectBody({ errors_count: 1 })),
    "collect_errors_present",
  );
});

Deno.test("collect-pending: ogni provider corrente SUCCEEDED con item e id", () => {
  assertEquals(
    collectProviderFailure(collectBody({ results: [provider({ status: "FAILED" })] })),
    "collect_provider_not_succeeded",
  );
  assertEquals(
    collectProviderFailure(collectBody({ results: [provider({ items: 0 })] })),
    "collect_provider_items_zero",
  );
  assertEquals(
    collectProviderFailure(
      collectBody({ results: [provider({ run_id: "", dataset_id: "" })] }),
    ),
    "collect_provider_run_identifier_missing",
  );
  assertEquals(
    collectProviderFailure(collectBody({ results: [provider(), provider()] })),
    "collect_providers_insufficient",
  );
});

Deno.test("collect-pending: zero import solo con zero-novità riconciliata", () => {
  const zero = collectBody({
    imports_count: 0,
    zero_novelty: true,
    results: [
      provider({ created: 0, updated: 0, deduped: 10 }),
      provider({ created: 0, updated: 0, deduped: 4, skipped: 6 }),
      provider({ created: 0, updated: 0, skipped: 10 }),
    ],
  });
  assertEquals(payloadFailure("collect_pending", zero), null);

  // Nessuna dichiarazione: dato storico non riconciliato → fail-closed.
  const undeclared = { ...zero, zero_novelty: false };
  assertEquals(payloadFailure("collect_pending", undeclared), "collect_zero_novelty_unproven");

  // Dichiarata ma non riconciliata su ogni provider.
  const unreconciled = {
    ...zero,
    results: [
      provider({ created: 0, updated: 0, deduped: 0, skipped: 0 }),
      provider({ created: 0, updated: 0, deduped: 5 }),
      provider({ created: 0, updated: 0, skipped: 5 }),
    ],
  };
  assertEquals(payloadFailure("collect_pending", unreconciled), "collect_zero_novelty_unproven");

  // imports_count dichiarato incoerente con i provider.
  assertEquals(
    payloadFailure("collect_pending", collectBody({ imports_count: 99 })),
    "collect_imports_mismatch",
  );
});

Deno.test("casa: enqueued non vuoto con queue_id", () => {
  assertEquals(payloadFailure("portal_casa", { enqueued: [] }), "casa_enqueued_empty");
  assertEquals(payloadFailure("portal_casa", { enqueued: {} }), "casa_enqueued_not_array");
  assertEquals(payloadFailure("portal_casa", { enqueued: [{ queue_id: "q" }] }), null);
});

// ── 5) Ordine pipeline e hard limit 4x6 ────────────────────────────────────
Deno.test("pipeline_0510: casa + 3 apify + classificazione privati", () => {
  assertEquals(expandedSteps("pipeline_0510"), [
    "portal_casa",
    "apify_immobiliare",
    "apify_idealista",
    "apify_subito",
    "private_leads_nightly",
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
});

Deno.test("isolamento: nessuna azione fuori dal perimetro Civiko/Padova", () => {
  const all = ALL_PIPELINES.flatMap((p) => expandedSteps(p));
  const forbidden = /(trovabandi|wyloni|sottra|keydraft|apify_reservoir)/i;
  for (const a of all) assert(!forbidden.test(a), `azione fuori perimetro: ${a}`);
});

// ── 6) Latest-wins su started_at ───────────────────────────────────────────
const run = (
  action: SimpleAction | string,
  startedAt: string,
  ok: boolean,
  extra: Partial<ActionRunRow> = {},
): ActionRunRow => ({
  action,
  started_at: startedAt,
  finished_at: startedAt,
  ok,
  status: ok ? 200 : 502,
  error_code: ok ? null : "error",
  ...extra,
});

Deno.test("latest-wins: un vecchio successo non copre un fallimento recente", () => {
  const rows = [
    run("radar_full", "2026-08-06T01:00:00Z", true),
    run("radar_full", "2026-08-06T05:00:00Z", false),
  ];
  assertEquals(latestRunsByAction(rows).get("none::radar_full")?.ok, false);
  assertEquals(failingActions(rows), ["none::radar_full"]);
});

Deno.test("latest-wins: ordina per started_at, mai per finished_at", () => {
  const older = run("radar_full", "2026-08-06T01:00:00Z", true, {
    finished_at: "2026-08-06T09:00:00Z", // chiusura lenta
  });
  const newer = run("radar_full", "2026-08-06T05:00:00Z", false, {
    finished_at: "2026-08-06T05:01:00Z",
  });
  assertEquals(latestRunsByAction([older, newer]).get("none::radar_full")?.ok, false);
  assert(compareRuns(newer, older) > 0);
});

Deno.test("latest-wins: tie-break stabile su attempt_no, created_at e id", () => {
  const a = run("radar_full", "2026-08-06T05:00:00Z", true, { attempt_no: 1, id: "a" });
  const b = run("radar_full", "2026-08-06T05:00:00Z", false, { attempt_no: 2, id: "b" });
  assert(compareRuns(b, a) > 0);
  const c = run("radar_full", "2026-08-06T05:00:00Z", true, {
    attempt_no: 2,
    id: "c",
    created_at: "2026-08-06T05:00:30Z",
  });
  assert(compareRuns(c, b) > 0);
});

Deno.test("latest-wins: un successo successivo sana un fallimento precedente", () => {
  const rows = [
    run("radar_full", "2026-08-06T01:00:00Z", false),
    run("radar_full", "2026-08-06T05:00:00Z", true),
  ];
  assertEquals(failingActions(rows), []);
});

// ── 7) Ack PWA ordering ────────────────────────────────────────────────────
Deno.test("ack deve essere concluso DOPO l'ultima pipeline_0710 riuscita", () => {
  assert(ackAfterPipeline("2026-08-06T07:30:00Z", "2026-08-06T07:20:00Z"));
  assert(!ackAfterPipeline("2026-08-06T07:10:00Z", "2026-08-06T07:20:00Z"));
  assert(!ackAfterPipeline(null, "2026-08-06T07:20:00Z"));
  assert(!ackAfterPipeline("2026-08-06T07:30:00Z", null));
});

// ── 8) Release gate ────────────────────────────────────────────────────────
const okIntegrity: GateIntegrity = {
  portali_freschi: 4,
  mismatch_professionale: 0,
  listings_freschi: 12,
  classificazione_ultima: "2026-08-06T07:00:00Z",
  recompute_ultimo: "2026-08-06T07:05:00Z",
  contendibili_totali: 5,
  recompute_corrente: true,
  pipeline_0710_ultimo: "2026-08-06T07:20:00Z",
  pipeline_0710_ok: true,
  pipeline_0710_run_id: "run-pipeline_0710",
  pipeline_0545_run_id: "run-pipeline_0545",
  pwa_sync_ack_ultimo_ok: "2026-08-06T07:40:00Z",
  pwa_sync_ack_corrente: true,
  contendibili_fuori_perimetro: 0,
  privati_fuori_perimetro: 0,
};

// Step degli esatti ultimi run: chiave pipeline::azione.
const allActionsOk: ActionRunRow[] = ALL_PIPELINES.flatMap((p) =>
  expandedSteps(p).map((a) =>
    run(a, "2026-08-06T07:00:00Z", true, { pipeline: p, pipeline_run_id: `run-${p}` })
  )
);

const okPipelines = new Map<PipelineAction, ActionRunRow>(
  ALL_PIPELINES.map((p) => [
    p,
    run(PIPELINE_MARKER_ACTION, "2026-08-06T07:00:00Z", true, {
      pipeline: p,
      pipeline_run_id: `run-${p}`,
      finished_at: "2026-08-06T07:20:00Z",
    }),
  ]),
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
  assertEquals(reqs.filter((r) => !r.passed).map((r) => r.key), []);
  assert(!reqs.some((r) => r.key.startsWith("initial_")));
});

Deno.test("routine: fallisce se una azione recente è in errore", () => {
  const runs = [
    ...allActionsOk,
    run("contendibili_recompute", "2026-08-06T07:30:00Z", false, {
      pipeline: "pipeline_0545",
      pipeline_run_id: "run-pipeline_0545",
    }),
  ];
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: runs,
    pipelineRuns: okPipelines,
  });
  assertEquals(reqs.find((r) => r.key === "nessun_fallimento_recente")?.passed, false);
});

Deno.test("routine: fallisce se un portale non è fresco", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn({ "portals.collect_items_subito_fresh": 0 }),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assertEquals(reqs.find((r) => r.key === "portale_subito_fresh")?.passed, false);
});

Deno.test("routine: fallisce se manca la ricevuta PWA dopo la pipeline_0710", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: { ...okIntegrity, pwa_sync_ack_ultimo_ok: "2026-08-06T07:00:00Z" },
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assertEquals(reqs.find((r) => r.key === "pwa_sync_ack_dopo_pipeline_0710")?.passed, false);
});

Deno.test("routine: il recompute non è surrogato dell'ack PWA", () => {
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: { ...okIntegrity, pwa_sync_ack_corrente: false, recompute_corrente: true },
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  });
  assertEquals(reqs.find((r) => r.key === "pwa_sync_ack_dopo_pipeline_0710")?.passed, false);
});

Deno.test("initial_validation: import reali per TUTTI e 4 i portali", () => {
  const failing = buildGateRequirements({
    mode: "initial_validation",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: okPipelines,
  }).filter((r) => !r.passed).map((r) => r.key);
  assertEquals(failing, [
    "initial_nuovi_import_casa",
    "initial_nuovi_import_immobiliare",
    "initial_nuovi_import_idealista",
    "initial_nuovi_import_subito",
    "initial_contendibile_certificato_2_piu",
    "initial_fingerprint_fresco",
  ]);

  const passing = buildGateRequirements({
    mode: "initial_validation",
    metric: metricFn({
      "imported.listings_casa_imported_in_window": 4,
      "imported.listings_immobiliare_imported_in_window": 4,
      "imported.listings_idealista_imported_in_window": 4,
      "imported.listings_subito_imported_in_window": 4,
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

Deno.test("gate: ultimo run di una pipeline fallito blocca il gate", () => {
  const runs = new Map(okPipelines);
  runs.set("pipeline_0710", { ...okPipelines.get("pipeline_0710")!, ok: false, status: 502 });
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: allActionsOk,
    pipelineRuns: runs,
  });
  assertEquals(reqs.find((r) => r.key === "ultime_tre_pipeline_ok")?.passed, false);
});

Deno.test("gate: step mai eseguito blocca il gate", () => {
  const runs = allActionsOk.filter((r) =>
    !(r.action === "contendibili_pairs" && r.pipeline === "pipeline_0545")
  );
  assertEquals(missingActions(runs), ["pipeline_0545::contendibili_pairs"]);
  const reqs = buildGateRequirements({
    mode: "routine",
    metric: metricFn(),
    integrity: okIntegrity,
    actionRuns: runs,
    pipelineRuns: okPipelines,
  });
  assertEquals(reqs.find((r) => r.key === "tutti_gli_step_hanno_lavorato")?.passed, false);
});

Deno.test("parseGateMode: default routine, fail-closed su input arbitrario", () => {
  assertEquals(parseGateMode(undefined), "routine");
  assertEquals(parseGateMode("qualsiasi"), "routine");
  assertEquals(parseGateMode("initial_validation"), "initial_validation");
});
