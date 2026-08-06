import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  classifyProviderMunicipality,
  isExplicitPadovaMunicipality,
} from "../../supabase/functions/padova-apify-collect-pending/territory";

const DISPATCH = readFileSync(
  "supabase/functions/civiko-orchestrator-dispatch/index.ts",
  "utf8",
);
const MIGRATION = readFileSync(
  "supabase/migrations/20260806223000_civiko_rc_runtime_contract.sql",
  "utf8",
);
const PRIVATE_LEADS = readFileSync(
  "supabase/functions/civiko-private-leads-nightly/index.ts",
  "utf8",
);

describe("Civiko release candidate v3 — territory and current-run gate", () => {
  it("rejects the explicit Vigonza provider fixture before staging", () => {
    const subitoVigonza = {
      page_url: "https://www.subito.it/appartamenti/fixture-vigonza-1.htm",
      location: { city: "Vigonza", province: "Padova", region: "Veneto" },
    };

    expect(classifyProviderMunicipality(subitoVigonza.location.city)).toBe("out_of_scope");
    expect(isExplicitPadovaMunicipality(subitoVigonza.location.city)).toBe(false);
    expect(classifyProviderMunicipality("")).toBe("missing");
    expect(isExplicitPadovaMunicipality(" Padova ")).toBe(true);
  });

  it("requires every stage and ACK to have a strict, ordered time interval", () => {
    for (const predicate of [
      "p0510.started_at < p0510.finished_at",
      "p0510.finished_at < p0545.started_at",
      "p0545.started_at < p0545.finished_at",
      "p0545.finished_at < p0710.started_at",
      "p0710.started_at < p0710.finished_at",
      "p0710.finished_at < ack.started_at",
      "ack.started_at < ack.finished_at",
      "ack.finished_at < gate.started_at",
      "gate.started_at < gate.finished_at",
    ]) {
      expect(MIGRATION).toContain(predicate);
    }
    expect(DISPATCH).toContain("pwaFinishedMs < gateStartedAtMs");
    expect(DISPATCH).toContain("Math.max(Date.now(), gateStartedAtMs + 1)");
    expect(DISPATCH).toContain("checked_at: new Date(finalCheckedAtMs).toISOString()");
  });

  it("binds gate evidence to exact pipeline run IDs, not historical rows", () => {
    expect(DISPATCH).toContain("candidate.pipeline_run_id === runId");
    expect(DISPATCH).toContain("candidate.pipeline_run_id === pipeline0710RunId");
    expect(DISPATCH).toContain("collectByRunId.get(runId)");
    expect(DISPATCH).toContain("providerByRunId.get(runId)");
    expect(DISPATCH).toContain("collectPendingResult?.zero_novelty === true");
    expect(DISPATCH).toContain("out_of_scope_written");
    expect(DISPATCH).toContain("new_active_non_padova");
    expect(DISPATCH).toContain("new_padova_null_zone");
  });

  it("keeps the DAG bounded and preserves downstream reserve for image batches", () => {
    expect(DISPATCH).toContain("PIPELINE_BUDGET_MS = 165_000");
    expect(DISPATCH).toContain("IMAGE_BATCH_DOWNSTREAM_RESERVE_MS = 85_000");
    expect(DISPATCH).toContain("attemptNo <= IMAGE_BATCH_MAX_INVOCATIONS");
    expect(DISPATCH).toContain("pipelineWorstCaseMs(spec) + PIPELINE_RESERVE_MS");
    expect(DISPATCH).toContain("invalid_pipeline_budget");
  });

  it("publishes only complete safe run/dataset identifiers for private leads", () => {
    expect(PRIVATE_LEADS).toContain("SAFE_ID.test(row.run_id)");
    expect(PRIVATE_LEADS).toContain("SAFE_ID.test(row.dataset_id)");
    expect(PRIVATE_LEADS).toContain("launchedIdentifiers.length === launchedCount");
    expect(PRIVATE_LEADS).toContain('"launch_identifiers_missing"');
    expect(PRIVATE_LEADS).toContain("identifiers: launchedIdentifiers");
  });
});
