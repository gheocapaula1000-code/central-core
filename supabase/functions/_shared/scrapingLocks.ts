// Pure helpers for scraping-worker / result-processor drain and leases.

export const WORKER_LEASE_SECONDS = 90;
export const WORKER_DRAIN_WALL_MS = 50_000;
export const PROCESSOR_DRAIN_WALL_MS = 50_000;
export const APIFY_DATASET_PROCESSOR = "padova_apify_dataset_v1";

export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isLeaseExpired(
  lockedUntil: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lockedUntil) return true;
  const ts = lockedUntil instanceof Date ? lockedUntil.getTime() : Date.parse(String(lockedUntil));
  if (!Number.isFinite(ts)) return true;
  return ts <= now.getTime();
}

export function lostLeaseIsRetryable(status: unknown): boolean {
  return String(status ?? "") === "lost_lease";
}

/**
 * Claim size for one processing wave.
 * Drain mode claims up to `limit` (not min(limit, concurrency)) so a backlog
 * can empty inside the wall-clock budget; concurrency still bounds in-flight work.
 */
export function processorClaimLimit(opts: {
  limit: number;
  concurrency: number;
  drain: boolean;
}): number {
  const limit = Math.min(20, Math.max(1, Math.trunc(opts.limit)));
  const concurrency = Math.min(5, Math.max(1, Math.trunc(opts.concurrency)));
  if (!opts.drain) return Math.min(limit, concurrency);
  return limit;
}

export function drainBudgetRemaining(opts: {
  startedAtMs: number;
  nowMs: number;
  wallMs: number;
  reserveMs?: number;
}): number {
  const reserve = opts.reserveMs ?? 5_000;
  return opts.startedAtMs + opts.wallMs - reserve - opts.nowMs;
}

export function shouldClaimAnotherWave(opts: {
  startedAtMs: number;
  nowMs: number;
  wallMs: number;
  lastClaimed: number;
  reserveMs?: number;
}): boolean {
  if (opts.lastClaimed <= 0) return false;
  return drainBudgetRemaining(opts) > 0;
}

export function apifyPollAvailableAt(nowMs = Date.now(), delayMs = 30_000): string {
  return new Date(nowMs + delayMs).toISOString();
}
