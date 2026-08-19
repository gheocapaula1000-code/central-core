// Cron wrapper: invokes the Padova off-market jobs on civiko-radar-veneto.
// Invoked by pg_cron at 03:30 / 03:45 / 04:00 / 04:10 UTC using ?job=<slug>.
// Design mirrors cron-radar-padova-nightly:
//  - Sync fetch (no waitUntil), so completion is guaranteed and audited.
//  - Logs real outcome to public.cron_executions_log (never trusts net.http_post 1-row).
//  - Auth: x-job-secret / x-internal-secret / Authorization Bearer
//    == CENTRAL_CORE_JOB_SECRET (JWT bearers ignored).

import {
  jobSecretAuthorized,
  missingJobSecretConfigResponse,
  readIncomingJobSecret,
  unauthorizedJobResponse,
} from "../_shared/jobSecretAuth.ts";
import {
  JOB_NAMES,
  buildBody,
  isJobSlug,
  radarJobPath,
  targetTimeoutMs,
  type JobSlug,
} from "./jobs.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const jsonHeaders = { "Content-Type": "application/json" };

async function logExecution(jobName: string, row: {
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
      body: JSON.stringify({ job_name: jobName, ...row }),
    });
  } catch (e) {
    console.warn(`[${jobName}] logExecution failed:`, e instanceof Error ? e.message : String(e));
  }
}

async function runJob(slug: JobSlug, triggeredAt: string) {
  const jobName = JOB_NAMES[slug];
  const target = `${SUPABASE_URL}${radarJobPath(slug)}`;
  const body = buildBody(slug);
  const t0 = Date.now();

  await logExecution(jobName, {
    triggered_at: triggeredAt,
    completed_at: new Date().toISOString(),
    status: "started",
    http_status: 202,
    response_excerpt: `started slug=${slug}`,
    error_message: null,
    duration_ms: 0,
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), targetTimeoutMs(slug));
    const gateway = SERVICE_KEY || JOB_SECRET;
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
        "x-internal-secret": JOB_SECRET,
        "x-source-app": "central-core-cron",
        Authorization: `Bearer ${gateway}`,
        apikey: gateway,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    const dur = Date.now() - t0;
    let parsed: { ok?: boolean; error?: { message?: string } } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* raw */ }
    const okFlag = parsed?.ok !== false;
    const excerpt = (text || "").slice(0, 1600);
    const status: "success" | "failure" = res.ok && okFlag ? "success" : "failure";
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status,
      http_status: res.status,
      response_excerpt: excerpt,
      error_message: status === "success" ? null : (parsed?.error?.message ?? `HTTP ${res.status}`),
      duration_ms: dur,
    });
    return { ok: status === "success", http_status: res.status, duration_ms: dur };
  } catch (err) {
    const dur = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await logExecution(jobName, {
      triggered_at: triggeredAt,
      completed_at: new Date().toISOString(),
      status: "failure",
      http_status: null,
      response_excerpt: null,
      error_message: msg,
      duration_ms: dur,
    });
    return { ok: false, http_status: null as number | null, duration_ms: dur, error: msg };
  }
}

Deno.serve(async (req) => {
  const triggeredAt = new Date().toISOString();
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: jsonHeaders });
  }
  if (!JOB_SECRET) return missingJobSecretConfigResponse(jsonHeaders);
  if (!jobSecretAuthorized(JOB_SECRET, readIncomingJobSecret(req.headers))) {
    return unauthorizedJobResponse(jsonHeaders);
  }
  const url = new URL(req.url);
  const slug = url.searchParams.get("job");
  if (!isJobSlug(slug)) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_or_invalid_job", allowed: Object.keys(JOB_NAMES) }),
      { status: 400, headers: jsonHeaders },
    );
  }
  const r = await runJob(slug, triggeredAt);
  return new Response(
    JSON.stringify({ ok: r.ok, job: JOB_NAMES[slug], slug, triggered_at: triggeredAt, ...r }),
    { status: r.ok ? 200 : (r.http_status && r.http_status >= 400 ? r.http_status : 502),
      headers: jsonHeaders },
  );
});
