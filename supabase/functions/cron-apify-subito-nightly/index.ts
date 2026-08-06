// cron-apify-subito-nightly
// Wrapper cron per padova-apify-subito-collect (async_start pattern).
// Triggerato da pg_cron 03:14 UTC. collect-pending completa l'ingest nei tick successivi.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  if (!secret || !base) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Gate: incoming caller must present the shared job secret before we touch
  // body parsing or forward to the collector.
  const incoming = req.headers.get("x-job-secret") ?? "";
  if (incoming !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: any = { async_start: true, max_items: 300 };
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = { async_start: true, max_items: 300, ...raw };
  } catch { /* empty ok */ }


  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  let r: Response;
  try {
    r = await fetch(`${base}/functions/v1/padova-apify-subito-collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": secret,
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timeout = error instanceof Error && error.name === "AbortError";
    return new Response(JSON.stringify({ ok: false, error: timeout ? "timeout" : "network_error" }), {
      status: timeout ? 504 : 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  clearTimeout(timer);
  const text = await r.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = text ? JSON.parse(text) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
  } catch { /* invalid JSON = failure */ }
  const hasRun = typeof parsed?.run_id === "string" && parsed.run_id.length > 0;
  const skipped = parsed?.skipped === true ||
    (typeof parsed?.skipped === "string" && parsed.skipped.trim() !== "");
  const semanticOk = r.ok && parsed?.ok !== false && !parsed?.error &&
    !skipped && hasRun;
  return new Response(JSON.stringify({
    ok: semanticOk,
    http_status: r.status,
    started_count: hasRun ? 1 : 0,
    result: parsed,
  }), {
    status: semanticOk ? 200 : (r.ok ? 502 : r.status),
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
