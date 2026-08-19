// Pure helpers for Apify collect-pending drain, dataset paging, and webhooks.
// No secrets, no I/O. Safe to unit-test from Vitest and Deno.

export const APIFY_DATASET_PAGE_SIZE = 1000;
export const APIFY_DATASET_HARD_CAP = 10_000;
export const COLLECT_CRON_TIMEOUT_MS = 110_000;
export const COLLECT_DRAIN_PAUSE_MS = 5_000;
export const APIFY_WAIT_FOR_FINISH_MAX_SEC = 50;

export const APIFY_PENDING_STATUSES = new Set(["READY", "RUNNING"]);
export const APIFY_SUCCESS_STATUSES = new Set(["SUCCEEDED"]);
export const APIFY_FAIL_STATUSES = new Set(["FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]);

export const APIFY_RUN_WEBHOOK_EVENTS = [
  "ACTOR.RUN.SUCCEEDED",
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.ABORTED",
  "ACTOR.RUN.TIMED_OUT",
] as const;

export function isApifyPending(status: unknown): boolean {
  return APIFY_PENDING_STATUSES.has(String(status ?? "").toUpperCase());
}

export function isApifySucceeded(status: unknown): boolean {
  return APIFY_SUCCESS_STATUSES.has(String(status ?? "").toUpperCase());
}

export function isApifyFailed(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return APIFY_FAIL_STATUSES.has(s) || s === "ABORTED_COST_CAP";
}

export function clampMaxItemsPerRun(value: unknown, fallback = APIFY_DATASET_HARD_CAP): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(APIFY_DATASET_HARD_CAP, Math.max(1, Math.trunc(n)));
}

export function datasetPagePlan(
  maxItems: number,
  pageSize = APIFY_DATASET_PAGE_SIZE,
): Array<{ offset: number; limit: number }> {
  const cap = clampMaxItemsPerRun(maxItems);
  const size = Math.min(APIFY_DATASET_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)));
  const pages: Array<{ offset: number; limit: number }> = [];
  for (let offset = 0; offset < cap; offset += size) {
    pages.push({ offset, limit: Math.min(size, cap - offset) });
  }
  return pages;
}

export function datasetWasTruncated(
  fetched: number,
  maxItems: number,
  lastPageLength: number,
  requestedLimit: number,
): boolean {
  if (fetched >= maxItems) return true;
  return lastPageLength >= requestedLimit && fetched > 0;
}

function asRunId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id === "ERROR") return null;
  if (id.length < 8 || id.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

/** Collect explicit run_ids plus Apify webhook resource / eventData ids. */
export function extractCollectRunIds(body: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const id = asRunId(value);
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  if (!body || typeof body !== "object" || Array.isArray(body)) return ids;
  const rec = body as Record<string, unknown>;

  if (Array.isArray(rec.run_ids)) {
    for (const value of rec.run_ids) push(value);
  }
  push(rec.run_id);

  const resource = rec.resource;
  if (resource && typeof resource === "object" && !Array.isArray(resource)) {
    push((resource as Record<string, unknown>).id);
  }

  const eventData = rec.eventData;
  if (eventData && typeof eventData === "object" && !Array.isArray(eventData)) {
    push((eventData as Record<string, unknown>).actorRunId);
  }

  return ids;
}

export function isApifyRunWebhook(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const eventType = String((body as Record<string, unknown>).eventType ?? "");
  return eventType.startsWith("ACTOR.RUN.");
}

export type CollectResultLike = {
  action?: unknown;
  status?: unknown;
  error?: unknown;
  promote_error?: unknown;
  errors?: unknown;
  items?: unknown;
  created?: unknown;
  updated?: unknown;
};

export function isStillRunningResult(result: CollectResultLike | null | undefined): boolean {
  if (!result) return false;
  if (String(result.action ?? "") === "still_running") return true;
  return isApifyPending(result.status);
}

export function collectPendingCount(results: CollectResultLike[]): number {
  return results.filter((result) => isStillRunningResult(result)).length;
}

export function collectHttpStatus(opts: {
  ok: boolean;
  pendingCount: number;
  errorsCount: number;
}): number {
  if (opts.ok) return 200;
  if (opts.pendingCount > 0 && opts.errorsCount === opts.pendingCount) return 202;
  return 502;
}

export function collectTickNeedsContinue(opts: {
  pendingCount: number;
  httpStatus: number;
  ok: boolean;
}): boolean {
  return opts.pendingCount > 0 || opts.httpStatus === 202 || (!opts.ok && opts.httpStatus === 202);
}

export function waitForFinishSeconds(remainingMs: number, maxSec = APIFY_WAIT_FOR_FINISH_MAX_SEC): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  const sec = Math.floor(remainingMs / 1000) - 2;
  return Math.min(maxSec, Math.max(0, sec));
}

export function drainLoopShouldContinue(opts: {
  startedAtMs: number;
  nowMs: number;
  wallBudgetMs: number;
  needsContinue: boolean;
  pauseMs?: number;
}): boolean {
  if (!opts.needsContinue) return false;
  const pause = opts.pauseMs ?? COLLECT_DRAIN_PAUSE_MS;
  return opts.nowMs + pause < opts.startedAtMs + opts.wallBudgetMs;
}

export type ApifyAdhocWebhook = {
  eventTypes: string[];
  requestUrl: string;
  ignoreSsl: boolean;
  headersTemplate: string;
  payloadTemplate?: string;
};

export function buildApifyRunWebhooks(opts: {
  requestUrl: string;
  jobSecret: string;
}): ApifyAdhocWebhook[] | null {
  const url = String(opts.requestUrl ?? "").trim();
  const secret = String(opts.jobSecret ?? "");
  if (!/^https:\/\//i.test(url)) return null;
  if (!url.includes("/functions/v1/padova-apify-collect-pending")) return null;
  if (!secret) return null;
  return [{
    eventTypes: [...APIFY_RUN_WEBHOOK_EVENTS],
    requestUrl: url,
    ignoreSsl: false,
    headersTemplate: JSON.stringify({ "x-job-secret": secret }),
    payloadTemplate: '{"run_ids":["{{resource.id}}"]}',
  }];
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function encodeApifyWebhooksQuery(webhooks: ApifyAdhocWebhook[]): string {
  return utf8ToBase64(JSON.stringify(webhooks));
}

export function collectPendingWebhookUrl(supabaseUrl: string): string {
  const base = String(supabaseUrl ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) return "";
  return `${base}/functions/v1/padova-apify-collect-pending`;
}

export function shouldSkipZombieMark(apifyStatus: unknown): boolean {
  // SUCCEEDED zombies must stay selectable for ingest (imported=0).
  // Still-running actors are left for the next drain tick / webhook.
  return isApifySucceeded(apifyStatus) || isApifyPending(apifyStatus);
}
