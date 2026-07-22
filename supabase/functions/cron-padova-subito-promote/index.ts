// cron-padova-subito-promote
// Wrapper cron per la promotion staging Subito → padova_collect_v2_items.
// Chiama la SQL function public.process_padova_subito_staging(since_hours, max_rows)
// e logga esito in cron_executions_log.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET.
// Payload: { since_hours?: number, max_rows?: number }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const started = new Date();
  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!secret || req.headers.get("x-job-secret") !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!url || !srk) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { since_hours?: number; max_rows?: number } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const since = Math.max(1, Math.min(Number(body.since_hours ?? 48), 168));
  const max = Math.max(1, Math.min(Number(body.max_rows ?? 1000), 5000));

  const sb = createClient(url, srk, { auth: { persistSession: false } });

  let result: any = null;
  let status: "success" | "failure" = "success";
  let errMsg: string | null = null;

  try {
    const { data, error } = await sb.rpc("process_padova_subito_staging", {
      p_since_hours: since,
      p_max_rows: max,
    });
    if (error) throw new Error(error.message);
    result = data;
  } catch (e) {
    status = "failure";
    errMsg = String((e as Error)?.message ?? e);
  }

  const finished = new Date();
  const excerpt = JSON.stringify(result ?? { error: errMsg }).slice(0, 900);
  await sb.from("cron_executions_log").insert({
    job_name: "central-core-padova-subito-promote",
    status,
    triggered_at: started.toISOString(),
    completed_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    http_status: status === "success" ? 200 : 500,
    response_excerpt: excerpt,
    error_message: errMsg,
  });

  return new Response(
    JSON.stringify({ ok: status === "success", result, error: errMsg }, null, 2),
    { status: status === "success" ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
