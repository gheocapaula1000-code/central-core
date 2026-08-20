// Cron wrapper: invoca padova-apify-idealista-collect passando il job secret
// dall'env. Chiamato ogni notte (portal-idealista-padova @ 02:10 UTC) e
// usabile come entrypoint manuale (override via body).
//
// Body opzionale (override):
//   { mode?, desired_results?, max_urls_from_db?, max_items?, wait_seconds?, dry_run?, discovery_urls?, refresh_urls?, refresh_stale_days? }
//
// Auth: CENTRAL_CORE_JOB_SECRET via x-job-secret / x-internal-secret / Bearer
// (fail-closed prima di body/log/provider).

import {
  classifyNightlyCollectResult,
  extractStartedRunIds,
  IDEALISTA_PADOVA_DISCOVERY_URLS,
} from "../_shared/apifyLaunch.ts";
import { writeIdealistaSourceRegistry } from "../_shared/apify.ts";
import { isJobSecretAuthorized, jobAuthFailure, jobAuthHeaders } from "../_shared/jobAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const JOB_NAMES = [
  "central-core-apify-idealista-nightly",
  "portal-idealista-padova",
] as const;
const TARGET = `${SUPABASE_URL}/functions/v1/padova-apify-idealista-collect`;
const COLLECT_PENDING = `${SUPABASE_URL}/functions/v1/padova-apify-collect-pending`;
const LAUNCH_TIMEOUT_MS = 50_000;

async function logExecution(row: {
  triggered_at: string;
  completed_at: string;
  status: "started" | "success" | "failure";
  http_status: number | null;
  response_excerpt?: string | null;
  error_message?: string | null;
  duration_ms: number;
}) {
  if (!SERVICE_KEY) return;
  for (const job_name of JOB_NAMES) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/cron_executions_log`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ job_name, ...row }),
      });
    } catch (_) { /* best effort */ }
  }
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } });
  }
  if (!isJobSecretAuthorized(req.headers, JOB_SECRET)) {
    const auth = jobAuthFailure(Boolean(JOB_SECRET));
    await writeIdealistaSourceRegistry({ ok: false, error: auth.error });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: auth.status,
      error_message: auth.error,
      duration_ms: 0,
    });
    return new Response(JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { "Content-Type": "application/json" } });
  }

  let overrides: Record<string, unknown> = {};
  try { overrides = await req.json(); } catch { /* body vuoto ok */ }

  if (overrides.force_apify !== true) {
    const reason = "firecrawl_is_primary";
    await writeIdealistaSourceRegistry({ ok: false, error: reason });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "success",
      http_status: 200,
      response_excerpt: "skipped Apify: Firecrawl soft is the live Idealista path (Apify mixed 2026-08-05)",
      error_message: reason,
      duration_ms: 0,
    });
    return new Response(JSON.stringify({
      ok: true,
      skipped: true,
      reason,
      live_path: "enqueue-padova-portal-scrapes / scraping_queue / padova_portal_collect_v2",
      note: "Apify Idealista last mixed 2026-08-05. Firecrawl soft p1 succeeded 2026-08-20 07:45Z. Pass force_apify=true to start Apify.",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const body = {
    mode: "mixed",
    desired_results: 300,
    max_urls_from_db: 240,
    max_items: 600,
    wait_seconds: 300,
    dry_run: false,
    async_start: true,
    discovery_urls: [...IDEALISTA_PADOVA_DISCOVERY_URLS],
    ...overrides,
  };


  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started ${JSON.stringify({
      mode: body.mode,
      discovery_urls: Array.isArray(body.discovery_urls) ? body.discovery_urls.length : 0,
      async_start: body.async_start,
    })}`,
    duration_ms: 0,
  });

  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LAUNCH_TIMEOUT_MS);
    const res = await fetch(TARGET, {
      method: "POST",
      headers: jobAuthHeaders(JOB_SECRET),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    const dur = Date.now() - t0;
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    const semantic = classifyNightlyCollectResult({
      httpOk: res.ok,
      ok: obj?.ok,
      error: obj?.error ?? obj?.reason,
      skipped: obj?.skipped,
      started: obj?.started,
      run_id: obj?.run_id,
      errors: obj?.errors,
    });

    await writeIdealistaSourceRegistry({
      ok: semantic.ok,
      records: semantic.started_count,
      error: semantic.reason ?? undefined,
    });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: semantic.ok ? "success" : "failure",
      http_status: res.status,
      response_excerpt: text.slice(0, 1500),
      error_message: semantic.reason,
      duration_ms: dur,
    });

    if (semantic.ok) {
      const runIds = extractStartedRunIds(obj);
      if (runIds.length > 0) {
        fetch(COLLECT_PENDING, {
          method: "POST",
          headers: jobAuthHeaders(JOB_SECRET),
          body: JSON.stringify({ run_ids: runIds, stale_minutes: 0, max_runs: runIds.length }),
        }).catch((e) => console.warn("[idealista-nightly] collect-pending handoff", String(e)));
      }
    }

    return new Response(
      JSON.stringify({
        ok: semantic.ok, http_status: res.status, duration_ms: dur,
        started_count: semantic.started_count, errors_count: semantic.errors_count,
        error: semantic.reason, result: parsed ?? null,
      }, null, 2),
      { status: semantic.ok ? 200 : (res.ok ? 502 : res.status), headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const dur = Date.now() - t0;
    const timeout = err instanceof Error && err.name === "AbortError";
    const msg = timeout ? "timeout" : (err instanceof Error ? err.message : String(err));
    await writeIdealistaSourceRegistry({ ok: false, error: msg });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: timeout ? 504 : null,
      error_message: msg,
      duration_ms: dur,
    });
    return new Response(
      JSON.stringify({ ok: false, error: msg, duration_ms: dur, started_count: 0 }),
      { status: timeout ? 504 : 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
