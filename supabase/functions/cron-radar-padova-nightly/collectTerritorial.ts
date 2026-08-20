// Territorial collection fan-out used by cron-radar-padova-nightly.
// Hits the real civiko-radar-veneto job routes with persist flags + job secret.
// Pure request shaping is unit-testable; fetch is injected.

import { scheduledCollectBody } from "./scheduledPersist.ts";

export type RadarMode = "soft" | "full";

export interface TerritorialCollectJob {
  slug: "import-arpav-air-quality" | "anac-ckan" | "asteGiudiziarie";
  path: string;
  timeoutMs: number;
  modes: readonly RadarMode[];
}

export const TERRITORIAL_COLLECT_JOBS: readonly TerritorialCollectJob[] = [
  {
    slug: "import-arpav-air-quality",
    path: "/functions/v1/civiko-radar-veneto/jobs/import-arpav-air-quality",
    timeoutMs: 12_000,
    modes: ["soft", "full"],
  },
  {
    slug: "anac-ckan",
    path: "/functions/v1/civiko-radar-veneto/jobs/anac-ckan",
    timeoutMs: 12_000,
    modes: ["soft", "full"],
  },
  {
    slug: "asteGiudiziarie",
    path: "/functions/v1/civiko-radar-veneto/jobs/asteGiudiziarie",
    timeoutMs: 16_000,
    modes: ["full"],
  },
];

export function jobsForMode(mode: RadarMode): TerritorialCollectJob[] {
  return TERRITORIAL_COLLECT_JOBS.filter((j) => j.modes.includes(mode));
}

export function territorialCollectHeaders(jobSecret: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-job-secret": jobSecret,
    "x-internal-secret": jobSecret,
    "x-source-app": "central-core-cron",
  };
}

export function territorialCollectBody(mode: RadarMode, triggeredBy: string): Record<string, unknown> {
  return scheduledCollectBody(triggeredBy, { intent: mode });
}

export interface CollectJobResult {
  slug: string;
  ok: boolean;
  http_status: number | null;
  duration_ms: number;
  error?: string;
}

export interface CollectSummary {
  ok: boolean;
  mode: RadarMode;
  auth_rejected: boolean;
  results: CollectJobResult[];
}

export async function collectTerritorialSignals(opts: {
  supabaseUrl: string;
  jobSecret: string;
  mode: RadarMode;
  triggeredBy: string;
  fetchImpl?: typeof fetch;
}): Promise<CollectSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = territorialCollectHeaders(opts.jobSecret);
  const body = territorialCollectBody(opts.mode, opts.triggeredBy);
  const results: CollectJobResult[] = [];

  for (const job of jobsForMode(opts.mode)) {
    const t0 = Date.now();
    const target = `${opts.supabaseUrl.replace(/\/+$/, "")}${job.path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), job.timeoutMs);
    try {
      const res = await fetchImpl(target, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      let parsed: { ok?: boolean } | null = null;
      try { parsed = text ? JSON.parse(text) as { ok?: boolean } : null; } catch { /* raw */ }
      const ok = res.ok && parsed?.ok !== false;
      results.push({
        slug: job.slug,
        ok,
        http_status: res.status,
        duration_ms: Date.now() - t0,
        error: ok ? undefined : `HTTP ${res.status}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        slug: job.slug,
        ok: false,
        http_status: null,
        duration_ms: Date.now() - t0,
        error: /abort/i.test(msg) ? "timeout" : msg.slice(0, 160),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const auth_rejected = results.length > 0 && results.every((r) => r.http_status === 401);
  return {
    ok: results.length > 0 && results.every((r) => r.ok),
    mode: opts.mode,
    auth_rejected,
    results,
  };
}
