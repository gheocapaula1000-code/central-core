// Cron wrapper: invoca padova-apify-immobiliare-collect passando il job secret
// dall'env. Chiamato ogni notte (portal-immobiliare-padova @ 02:00 UTC) e
// usabile come entrypoint manuale (override via body).
//
// Body opzionale:
//   { max_urls_from_db?: number, max_items?: number, wait_seconds?: number, dry_run?: boolean, start_urls?: string[] }
//
// Auth: CENTRAL_CORE_JOB_SECRET via x-job-secret / x-internal-secret / Bearer
// (fail-closed prima di body/log/provider).

import { classifyNightlyCollectResult, IMMOBILIARE_PADOVA_SEARCH_URLS } from "../_shared/apifyLaunch.ts";
import { writeImmobiliareSourceRegistry } from "../_shared/apify.ts";
import { isJobSecretAuthorized, jobAuthFailure, jobAuthHeaders } from "../_shared/jobAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const JOB_NAME = "central-core-apify-immobiliare-nightly";
const TARGET = `${SUPABASE_URL}/functions/v1/padova-apify-immobiliare-collect`;
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
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_executions_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ job_name: JOB_NAME, ...row }),
    });
  } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } });
  }
  if (!isJobSecretAuthorized(req.headers, JOB_SECRET)) {
    const auth = jobAuthFailure(Boolean(JOB_SECRET));
    await writeImmobiliareSourceRegistry({ ok: false, error: auth.error });
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
    await writeImmobiliareSourceRegistry({ ok: false, error: reason });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "success",
      http_status: 200,
      response_excerpt: "skipped Apify: Firecrawl full is the live Immobiliare path (last Apify success 2026-06-23)",
      error_message: reason,
      duration_ms: 0,
    });
    return new Response(JSON.stringify({
      ok: true,
      skipped: true,
      reason,
      live_path: "enqueue-padova-portal-scrapes / scraping_queue / padova_portal_collect_v2",
      note: "Apify Immobiliare last success 2026-06-23. Firecrawl full 30 pages succeeded 2026-08-20 03:39Z. Pass force_apify=true to start Apify.",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const body = {
    mode: "mixed",
    desired_results: 300,
    max_items: 800,
    search_urls: [...IMMOBILIARE_PADOVA_SEARCH_URLS],
    refresh_urls: [] as string[],
    wait_seconds: 300,
    dry_run: false,
    async_start: true,
    ...overrides,
  };

  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started ${JSON.stringify({
      mode: body.mode,
      search_urls: Array.isArray(body.search_urls) ? body.search_urls.length : 0,
      async_start: body.async_start,
    })}`,
    duration_ms: 0,
  });

  const t0 = Date.now();
  const authHeaders = jobAuthHeaders(JOB_SECRET, ANON_KEY);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LAUNCH_TIMEOUT_MS);
    const res = await fetch(TARGET, {
      method: "POST",
      headers: authHeaders,
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
      errors: obj?.errors,
    });

    await writeImmobiliareSourceRegistry({
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

    if (semantic.ok && Array.isArray(obj?.started)) {
      const runIds = (obj.started as Array<Record<string, unknown>>)
        .map((row) => String(row?.run_id ?? "")).filter(Boolean);
      if (runIds.length > 0) {
        fetch(COLLECT_PENDING, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ run_ids: runIds, stale_minutes: 0, max_runs: runIds.length }),
        }).catch((e) => console.warn("[immobiliare-nightly] collect-pending handoff", String(e)));
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
    const msg = err instanceof Error ? err.message : String(err);
    await writeImmobiliareSourceRegistry({ ok: false, error: msg });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: null,
      error_message: msg,
      duration_ms: dur,
    });
    return new Response(
      JSON.stringify({ ok: false, error: msg, duration_ms: dur }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
