// Temporary diagnostic — calls refresh-padova-auctions internally with job secret.
// Protected by DIAGNOSTIC_SELFTEST_SECRET. Deletable after smoke test.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const provided = req.headers.get("x-diag-secret") ?? "";
  const expected = Deno.env.get("DIAGNOSTIC_SELFTEST_SECRET") ?? "";
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const body = await req.json().catch(() => ({}));
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  if (!jobSecret) {
    return new Response(JSON.stringify({ error: "no_job_secret" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/civiko-radar-veneto/jobs/refresh-padova-auctions`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": jobSecret,
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  return new Response(txt, { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
