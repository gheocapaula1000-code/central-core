// Temporary runner: invokes padova-bootstrap-cycle server-side using DIAGNOSTIC_SECRET from env.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const diagSecret = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") +
    "/functions/v1/padova-bootstrap-cycle";

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-diagnostic-secret": diagSecret,
        "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      },
      body: JSON.stringify({ city: "Padova", full: true }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* keep text */ }
    return new Response(JSON.stringify({
      upstream_status: res.status,
      duration_ms: Date.now() - started,
      diagnostic_secret_present: diagSecret.length > 0,
      target_url: url,
      response: data,
    }, null, 2), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - started,
      diagnostic_secret_present: diagSecret.length > 0,
      target_url: url,
    }, null, 2), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
