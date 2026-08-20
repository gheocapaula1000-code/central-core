// cron-apify-subito-nightly
// Wrapper cron per padova-apify-subito-collect (async_start pattern).
// Triggered by portal-subito-padova (02:20 UTC daily) and apify-subito-weekly
// (03:30 UTC Sunday). collect-pending + Apify webhook complete ingest.
//
// Auth: CENTRAL_CORE_JOB_SECRET via x-job-secret / x-internal-secret / Bearer
// (fail-closed before body/log/provider). No secrets in this file.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { classifyNightlyCollectResult, SUBITO_PADOVA_SEARCH_URLS } from "../_shared/apifyLaunch.ts";
import { handoffCollectPending, writeSubitoSourceRegistry } from "../_shared/apify.ts";
import { isJobSecretAuthorized, jobAuthFailure, jobAuthHeaders } from "../_shared/jobAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const JOB_NAME = "portal-subito-padova";
const TARGET = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/padova-apify-subito-collect`;
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
  if (!SERVICE_KEY || !SUPABASE_URL) return;
  try {
    await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/cron_executions_log`, {
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!isJobSecretAuthorized(req.headers, JOB_SECRET)) {
    const auth = jobAuthFailure(Boolean(JOB_SECRET));
    await writeSubitoSourceRegistry({ ok: false, error: auth.error });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: auth.status,
      error_message: auth.error,
      duration_ms: 0,
    });
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!SUPABASE_URL) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let overrides: Record<string, unknown> = {};
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") overrides = raw as Record<string, unknown>;
  } catch { /* empty ok */ }

  if (overrides.force_apify !== true) {
    const reason = "firecrawl_soft_is_primary";
    await writeSubitoSourceRegistry({ ok: false, error: reason });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "success",
      http_status: 200,
      response_excerpt: "skipped Apify full: Firecrawl soft is the live Subito path",
      error_message: reason,
      duration_ms: 0,
    });
    return new Response(JSON.stringify({
      ok: true,
      skipped: true,
      reason,
      live_path: "enqueue-padova-portal-scrapes / scraping_queue / padova_portal_collect_v2",
      note: "Subito Apify full FAILED 2026-08-19 watchdog_timeout. Soft Firecrawl is live. Pass force_apify=true only for a capped probe.",
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = {
    max_items: 40,
    search_urls: [...SUBITO_PADOVA_SEARCH_URLS],
    dry_run: false,
    ...overrides,
    async_start: true,
  };

  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started ${JSON.stringify({
      search_urls: Array.isArray(body.search_urls) ? body.search_urls.length : 0,
      max_items: body.max_items,
      async_start: true,
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
      errors: obj?.errors,
      run_id: obj?.run_id,
    });

    await writeSubitoSourceRegistry({
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
      const fromStarted = Array.isArray(obj?.started)
        ? (obj.started as Array<Record<string, unknown>>)
          .map((row) => String(row?.run_id ?? "")).filter(Boolean)
        : [];
      const runIds = fromStarted.length
        ? fromStarted
        : (typeof obj?.run_id === "string" && obj.run_id ? [obj.run_id] : []);
      if (runIds.length > 0) handoffCollectPending(runIds);
    }

    return new Response(JSON.stringify({
      ok: semantic.ok,
      http_status: res.status,
      duration_ms: dur,
      started_count: semantic.started_count,
      errors_count: semantic.errors_count,
      error: semantic.reason,
      result: parsed,
    }), {
      status: semantic.ok ? 200 : (res.ok ? 502 : res.status),
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const dur = Date.now() - t0;
    const timeout = error instanceof Error && error.name === "AbortError";
    const msg = timeout ? "timeout" : (error instanceof Error ? error.message : "network_error");
    await writeSubitoSourceRegistry({ ok: false, error: msg });
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: timeout ? 504 : 502,
      error_message: msg,
      duration_ms: dur,
    });
    return new Response(JSON.stringify({ ok: false, error: msg, duration_ms: dur }), {
      status: timeout ? 504 : 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
