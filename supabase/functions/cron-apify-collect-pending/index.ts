// cron-apify-collect-pending
// Wrapper cron per padova-apify-collect-pending. Legge CENTRAL_CORE_JOB_SECRET
// dall'env e propaga la chiamata. Triggerato da pg_cron ogni 15 minuti oppure
// invocato manualmente.
//
// Body opzionale viene inoltrato pari pari a collect-pending. Se assente usa
// { stale_minutes: 5, max_runs: 20 }.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  if (!secret || !base) {
    return new Response(JSON.stringify({ ok: false, error: "config_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: any = { stale_minutes: 5, max_runs: 20 };
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = raw;
  } catch { /* empty ok */ }

  const r = await fetch(`${base}/functions/v1/padova-apify-collect-pending`, {
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
