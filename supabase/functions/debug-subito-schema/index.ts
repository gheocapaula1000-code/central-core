import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
Deno.serve(async () => {
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  const r = await fetch(`https://api.apify.com/v2/acts/emastra~subito-it-immobili?token=${token}`);
  const j = await r.json();
  const out: any = {
    name: j?.data?.name,
    username: j?.data?.username,
    title: j?.data?.title,
    stats: j?.data?.stats,
    exampleRunInput: j?.data?.exampleRunInput,
    defaultRunOptions: j?.data?.defaultRunOptions,
    inputSchema: j?.data?.inputSchema,
    versions: j?.data?.versions?.map((v: any) => ({ v: v.versionNumber, sourceType: v.sourceType, inputSchema: v.inputSchema?.slice?.(0, 2000) })),
  };
  return new Response(JSON.stringify(out, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
