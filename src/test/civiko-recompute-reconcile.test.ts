import { describe, expect, it } from "vitest";
import {
  evaluateRecomputeReconciliation,
  isCoherentRecomputeResult,
  isReconcilableFailure,
} from "../../supabase/functions/civiko-orchestrator-dispatch/recomputeReconcile";

const STARTED = "2026-08-08T09:00:00.000Z";
const FRESH_OK = {
  ok: true,
  match_version: "v4-unit-certified",
  contendibili_after: 61,
  contendibili_before: 54,
};

describe("contendibili_recompute reconciliation (fail-closed)", () => {
  it("reconciles a fresh successful result persisted after the action start", () => {
    const verdict = evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [{ created_at: "2026-08-08T09:01:35.000Z", result: FRESH_OK }],
      contendibiliUpdatedCount: null,
    });
    expect(verdict).toMatchObject({
      reconciled: true,
      evidence: "reconciled_after_timeout",
      evidence_source: "padova_recompute_last_result",
    });
  });

  it("rejects a stale result written before the action start", () => {
    const verdict = evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [{ created_at: "2026-08-06T01:03:01.000Z", result: FRESH_OK }],
      contendibiliUpdatedCount: 0,
      contendibiliMaxUpdatedAt: "2026-08-06T01:03:01.000Z",
    });
    expect(verdict).toEqual({ reconciled: false, reason: "reconcile_evidence_stale" });
  });

  it("rejects missing evidence", () => {
    expect(evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [],
      contendibiliUpdatedCount: 0,
    })).toEqual({ reconciled: false, reason: "reconcile_evidence_absent" });
  });

  it("rejects unverifiable evidence (query failure)", () => {
    expect(evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: null,
      contendibiliUpdatedCount: 12,
      contendibiliMaxUpdatedAt: "2026-08-08T09:01:00.000Z",
    })).toEqual({ reconciled: false, reason: "reconcile_evidence_unavailable" });
    expect(evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [],
      contendibiliUpdatedCount: null,
    })).toEqual({ reconciled: false, reason: "reconcile_evidence_unavailable" });
  });

  it("rejects a fresh but failed or incoherent result", () => {
    expect(evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [{
        created_at: "2026-08-08T09:01:00.000Z",
        result: { ok: false, error: "deadlock" },
      }],
      contendibiliUpdatedCount: 61,
      contendibiliMaxUpdatedAt: "2026-08-08T09:02:00.000Z",
    })).toEqual({ reconciled: false, reason: "reconcile_result_failed" });

    expect(evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [{
        created_at: "2026-08-08T09:01:00.000Z",
        result: { ok: true, match_version: "v3-legacy", contendibili_after: 61 },
      }],
      contendibiliUpdatedCount: 61,
      contendibiliMaxUpdatedAt: "2026-08-08T09:02:00.000Z",
    })).toEqual({ reconciled: false, reason: "reconcile_result_failed" });
  });

  it("falls back to canonical contendibili rows rewritten after the start", () => {
    const verdict = evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [],
      contendibiliUpdatedCount: 61,
      contendibiliMaxUpdatedAt: "2026-08-08T09:12:40.786Z",
    });
    expect(verdict).toMatchObject({
      reconciled: true,
      evidence_source: "padova_contendibili_updated_rows",
    });
  });

  it("does not accept the fallback when rows are older than the action start", () => {
    expect(evaluateRecomputeReconciliation({
      startedAt: STARTED,
      lastResultRows: [],
      contendibiliUpdatedCount: 61,
      contendibiliMaxUpdatedAt: "2026-08-07T22:00:00.000Z",
    })).toEqual({ reconciled: false, reason: "reconcile_evidence_absent" });
  });

  it("only reconciles transport failures, never semantic ones", () => {
    expect(isReconcilableFailure(504, "timeout")).toBe(true);
    expect(isReconcilableFailure(502, "network_error")).toBe(true);
    expect(isReconcilableFailure(200, "recompute_contract_incomplete")).toBe(false);
    expect(isReconcilableFailure(400, "postgrest_bad_request")).toBe(false);
    expect(isReconcilableFailure(502, "downstream_http_500")).toBe(false);
  });

  it("validates recompute payload coherence", () => {
    expect(isCoherentRecomputeResult(FRESH_OK)).toBe(true);
    expect(isCoherentRecomputeResult({
      ...FRESH_OK,
      match_version: "v5-photo-mq-price-zone",
    })).toBe(true);
    expect(isCoherentRecomputeResult({ ...FRESH_OK, contendibili_after: "x" })).toBe(false);
    expect(isCoherentRecomputeResult(null)).toBe(false);
  });
});
