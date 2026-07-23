// cron-padova-agency-enrich
// Wrapper cron: chiama padova-agency-enrich-run con x-job-secret e logga esito
// in cron_executions_log. Schedulato da pg_cron alle 06:10 UTC lun-sab.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const triggeredAt = new Date();
  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!secret || !base || !service) {
    return new Response(
      JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sb = createClient(base, service, { auth: { persistSession: false } });

  let body: Record<string, unknown> = {
    portals: ["casa", "immobiliare"],
    limit_per_portal: 10,
    recompute: true,
    only_missing: true,
    force_refresh: false,
  };
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
      body = { ...body, ...raw };
    }
  } catch { /* empty ok */ }

  let status: "success" | "failure" = "success";
  let httpStatus = 0;
  let responseText = "";
  let errorMsg: string | null = null;

  try {
    const r = await fetch(`${base}/functions/v1/padova-agency-enrich-run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": secret,
        "apikey": anon,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    httpStatus = r.status;
    responseText = await r.text();
    if (!r.ok) {
      status = "failure";
      errorMsg = `http_${r.status}`;
    }
  } catch (e) {
    status = "failure";
    errorMsg = (e as Error).message || "fetch_failed";
  }

  const completedAt = new Date();
  await sb.from("cron_executions_log").insert({
    job_name: "cron-padova-agency-enrich",
    status,
    triggered_at: triggeredAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.getTime() - triggeredAt.getTime(),
    http_status: httpStatus || null,
    error_message: errorMsg,
    response_excerpt: responseText ? responseText.slice(0, 2000) : null,
  });

  return new Response(
    JSON.stringify({ ok: status === "success", status, http_status: httpStatus, error: errorMsg }),
    { status: status === "success" ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
