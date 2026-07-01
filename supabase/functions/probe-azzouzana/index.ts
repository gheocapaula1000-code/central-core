import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
Deno.serve(async (req) => {
  if (req.headers.get("x-job-secret") !== Deno.env.get("CENTRAL_CORE_JOB_SECRET"))
    return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const ds = url.searchParams.get("ds") ?? "";
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  const r = await fetch(`https://api.apify.com/v2/datasets/${ds}/items?token=${token}&clean=1&limit=3`);
  const items = await r.json();
  const shapes = items.map((it: any) => ({ keys: Object.keys(it), sample: it }));
  return new Response(JSON.stringify(shapes, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
