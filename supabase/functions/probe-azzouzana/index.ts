import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
Deno.serve(async (req) => {
  if (req.headers.get("x-job-secret") !== Deno.env.get("CENTRAL_CORE_JOB_SECRET"))
    return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const ds = url.searchParams.get("ds") ?? "";
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  const r = await fetch(`https://api.apify.com/v2/datasets/${ds}/items?token=${token}&clean=1&limit=3`);
  const raw = await r.json();
  const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
  const shapes = items.slice(0,3).map((it: any) => ({ keys: Object.keys(it), sample: it }));
  const meta = { rawType: Array.isArray(raw) ? "array" : typeof raw, topKeys: Array.isArray(raw) ? null : Object.keys(raw ?? {}), status: r.status };
  return new Response(JSON.stringify({ meta, shapes }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
