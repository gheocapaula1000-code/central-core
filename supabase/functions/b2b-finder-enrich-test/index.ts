import { createClient as _c } from "https://esm.sh/@supabase/supabase-js@2.49.4";
Deno.serve(async (req) => {
  const body = await req.text();
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/b2b-finder-enrich`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-source-app": "b2b-finder",
      "x-internal-secret": Deno.env.get("B2B_FINDER_SECRET") ?? "",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body,
  });
  return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
});
