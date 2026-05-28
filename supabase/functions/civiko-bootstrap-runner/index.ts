// Temporary runner: forwards a single civiko-radar-veneto job call in background,
// logging the upstream JSON response to edge_function_logs.
//
// POST body: { route: "/jobs/...", ...payload }
// The "route" is appended to /functions/v1/civiko-radar-veneto and the rest
// of the body is forwarded as JSON payload.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const route = typeof body.route === "string" ? body.route : "";
  if (!route.startsWith("/jobs/")) {
    return new Response(JSON.stringify({ error: "missing or invalid 'route' (must start with /jobs/)" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { route: _drop, ...payload } = body;

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const url = base + "/functions/v1/civiko-radar-veneto" + route;
  const tag = route.replace(/^\/jobs\//, "");

  const task = (async () => {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-job-secret": jobSecret,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      console.log(`[JOB_RESULT ${tag}] status=${res.status} duration_ms=${Date.now() - started} length=${text.length}`);
      const chunk = 1400;
      for (let i = 0; i < text.length; i += chunk) {
        console.log(`[JOB_BODY ${tag} ${i}] ${text.slice(i, i + chunk)}`);
      }
      console.log(`[JOB_END ${tag}]`);
    } catch (e) {
      console.error(`[JOB_ERROR ${tag}] ${e instanceof Error ? e.message : String(e)} after ${Date.now() - started}ms`);
    }
  })();

  // @ts-ignore EdgeRuntime is available in Deno Deploy
  const ert = (globalThis as any).EdgeRuntime;
  if (ert?.waitUntil) ert.waitUntil(task); else task.catch(() => {});

  return new Response(JSON.stringify({
    accepted: true,
    job: tag,
    target_url: url,
    job_secret_present: jobSecret.length > 0,
    started_at: new Date().toISOString(),
    note: "Tail civiko-bootstrap-runner logs and grep [JOB_RESULT]/[JOB_BODY]/[JOB_END]/[JOB_ERROR] for tag=" + tag,
  }, null, 2), {
    status: 202,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
