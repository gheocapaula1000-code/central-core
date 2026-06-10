// padova-apify-peek
// Lettura diretta stato run Apify per debug (admin-only).
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return new Response("unauth", { status: 401, headers: corsHeaders });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } });
  const { data: u } = await sb.auth.getUser();
  if (!u?.user) return new Response("invalid jwt", { status: 401, headers: corsHeaders });
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } });
  const { data: roles } = await svc.from("user_roles").select("role").eq("user_id", u.user.id);
  if (!(roles ?? []).some((r: { role: string }) => r.role === "admin"))
    return new Response("not admin", { status: 403, headers: corsHeaders });

  const url = new URL(req.url);
  const runId = url.searchParams.get("run_id") ?? "";
  const token = getApifyToken();
  const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  const j = await r.json();
  const d = j?.data ?? {};
  return new Response(JSON.stringify({
    id: d.id, status: d.status, startedAt: d.startedAt, finishedAt: d.finishedAt,
    usageTotalUsd: d.usageTotalUsd, stats: d.stats, meta: d.meta,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
