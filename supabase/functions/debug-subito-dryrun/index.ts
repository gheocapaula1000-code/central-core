// debug-subito-dryrun — diagnostica interna.
// Checkpoint 1A: protetta fail-closed da DIAGNOSTIC_SECRET (x-diagnostic-secret).
// Nessuna lettura di token/secret e nessuna fetch prima della guardia.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { requireDiagnosticSecret, makeDebugId } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authFail = requireDiagnosticSecret(req, makeDebugId());
  if (authFail) return authFail;

  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL")!;
  const r = await fetch(`${base}/functions/v1/padova-apify-subito-collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": secret,
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
    },
    body: JSON.stringify({ dry_run: true, max_items: 20, search_urls: ["https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/"] }),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
