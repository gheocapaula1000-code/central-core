import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
Deno.serve(async (req) => {
  if (req.headers.get("x-job-secret") !== Deno.env.get("CENTRAL_CORE_JOB_SECRET"))
    return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const runId = url.searchParams.get("run") ?? "";
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  const rr = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
  const rj = await rr.json();
  const ds = rj?.data?.defaultDatasetId;
  const dr = await fetch(`https://api.apify.com/v2/datasets/${ds}/items?token=${token}&clean=1&limit=3`);
  const raw = await dr.json();
  const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
  const shapes = items.slice(0,3).map((it: any) => ({ keys: Object.keys(it), sample: it }));
  return new Response(JSON.stringify({ ds, drStatus: dr.status, shapes }, null, 2),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
