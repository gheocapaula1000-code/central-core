// civiko-scheduler
// Orchestrates F1–F22 automated / semi-automated ingestion.
// Auth: x-job-secret (or x-internal-secret) === CENTRAL_CORE_JOB_SECRET.
// pg_cron nightly-data-refresh-master POSTs /run-scheduled with due_only=true.
// Per-source failures write last_error on civiko_source_registry and never
// abort the remaining sources.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { constantTimeEqual } from "../_shared/http.ts";
import { PADOVA_CENTER } from "../_shared/sourceScheduler.ts";
import { runScheduledSources } from "../_shared/sourceJobs.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function resolveJobName(body: Record<string, unknown>): string {
  if (typeof body.job_name === "string" && body.job_name.trim()) return body.job_name.trim();
  if (body.triggered_by === "pg_cron_nightly_master") return "nightly-data-refresh-master";
  if (body.triggered_by === "pg_cron_scheduler_weekly") return "civiko-scheduler-weekly";
  if (body.triggered_by === "pg_cron_scheduler_daily") return "civiko-scheduler-daily";
  if (body.triggered_by === "github_actions") return "civiko-scheduler-gha";
  return "civiko-scheduler";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!expected) {
    return json({ ok: false, error: "CENTRAL_CORE_JOB_SECRET not configured" }, 500);
  }
  const incoming = req.headers.get("x-job-secret") ?? req.headers.get("x-internal-secret") ?? "";
  if (!incoming || !constantTimeEqual(incoming, expected)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const due_only = body.due_only === true || body.due_only === "true";
  const dry_run = body.dry_run === true;
  const source_code = typeof body.source_code === "string" ? body.source_code : undefined;
  const jobName = resolveJobName(body);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "Service role not configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: logRow } = await supabase
    .from("cron_executions_log")
    .insert({ job_name: jobName, status: "started" })
    .select("id")
    .maybeSingle();

  const started = Date.now();
  try {
    const result = await runScheduledSources(
      {
        supabase,
        baseUrl: `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`,
        jobSecret: expected,
        secrets: {
          AI_CORE_SECRET_CIVIKO: Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "",
          SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        },
        resolveCoords: async () => PADOVA_CENTER,
        attachEvidenceWriter: true,
      },
      { due_only, dry_run, source_code },
    );

    const failedSources = result.results.filter((r) => r.status === "failed");
    const error_message = failedSources.length
      ? failedSources.map((r) => `${r.source_code}:${r.error ?? "failed"}`).join("; ").slice(0, 4000)
      : null;
    const status = failedSources.length > 0 ? "failure" : "success";

    if (logRow?.id) {
      await supabase.from("cron_executions_log").update({
        status,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        error_message,
        response_excerpt: JSON.stringify(result.summary).slice(0, 4000),
        http_status: failedSources.length > 0 ? 207 : 200,
      }).eq("id", logRow.id);
    }

    return json({
      ok: failedSources.length === 0,
      job_name: jobName,
      ...result,
    }, failedSources.length > 0 ? 207 : 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (logRow?.id) {
      await supabase.from("cron_executions_log").update({
        status: "failure",
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        error_message: msg.slice(0, 4000),
        http_status: 500,
      }).eq("id", logRow.id);
    }
    return json({ ok: false, job_name: jobName, error: msg }, 500);
  }
});
