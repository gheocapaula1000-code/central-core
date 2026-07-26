// cron-apify-casa-nightly
// Wrapper cron per padova-apify-casa-collect (async_start pattern).
// collect-pending completa l'ingest nei tick successivi.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  if (!secret || !base) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

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

  const r = await fetch(`${base}/functions/v1/padova-apify-casa-collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": secret,
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
