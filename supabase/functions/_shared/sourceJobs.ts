// _shared/sourceJobs.ts
// Pure orchestration helpers for the scheduled-source runner.
// No live HTTP calls happen in this module — the caller injects `fetchImpl`
// so the same logic is unit-testable and can be wired to real edge functions
// from the civiko-scheduler edge function.

import { SOURCE_PLAN, nextRunAfter, isStale, type SourcePlan } from "./sourceScheduler.ts";

export type JobOutcome = "skipped" | "success" | "failed";

export interface JobResult {
  source_code: string;
  status: JobOutcome;
  records_processed: number;
  error: string | null;
  duration_ms: number;
  next_run_at: string | null;
  reason?: string;
}

export interface RunOptions {
  /** When set, only run this specific source. */
  source_code?: string;
  /** Run all sources whose next_run_at is null or in the past. Default false → run all eligible. */
  due_only?: boolean;
  /** If true, do not invoke job endpoints and do not write to the registry. */
  dry_run?: boolean;
}

export interface RunDeps {
  /** Service-role Supabase client. Required when dry_run = false. */
  // deno-lint-ignore no-explicit-any
  supabase: any;
  /** Fetch implementation. Defaults to global fetch. Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Base URL for the project edge functions (e.g. https://<ref>.supabase.co/functions/v1). */
  baseUrl: string;
  /** Job secret to forward to internal endpoints. */
  jobSecret: string;
}

/** Source codes that MUST NEVER be auto-scheduled. */
export const FORBIDDEN_SCHEDULER_CODES = new Set(["F14", "F15"]);

/** Returns the plan rows that are eligible for scheduled execution. */
export function eligibleSourcePlans(): SourcePlan[] {
  return Object.values(SOURCE_PLAN).filter((p) => {
    if (FORBIDDEN_SCHEDULER_CODES.has(p.code)) return false;
    if (p.automation_status === "premium_on_demand") return false;
    if (p.automation_status === "disabled") return false;
    // Only sources with a real ingestion target are runnable.
    return Boolean(p.job) || Boolean(p.ingestion_endpoint);
  });
}

/** Decide if a source row is due now. NULL last_run_at counts as due. */
export function isDue(plan: SourcePlan, lastRunAt: string | null, now = new Date()): boolean {
  if (!lastRunAt) return true;
  const t = Date.parse(lastRunAt);
  if (!Number.isFinite(t)) return true;
  const next = nextRunAfter(plan.scheduler_frequency, new Date(t));
  if (!next) return false;
  return now >= next;
}

/**
 * Execute the configured ingestion path for a single source.
 * - automated/semi_automated with a `job` → POST {baseUrl}/{job} with x-job-secret
 * - manual_fallback → returns skipped:"manual_fallback" (never fakes a run)
 */
export async function runOne(
  plan: SourcePlan,
  deps: RunDeps,
  opts: { dry_run?: boolean } = {},
): Promise<JobResult> {
  const started = Date.now();
  const baseResult: JobResult = {
    source_code: plan.code,
    status: "skipped",
    records_processed: 0,
    error: null,
    duration_ms: 0,
    next_run_at: nextRunAfter(plan.scheduler_frequency)?.toISOString() ?? null,
  };

  if (FORBIDDEN_SCHEDULER_CODES.has(plan.code)) {
    return { ...baseResult, status: "skipped", reason: "premium_on_demand_blocked", duration_ms: Date.now() - started };
  }
  if (plan.automation_status === "manual_fallback") {
    return { ...baseResult, status: "skipped", reason: "manual_fallback", duration_ms: Date.now() - started };
  }
  if (!plan.job && !plan.ingestion_endpoint) {
    return { ...baseResult, status: "skipped", reason: "no_ingestion_path", duration_ms: Date.now() - started };
  }
  if (opts.dry_run) {
    return { ...baseResult, status: "skipped", reason: "dry_run", duration_ms: Date.now() - started };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const path = plan.ingestion_endpoint ?? `/${plan.job}`;
  const url = `${deps.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": deps.jobSecret,
      },
      body: JSON.stringify({ triggered_by: "civiko-scheduler", source_code: plan.code }),
    });
    const text = await r.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON: keep empty */ }
    const records =
      typeof parsed.records_processed === "number" ? parsed.records_processed :
      typeof (parsed.data as Record<string, unknown> | undefined)?.records_processed === "number"
        ? Number((parsed.data as Record<string, unknown>).records_processed)
        : 0;

    if (!r.ok) {
      const msg = `HTTP ${r.status}: ${text.slice(0, 200)}`;
      await safeUpdateRegistry(deps.supabase, plan.code, { ok: false, error: msg });
      return { ...baseResult, status: "failed", error: msg, duration_ms: Date.now() - started };
    }

    await safeUpdateRegistry(deps.supabase, plan.code, { ok: true, records });
    return { ...baseResult, status: "success", records_processed: records, duration_ms: Date.now() - started };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await safeUpdateRegistry(deps.supabase, plan.code, { ok: false, error: msg });
    return { ...baseResult, status: "failed", error: msg.slice(0, 300), duration_ms: Date.now() - started };
  }
}

async function safeUpdateRegistry(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  source_code: string,
  outcome: { ok: boolean; records?: number; error?: string },
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_run_at: now };
  if (outcome.ok) {
    patch.last_success_at = now;
    patch.last_error = null;
    if (typeof outcome.records === "number") patch.record_count = outcome.records;
  } else {
    patch.last_error = (outcome.error ?? "unknown").slice(0, 500);
  }
  try {
    await supabase.from("civiko_source_registry").update(patch).eq("source_code", source_code);
  } catch (e) {
    console.warn("safeUpdateRegistry failed", source_code, (e as Error).message);
  }
}

/**
 * Run multiple sources, isolating per-source failures so one bad source
 * never stops the others.
 */
export async function runScheduledSources(deps: RunDeps, opts: RunOptions = {}): Promise<{
  ran_at: string;
  dry_run: boolean;
  results: JobResult[];
  summary: { total: number; success: number; failed: number; skipped: number };
}> {
  const ran_at = new Date().toISOString();
  const dry_run = Boolean(opts.dry_run);
  let plans = eligibleSourcePlans();
  if (opts.source_code) {
    plans = plans.filter((p) => p.code === opts.source_code);
  }

  // due_only filter requires the current registry rows.
  if (opts.due_only && !opts.source_code) {
    const { data } = deps.supabase
      ? await deps.supabase
          .from("civiko_source_registry")
          .select("source_code, last_run_at")
      : { data: [] };
    const map = new Map<string, string | null>((data ?? []).map(
      (r: { source_code: string; last_run_at: string | null }) => [r.source_code, r.last_run_at],
    ));
    plans = plans.filter((p) => isDue(p, map.get(p.code) ?? null));
  }

  const results: JobResult[] = [];
  for (const p of plans) {
    try {
      results.push(await runOne(p, deps, { dry_run }));
    } catch (e) {
      results.push({
        source_code: p.code,
        status: "failed",
        records_processed: 0,
        error: ((e as Error).message ?? String(e)).slice(0, 300),
        duration_ms: 0,
        next_run_at: nextRunAfter(p.scheduler_frequency)?.toISOString() ?? null,
        reason: "runner_exception_isolated",
      });
    }
  }

  const summary = {
    total: results.length,
    success: results.filter((r) => r.status === "success").length,
    failed:  results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
  return { ran_at, dry_run, results, summary };
}

export { isStale, nextRunAfter };
