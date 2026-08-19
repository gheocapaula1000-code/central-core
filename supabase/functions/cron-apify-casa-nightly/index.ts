// cron-apify-casa-nightly
// Wrapper cron per padova-apify-casa-collect (async_start pattern).
// Triggerato da pg_cron 02:30 UTC (portal-casa-padova). collect-pending
// (webhook + cron) completa l'ingest. Empty / skipped = fail, not fake success.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import {
  CASA_CRON_JOB,
  CASA_DEFAULT_LOCATION,
  CASA_DEFAULT_MAX_ITEMS,
  classifyCasaNightlyResult,
  isJobSecretAuthorized,
  jobAuthFailure,
  redactApifyText,
} from "../_shared/casaCollect.ts";

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

async function logExecution(row: {
  triggered_at: string;
  completed_at: string;
  status: "started" | "success" | "failure";
  http_status: number | null;
  response_excerpt?: string | null;
  error_message?: string | null;
  duration_ms: number;
}) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/cron_executions_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ job_name: CASA_CRON_JOB, ...row }),
    });
  } catch { /* best effort */ }
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: jsonHeaders });
  }

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  if (!secret || !base) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 500, headers: jsonHeaders });
  }
  if (!isJobSecretAuthorized(req.headers, secret)) {
    const fail = jobAuthFailure(true);
    return new Response(JSON.stringify({ ok: false, error: fail.error }),
      { status: fail.status, headers: jsonHeaders });
  }

  let body: Record<string, unknown> = {
    async_start: true,
    max_items: CASA_DEFAULT_MAX_ITEMS,
    locations: [CASA_DEFAULT_LOCATION],
  };
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = { ...body, ...raw, async_start: true };
  } catch { /* empty ok */ }

  await logExecution({
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started ${JSON.stringify(body).slice(0, 300)}`,
    duration_ms: 0,
  });

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const r = await fetch(`${base}/functions/v1/padova-apify-casa-collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": secret,
        "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    const dur = Date.now() - t0;
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = text ? JSON.parse(text) : null;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
    } catch { /* invalid JSON = failure */ }
    const classified = classifyCasaNightlyResult(r.status, parsed);
    const excerpt = redactApifyText(text).slice(0, 1500);
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: classified.ok ? "success" : "failure",
      http_status: r.status,
      response_excerpt: excerpt,
      error_message: classified.ok ? null : (classified.reason ?? "downstream_semantic_failure"),
      duration_ms: dur,
    });
    return new Response(JSON.stringify({
      ok: classified.ok,
      http_status: r.status,
      duration_ms: dur,
      started_count: classified.started_count,
      result: parsed,
    }), {
      status: classified.ok ? 200 : (r.ok ? 502 : r.status),
      headers: jsonHeaders,
    });
  } catch (error) {
    clearTimeout(timer);
    const dur = Date.now() - t0;
    const timeout = error instanceof Error && error.name === "AbortError";
    const msg = timeout ? "timeout" : (error instanceof Error ? error.message : "network_error");
    await logExecution({
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: timeout ? 504 : 502,
      error_message: msg,
      duration_ms: dur,
    });
    return new Response(JSON.stringify({ ok: false, error: timeout ? "timeout" : "network_error", duration_ms: dur }), {
      status: timeout ? 504 : 502,
      headers: jsonHeaders,
    });
  }
});
