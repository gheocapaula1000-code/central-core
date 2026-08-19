// Watchdog for Padova scrape / cron jobs.
//
// public-padova-meta-stats maps running/started/in_progress/queued → "running".
// Collectors skip when a row is still open (e.g. subito_run_already_running).
// Without a timeout those rows stay open forever and later scheduled collects
// never start. This module is the single place that:
//   1) decides whether an open status has expired
//   2) builds the FAILED patch that releases the lock
//   3) applies the expire update on the two tables the public meta endpoint reads
//
// No secrets. Pure helpers are unit-tested; DB writes stay best-effort.

export const DEFAULT_TIMEOUT_MS = 4 * 3600_000;
export const WATCHDOG_ERROR = "watchdog_timeout";
export const WATCHDOG_UNRECOVERABLE = "watchdog_timeout_unrecoverable";

export const OPEN_STATUSES = [
  "RUNNING",
  "READY",
  "STARTED",
  "IN_PROGRESS",
  "QUEUED",
  "running",
  "ready",
  "started",
  "in_progress",
  "queued",
] as const;

const OPEN_SET = new Set<string>(
  OPEN_STATUSES.map((s) => s.toLowerCase()),
);

const SUCCESS_SET = new Set([
  "done",
  "success",
  "succeeded",
  "completed",
  "ok",
]);

const FAILED_SET = new Set([
  "failed",
  "error",
  "errored",
  "stopped_spend_cap",
  "timed-out",
  "timed_out",
  "aborted",
  "quarantined",
]);

export type PublicScrapeStatus = "success" | "failed" | "running" | "unknown";

export function isOpenStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return OPEN_SET.has(status.toLowerCase());
}

export function isExpired(
  startedAt: string | Date | null | undefined,
  now: Date,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): boolean {
  if (!startedAt) return false;
  const t = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= timeoutMs;
}

export function classifyPublicScrapeStatus(
  status: string | null | undefined,
  startedAt: string | Date | null | undefined,
  now: Date,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): PublicScrapeStatus {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (SUCCESS_SET.has(s)) return "success";
  if (FAILED_SET.has(s)) return "failed";
  if (OPEN_SET.has(s)) {
    return isExpired(startedAt, now, timeoutMs) ? "failed" : "running";
  }
  return "unknown";
}

export function buildExpiredApifyPatch(now: Date): {
  status: "FAILED";
  error: typeof WATCHDOG_ERROR;
  finished_at: string;
} {
  return {
    status: "FAILED",
    error: WATCHDOG_ERROR,
    finished_at: now.toISOString(),
  };
}

export function buildExpiredFirecrawlPatch(now: Date): {
  status: "failed";
  last_error: typeof WATCHDOG_ERROR;
  finished_at: string;
  updated_at: string;
} {
  const iso = now.toISOString();
  return {
    status: "failed",
    last_error: WATCHDOG_ERROR,
    finished_at: iso,
    updated_at: iso,
  };
}

export function buildExpiredCronLogPatch(now: Date): {
  status: "failure";
  completed_at: string;
  error_message: typeof WATCHDOG_ERROR;
} {
  return {
    status: "failure",
    completed_at: now.toISOString(),
    error_message: WATCHDOG_ERROR,
  };
}

export type WatchdogRow = {
  status?: string | null;
  started_at?: string | Date | null;
  updated_at?: string | Date | null;
};

/** Heartbeat clock: Apify uses started_at; Firecrawl batches bump updated_at. */
export function jobClock(row: WatchdogRow): string | Date | null {
  return row.updated_at ?? row.started_at ?? null;
}

export function selectExpiredJobs<T extends WatchdogRow>(
  rows: T[],
  now: Date,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): T[] {
  return rows.filter((row) =>
    isOpenStatus(row.status) && isExpired(jobClock(row), now, timeoutMs)
  );
}

type FilterBuilder = {
  in: (col: string, vals: readonly string[]) => FilterBuilder;
  lt: (col: string, val: string) => FilterBuilder;
  eq: (col: string, val: string) => FilterBuilder;
  select: (cols: string) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
};

type UpdateBuilder = FilterBuilder;

export type WatchdogClient = {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => UpdateBuilder;
  };
};

export type WatchdogCounts = {
  apify: number;
  firecrawl: number;
  cron_log: number;
};

async function countUpdate(
  builder: Promise<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<number> {
  const { data, error } = await builder;
  if (error) return 0;
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Mark open scrape/cron rows older than `timeoutMs` as failed.
 * Releases skip-locks (RUNNING rows) so the next scheduled collect can start.
 * Best-effort: a failed table update does not abort the others.
 */
export async function expireStaleScrapeJobs(
  sb: WatchdogClient,
  now: Date = new Date(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WatchdogCounts> {
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
  const apifyPatch = buildExpiredApifyPatch(now);
  const fcPatch = buildExpiredFirecrawlPatch(now);
  const cronPatch = buildExpiredCronLogPatch(now);
  const counts: WatchdogCounts = { apify: 0, firecrawl: 0, cron_log: 0 };

  try {
    counts.apify = await countUpdate(
      sb.from("padova_apify_runs")
        .update(apifyPatch)
        .in("status", OPEN_STATUSES)
        .lt("started_at", cutoff)
        .select("run_id"),
    );
  } catch { /* best effort */ }

  try {
    counts.firecrawl = await countUpdate(
      sb.from("padova_firecrawl_jobs")
        .update(fcPatch)
        .in("status", OPEN_STATUSES)
        .lt("updated_at", cutoff)
        .select("job_id"),
    );
  } catch { /* best effort */ }

  try {
    counts.cron_log = await countUpdate(
      sb.from("cron_executions_log")
        .update(cronPatch)
        .eq("status", "started")
        .lt("triggered_at", cutoff)
        .select("id"),
    );
  } catch { /* best effort */ }

  return counts;
}
