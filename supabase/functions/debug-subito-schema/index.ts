// debug-subito-schema — diagnostica interna.
// Checkpoint 1A: protetta fail-closed da DIAGNOSTIC_SECRET (x-diagnostic-secret).
// Il token Apify non viene letto e nessuna fetch viene eseguita prima della guardia.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { requireDiagnosticSecret, makeDebugId } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authFail = requireDiagnosticSecret(req, makeDebugId());
  if (authFail) return authFail;

  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  const r = await fetch(`https://api.apify.com/v2/acts/emastra~subito-it-immobili?token=${token}`);
  const j = await r.json();
  const out: Record<string, unknown> = {
    name: j?.data?.name,
    username: j?.data?.username,
    title: j?.data?.title,
    stats: j?.data?.stats,
    exampleRunInput: j?.data?.exampleRunInput,
    defaultRunOptions: j?.data?.defaultRunOptions,
    inputSchema: j?.data?.inputSchema,
    // deno-lint-ignore no-explicit-any
    versions: j?.data?.versions?.map?.((v: any) => ({ v: v.versionNumber, sourceType: v.sourceType, inputSchema: v.inputSchema?.slice?.(0, 2000) })),
  };
  return new Response(JSON.stringify(out, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
