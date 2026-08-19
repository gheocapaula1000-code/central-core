import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPPED_PORTAL_SPECS,
  evaluatePreflight,
  evaluateProviderCap,
  isTerminalRunStatus,
  MAX_ITEMS_PER_PORTAL,
  MAX_SEARCH_URLS,
  providerUsageUsd,
  RUN_COST_CAP_USD,
  totalEstimatedCostUsd,
} from "../../supabase/functions/civiko-padova-apify-launch-batch-capped/costCap";

const CAPPED_INDEX = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-padova-apify-launch-batch-capped/index.ts"),
  "utf8",
);
const LEGACY_BATCH = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-padova-apify-launch-batch/index.ts"),
  "utf8",
);
const ORCH = readFileSync(
  resolve(process.cwd(), "supabase/functions/civiko-orchestrator-dispatch/index.ts"),
  "utf8",
);

describe("pipeline_0510_capped — cap di costo", () => {
  it("impone un hard cap totale di 2.00 USD", () => {
    expect(RUN_COST_CAP_USD).toBe(2.0);
  });

  it("limita a 25 item per portale e a una sola search URL", () => {
    expect(MAX_ITEMS_PER_PORTAL).toBe(25);
    expect(MAX_SEARCH_URLS).toBe(1);
    for (const spec of CAPPED_PORTAL_SPECS) {
      if (spec.portal === "private_leads") continue;
      expect(spec.body.max_items).toBe(25);
      const urls = spec.body.search_urls;
      if (Array.isArray(urls)) expect(urls.length).toBe(1);
    }
  });

  it("copre i quattro portali richiesti dal gate", () => {
    expect(CAPPED_PORTAL_SPECS.map((s) => s.portal)).toEqual([
      "immobiliare",
      "idealista",
      "subito",
      "private_leads",
    ]);
  });

  it("la stima totale del piano capped resta sotto il cap", () => {
    const preflight = evaluatePreflight();
    expect(preflight.allowed).toBe(true);
    expect(preflight.estimated_cost_usd).toBe(totalEstimatedCostUsd());
    expect(preflight.estimated_cost_usd).toBeLessThanOrEqual(RUN_COST_CAP_USD);
    expect(preflight.per_portal_estimates).toHaveLength(4);
  });

  it("rifiuta il lancio quando la stima supera il cap", () => {
    const decision = evaluatePreflight(
      [{ ...CAPPED_PORTAL_SPECS[0], estimated_cost_usd: 5 }],
      RUN_COST_CAP_USD,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cost_cap_would_exceed");
  });
});

describe("pipeline_0510_capped — verifica provider-side", () => {
  it("legge la spesa reale dal run object", () => {
    expect(providerUsageUsd({ usageTotalUsd: 0.42 })).toBe(0.42);
    expect(providerUsageUsd({ chargedTotalUsd: 0 })).toBe(0);
  });

  it("considera non verificabile un run senza cifra di spesa", () => {
    expect(providerUsageUsd({ status: "RUNNING" })).toBeNull();
    expect(providerUsageUsd(null)).toBeNull();
    expect(providerUsageUsd("x")).toBeNull();
  });

  it("approva solo run entro il cap e tutti verificabili", () => {
    const verdict = evaluateProviderCap([
      { run_id: "a", usage_usd: 0.3 },
      { run_id: "b", usage_usd: 0.5 },
    ]);
    expect(verdict.verified).toBe(true);
    expect(verdict.within_cap).toBe(true);
    expect(verdict.observed_total_usd).toBe(0.8);
    expect(verdict.reason).toBeNull();
  });

  it("fallisce chiuso quando la spesa non è leggibile", () => {
    const verdict = evaluateProviderCap([
      { run_id: "a", usage_usd: 0.1 },
      { run_id: "b", usage_usd: null },
    ]);
    expect(verdict.verified).toBe(false);
    expect(verdict.within_cap).toBe(false);
    expect(verdict.reason).toBe("provider_cap_unverifiable");
    expect(verdict.unverifiable_run_ids).toEqual(["b"]);
  });

  it("fallisce chiuso quando la spesa cumulata supera il cap", () => {
    const verdict = evaluateProviderCap([
      { run_id: "a", usage_usd: 1.5 },
      { run_id: "b", usage_usd: 0.9 },
    ]);
    expect(verdict.verified).toBe(true);
    expect(verdict.within_cap).toBe(false);
    expect(verdict.reason).toBe("cost_cap_exceeded_aborted");
  });

  it("riconosce gli stati terminali per non abortire run già chiusi", () => {
    expect(isTerminalRunStatus("SUCCEEDED")).toBe(true);
    expect(isTerminalRunStatus("RUNNING")).toBe(false);
  });
});

describe("civiko-padova-apify-launch-batch-capped — edge function", () => {
  it("è fail-closed su secret, metodo e configurazione", () => {
    expect(CAPPED_INDEX).toContain('error: "method_not_allowed"');
    expect(CAPPED_INDEX).toContain("isJobSecretAuthorized");
    expect(CAPPED_INDEX).toContain("jobAuthFailure");
    expect(CAPPED_INDEX).toContain('error: "config_missing"');
  });

  it("non parte se il cap non è imponibile lato provider", () => {
    expect(CAPPED_INDEX).toContain('error: "provider_cap_unenforceable"');
  });

  it("non legge mai override dal body", () => {
    expect(CAPPED_INDEX).toContain("Body is intentionally never read");
    expect(CAPPED_INDEX).not.toContain("await req.json()");
  });

  it("aborta i run quando il cap non è verificato o è superato", () => {
    expect(CAPPED_INDEX).toContain("actor-runs/${encodeURIComponent(runId)}/abort");
    expect(CAPPED_INDEX).toContain("if (!verdict.verified || !verdict.within_cap)");
    expect(CAPPED_INDEX).toContain("aborted_run_ids: aborted");
  });

  it("echeggia cap, stime, cap applicati e identificatori", () => {
    expect(CAPPED_INDEX).toContain("cost_cap_usd: RUN_COST_CAP_USD");
    expect(CAPPED_INDEX).toContain("per_portal_estimates: preflight.per_portal_estimates");
    expect(CAPPED_INDEX).toContain("caps_applied: capsApplied");
    expect(CAPPED_INDEX).toContain("provider_runs_observed");
    expect(CAPPED_INDEX).toContain("cost_cap_respected: true");
  });

  it("richiede identificatori run/dataset per ogni portale", () => {
    expect(CAPPED_INDEX).toContain("_identifiers_missing");
    expect(CAPPED_INDEX).toContain("required_portals_complete: ok");
  });

  it("non modifica il batch esistente di pipeline_0510", () => {
    expect(LEGACY_BATCH).toContain('["immobiliare", "cron-apify-immobiliare-nightly", {}]');
    expect(LEGACY_BATCH).not.toContain("cost_cap_usd");
  });
});

describe("orchestratore — azione additiva e gate strada B", () => {
  it("registra le azioni capped in allowlist", () => {
    expect(ORCH).toContain('fn: "civiko-padova-apify-launch-batch-capped"');
    expect(ORCH).toContain('body: { mode: "full", portals: ["casa.it"], max_pages: 2 }');
  });

  it("definisce pipeline_0510_capped senza toccare pipeline_0510", () => {
    expect(ORCH).toContain('stages: [["apify_batch", "portal_casa"]]');
    expect(ORCH).toContain('stages: [["apify_batch_capped", "portal_casa_capped"]]');
  });

  it("applica al capped gli stessi controlli semantici del batch standard", () => {
    expect(ORCH).toContain('action === "apify_batch" || action === "apify_batch_capped"');
    expect(ORCH).toContain('action === "portal_casa" || action === "portal_casa_capped"');
    expect(ORCH).toContain('return "apify_batch_incomplete"');
  });

  it("rifiuta un capped senza prova del cap", () => {
    expect(ORCH).toContain('return "capped_cost_cap_unverified"');
    expect(ORCH).toContain("src.cost_cap_respected !== true");
    expect(ORCH).toContain("src.provider_cap_verified !== true");
    expect(ORCH).toContain("capUsd > 2");
  });

  it("il gate accetta esplicitamente entrambe le pipeline di raccolta", () => {
    expect(ORCH).toContain(
      'const COLLECTION_PIPELINES: PipelineAction[] = ["pipeline_0510", "pipeline_0510_capped"]',
    );
    expect(ORCH).toContain("latestRunActionOk(collectionPipeline, collectionCasaAction)");
    expect(ORCH).toContain("latestRunActionOk(collectionPipeline, collectionApifyAction)");
    expect(ORCH).toContain("collection_pipeline: collectionPipeline");
  });

  it("non allenta i requisiti di audit, four_portal e freschezza", () => {
    expect(ORCH).toContain("fourPortalCurrentRunEvidence");
    expect(ORCH).toContain('key: "four_portal_data_fresh"');
    expect(ORCH).toContain('key: "current_pipeline_audits_succeeded"');
    expect(ORCH).toContain("pipelineSequenceOk");
    expect(ORCH).toContain('missingPrerequisites.push("pipeline_0510_run_absent")');
  });

  it("non crea né attiva cron", () => {
    expect(ORCH).not.toContain("cron.schedule");
  });
});
