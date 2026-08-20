// Pure Padova portal launch helpers — no Deno.env, no network.
// Used by enqueue / kickoff / multi-launch / launch-batch so cron can start scrapes.

export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
export const LOCK_LOOKBACK_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_CASA_SEARCH_URL =
  "https://www.casa.it/vendita/residenziale/padova/";
export const DEFAULT_SUBITO_SEARCH_URL =
  "https://www.subito.it/annunci-veneto/vendita/immobili/padova/?is=t";

export type LockDecision =
  | { action: "launch" }
  | { action: "reuse"; run_id: string; dataset_id: string }
  | { action: "expire"; run_id: string };

export interface InflightRow {
  run_id?: string | null;
  dataset_id?: string | null;
  started_at?: string | null;
  status?: string | null;
}

export function isEmptyLaunchBody(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body !== "object" || Array.isArray(body)) return true;
  return Object.keys(body as Record<string, unknown>).length === 0;
}

/** Cron / kickoff empty body → start the three Padova Apify families. */
export function defaultMultiLaunchBody(): Record<string, unknown> {
  return {
    idealista: { from_db: true, max_urls: 40, cost_cap_usd: 0.20 },
    casa_full: { search_location: "Padova", max_results: 200, cost_cap_usd: 0.40 },
    subito_full: {
      disabled: true,
      reason: "firecrawl_soft_is_primary",
      search_url: DEFAULT_SUBITO_SEARCH_URL,
      max_items: 200,
      cost_cap_usd: 0.50,
    },
  };
}

export function decideInflightLock(
  row: InflightRow | null | undefined,
  nowMs: number,
  staleMs = STALE_LOCK_MS,
): LockDecision {
  const runId = typeof row?.run_id === "string" ? row.run_id.trim() : "";
  if (!row || !runId) return { action: "launch" };
  const status = String(row.status ?? "RUNNING").toUpperCase();
  if (status !== "RUNNING" && status !== "READY") return { action: "launch" };
  const started = row.started_at ? Date.parse(row.started_at) : NaN;
  const age = Number.isFinite(started) ? nowMs - started : 0;
  if (age >= staleMs) return { action: "expire", run_id: runId };
  const datasetId = typeof row.dataset_id === "string" ? row.dataset_id.trim() : "";
  if (datasetId) return { action: "reuse", run_id: runId, dataset_id: datasetId };
  // Live lock without a dataset id: still treat as held so we do not double-launch.
  return { action: "reuse", run_id: runId, dataset_id: "" };
}

export function redactLaunchError(reason: string): string {
  return String(reason ?? "")
    .replace(/token=[^&\s"]+/gi, "token=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function isBudgetReason(reason: string | undefined): boolean {
  const r = String(reason ?? "");
  return /cap_reached|BUDGET|DAILY_CAP|MONTHLY_CAP/i.test(r);
}

export function isLockReason(reason: string | undefined): boolean {
  return /already_running|inflight|lock_held|STALE/i.test(String(reason ?? ""));
}

export interface MultiLaunchResultRow {
  started?: boolean;
  skipped?: boolean;
  reason?: string;
  run_id?: string;
  dataset_id?: string;
}

export function classifyMultiLaunchOutcome(rows: MultiLaunchResultRow[]): {
  ok: boolean;
  status: number;
  started_count: number;
  reused_count: number;
  errors_count: number;
} {
  const started = rows.filter((r) => r.started === true && r.reason !== "already_running");
  const reused = rows.filter((r) => r.reason === "already_running" && typeof r.run_id === "string" && r.run_id.length > 0);
  const errors = rows.filter((r) => r.started !== true && r.reason !== "already_running");
  const started_count = started.length + reused.length;
  const errors_count = errors.length;
  if (started_count > 0 && errors_count === 0) {
    return { ok: true, status: 200, started_count, reused_count: reused.length, errors_count: 0 };
  }
  if (started_count === 0 && errors.length > 0 && errors.every((r) => isBudgetReason(r.reason))) {
    return { ok: false, status: 429, started_count: 0, reused_count: reused.length, errors_count };
  }
  if (started_count === 0 && errors.length > 0 && errors.every((r) => isLockReason(r.reason))) {
    return { ok: false, status: 409, started_count: 0, reused_count: reused.length, errors_count };
  }
  return {
    ok: false,
    status: 502,
    started_count,
    reused_count: reused.length,
    errors_count,
  };
}

export function isLockHeldEnvelope(status: number, envelope: Record<string, unknown>): boolean {
  const reason = String(
    envelope.skipped_reason ?? envelope.reason ?? envelope.error ?? "",
  );
  if (isLockReason(reason)) return true;
  if (status === 409 && (envelope.skipped === true || envelope.existing_run_id)) return true;
  return false;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function pickIdentifier(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && SAFE_ID.test(value)) return value;
  }
  return null;
}

export function identifierPairFromEnvelope(row: Record<string, unknown>): { run_id: string; dataset_id: string } | null {
  const runId = pickIdentifier(row, ["run_id", "actor_run_id", "actorRunId", "existing_run_id", "id"]);
  const datasetId = pickIdentifier(row, [
    "dataset_id",
    "default_dataset_id",
    "defaultDatasetId",
    "existing_dataset_id",
  ]);
  if (!runId || !datasetId) return null;
  return { run_id: runId, dataset_id: datasetId };
}
