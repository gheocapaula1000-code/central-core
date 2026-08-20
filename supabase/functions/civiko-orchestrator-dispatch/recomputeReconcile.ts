// Fail-closed reconciliation of the `contendibili_recompute` action.
//
// `recompute_padova_listings_contendibili()` really completes in ~95 s while the
// orchestrator action budget aborts at ~18 s. The RPC keeps running inside the
// database and its result IS persisted. Without reconciliation the audit row
// stays failed forever and the release gate reports
// `contendibili_recompute_audit_absent`, even though the derived data is real.
//
// This module NEVER invents an audit: it only turns a timed-out action into a
// success when the canonical DB evidence proves a fresh, coherent, error-free
// recompute that started AFTER the action started. Anything stale, missing,
// failed or incoherent stays a failure.

/** Canonical evidence read from `padova_recompute_last_result`. */
export interface RecomputeLastResultRow {
  created_at: string;
  result: unknown;
}

export interface ReconcileInput {
  /** ISO timestamp of the action start (the RPC cannot have finished before). */
  startedAt: string;
  /** Rows of padova_recompute_last_result, newest first (may be empty). */
  lastResultRows: RecomputeLastResultRow[] | null;
  /**
   * Canonical fallback already used by the release gate: number of contendibili
   * rows in Civiko scope whose `updated_at` is >= startedAt. `null` when the
   * count could not be verified (=> stays fail-closed).
   */
  contendibiliUpdatedCount: number | null;
  /** Newest `updated_at` observed on padova_contendibili (ISO) or null. */
  contendibiliMaxUpdatedAt?: string | null;
}

export type ReconcileVerdict =
  | {
    reconciled: true;
    evidence: "reconciled_after_timeout";
    evidence_source: "padova_recompute_last_result" | "padova_contendibili_updated_rows";
    observed_at: string;
    result: Record<string, unknown>;
  }
  | { reconciled: false; reason: string };

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
}

/** A recompute payload is coherent with v4/v5 match version and a numeric outcome. */
export function isCoherentRecomputeResult(raw: unknown): raw is Record<string, unknown> {
  if (!isPlainObject(raw)) return false;
  if (raw.ok !== true) return false;
  if (raw.error !== undefined && raw.error !== null) return false;
  const version = raw.match_version;
  if (typeof version !== "string" || !/^v[45]-/.test(version)) return false;
  const after = Number(raw.contendibili_after);
  if (!Number.isFinite(after)) return false;
  // An empty photo publish is not success. v5 publishes only from
  // civiko_listing_photo_pair_evidence; 0 cards means the matcher is starved
  // or wrote nothing public.
  if (raw.identity_starved === true) return false;
  if (after === 0) return false;
  return true;
}

/**
 * Fail-closed decision. Returns `reconciled: true` only for evidence that is
 * strictly newer than the action start and semantically complete.
 */
export function evaluateRecomputeReconciliation(input: ReconcileInput): ReconcileVerdict {
  const startedMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startedMs)) {
    return { reconciled: false, reason: "reconcile_invalid_started_at" };
  }

  if (input.lastResultRows === null) {
    return { reconciled: false, reason: "reconcile_evidence_unavailable" };
  }

  let sawStale = false;
  let sawFailure = false;
  for (const row of input.lastResultRows) {
    const createdMs = Date.parse(String(row?.created_at ?? ""));
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < startedMs) {
      sawStale = true;
      continue;
    }
    if (!isCoherentRecomputeResult(row.result)) {
      sawFailure = true;
      continue;
    }
    return {
      reconciled: true,
      evidence: "reconciled_after_timeout",
      evidence_source: "padova_recompute_last_result",
      observed_at: new Date(createdMs).toISOString(),
      result: row.result,
    };
  }

  // Canonical fallback used by the gate: contendibili rows actually rewritten
  // after the action started. Requires a verified count > 0 and a fresh
  // `updated_at` newer than the action start.
  const count = input.contendibiliUpdatedCount;
  const maxUpdatedMs = Date.parse(String(input.contendibiliMaxUpdatedAt ?? ""));
  if (!sawFailure && typeof count === "number" && count > 0 &&
      Number.isFinite(maxUpdatedMs) && maxUpdatedMs >= startedMs) {
    return {
      reconciled: true,
      evidence: "reconciled_after_timeout",
      evidence_source: "padova_contendibili_updated_rows",
      observed_at: new Date(maxUpdatedMs).toISOString(),
      result: { ok: true, contendibili_updated_rows: count },
    };
  }

  if (sawFailure) return { reconciled: false, reason: "reconcile_result_failed" };
  if (count === null) return { reconciled: false, reason: "reconcile_evidence_unavailable" };
  if (sawStale) return { reconciled: false, reason: "reconcile_evidence_stale" };
  return { reconciled: false, reason: "reconcile_evidence_absent" };
}

/** Only transport-level non-successes may be reconciled; semantic failures may not. */
export function isReconcilableFailure(status: number, reason: string | null): boolean {
  if (status === 504 && (reason === "timeout" || reason === null)) return true;
  if (status === 502 && reason === "network_error") return true;
  return false;
}
