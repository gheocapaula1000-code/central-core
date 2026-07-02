// debug-subito-dryrun — one-shot: invoca padova-apify-subito-collect in dry_run
// leggendo CENTRAL_CORE_JOB_SECRET da env. Da rimuovere dopo l'audit.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async () => {
  const secret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const base = Deno.env.get("SUPABASE_URL")!;
  const r = await fetch(`${base}/functions/v1/padova-apify-subito-collect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": secret,
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
    },
    body: JSON.stringify({ dry_run: true, max_items: 10 }),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
