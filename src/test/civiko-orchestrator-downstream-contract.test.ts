import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type SemanticFailure = (
  raw: unknown,
  action?: string,
  depth?: number,
) => string | null;

let semanticFailure: SemanticFailure;
let safeIdentifiers: (raw: unknown) => Record<string, unknown>;
let uniqueIdentifierBundles: (
  raw: unknown,
) => Array<{ run_id: string; dataset_id: string }>;

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: () => "" },
    serve: vi.fn(),
  });
  const dispatcher = await import(
    "../../supabase/functions/civiko-orchestrator-dispatch/index.ts"
  );
  semanticFailure = dispatcher.semanticFailure as SemanticFailure;
  safeIdentifiers = dispatcher.safeIdentifiers as typeof safeIdentifiers;
  const launchBatch = await import(
    "../../supabase/functions/civiko-padova-apify-launch-batch/index.ts"
  );
  uniqueIdentifierBundles = launchBatch.uniqueIdentifierBundles;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Civiko orchestrator downstream semantic contract", () => {
  it("rejects null, array and skipped-string HTTP-200 envelopes", () => {
    expect(semanticFailure(null)).toBe("invalid_downstream_payload");
    expect(semanticFailure([])).toBe("invalid_downstream_payload");
    expect(semanticFailure({ ok: true, skipped: "daily_cap" })).toBe("daily_cap");
  });

  it("rejects errors and failures at arbitrary bounded nesting", () => {
    expect(semanticFailure({ ok: true, enrichment: { result: { ok: false } } }))
      .toBe("downstream_ok_false");
    expect(semanticFailure({ ok: true, results: [{ ok: true }, { error: "child_failed" }] }))
      .toBe("child_failed");
    expect(semanticFailure({ ok: true, result: { errors: [{ code: "E1" }] } }))
      .toBe("downstream_errors");
  });

  it("accepts the real successful Apify wrapper envelope", () => {
    expect(semanticFailure({
      ok: true,
      started_count: 1,
      errors_count: 0,
      result: { ok: true, run_id: "run_1", dataset_id: "dataset_1" },
    }, "apify_idealista")).toBeNull();
    expect(semanticFailure({ ok: true, started_count: 0 }, "apify_idealista"))
      .toBe("unexpected_zero_provider_runs");
  });

  it("accepts explicit collect zero-novelty but rejects opaque success", () => {
    expect(semanticFailure({
      ok: true,
      scanned: 3,
      completed_count: 3,
      required_portals_complete: true,
      imports_count: 0,
      zero_novelty: true,
      errors_count: 0,
      out_of_scope_written: 0,
      results: [
        { ok: true, status: "SUCCEEDED", run_id: "immo_1", dataset_id: "ds_immo", items: 2 },
        { ok: true, status: "SUCCEEDED", run_id: "ideal_1", dataset_id: "ds_ideal", items: 2 },
        { ok: true, status: "SUCCEEDED", run_id: "subito_1", dataset_id: "ds_subito", items: 2 },
      ],
    }, "collect_pending")).toBeNull();
    expect(semanticFailure({
      ok: true,
      scanned: 3,
      completed_count: 3,
      required_portals_complete: true,
      imports_count: 1,
      out_of_scope_written: 0,
      results: [
        { status: "SUCCEEDED", run_id: "immo_1", dataset_id: "ds_immo", items: 2 },
        { status: "SUCCEEDED", run_id: "ideal_1", dataset_id: "ds_ideal", items: 2 },
        { status: "SUCCEEDED", run_id: "subito_1", dataset_id: "ds_subito", items: 2 },
      ],
    }, "collect_pending")).toBe("collect_pending_no_current_evidence");
    expect(semanticFailure({ ok: true }, "collect_pending"))
      .toBe("collect_pending_no_current_evidence");
  });

  it("rejects empty photo publish and starved pair evidence", () => {
    expect(semanticFailure({
      ok: true,
      match_version: "v5-photo-mq-price-zone",
      contendibili_after: 0,
    }, "contendibili_recompute")).toBe("empty_photo_publish");
    expect(semanticFailure({
      ok: false,
      error: "identity_starved",
      identity_starved: true,
      match_version: "v5-photo-mq-price-zone",
      contendibili_after: 0,
    }, "contendibili_recompute")).toBe("identity_starved");
    expect(semanticFailure({
      ok: true,
      pairs_snapshot_complete: true,
      identity_starved: true,
    }, "image_pairs")).toBe("identity_starved");
  });

  it("requires current Casa queue identifiers", () => {
    expect(semanticFailure({ ok: true, enqueued: [{ queue_id: "queue_1" }] }, "portal_casa"))
      .toBeNull();
    expect(semanticFailure({ ok: true, enqueued: [] }, "portal_casa"))
      .toBe("unexpected_zero_enqueued");
  });

  it("requires a correlated run/dataset pair and preserves only safe evidence", () => {
    expect(semanticFailure({
      ok: true,
      started_count: 1,
      run: { run_id: "run_1" },
      dataset: { dataset_id: "dataset_1" },
    }, "apify_idealista")).toBe("unexpected_zero_provider_runs");

    expect(safeIdentifiers({
      ok: true,
      enqueued: ["queue_1", { queue_id: "queue_2", url: "https://secret.invalid" }],
      provider: { run_id: "run_1", dataset_id: "dataset_1", token: "do-not-copy" },
    })).toEqual({
      enqueued_count: 2,
      enqueued: [{ queue_id: "queue_1" }, { queue_id: "queue_2" }],
      evidence: [{ run_id: "run_1", dataset_id: "dataset_1" }],
    });
  });

  it("normalizes real Apify identifier aliases and removes duplicate evidence", () => {
    expect(uniqueIdentifierBundles({
      ok: true,
      result: {
        data: { id: "run_A", defaultDatasetId: "dataset_A" },
        repeated: { run_id: "run_A", dataset_id: "dataset_A" },
      },
      launched: [
        { actor_run_id: "run_B", default_dataset_id: "dataset_B" },
        { id: "bad id", defaultDatasetId: "dataset_C" },
      ],
    })).toEqual([
      { run_id: "run_A", dataset_id: "dataset_A" },
      { run_id: "run_B", dataset_id: "dataset_B" },
    ]);
  });
});
