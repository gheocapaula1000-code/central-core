// padova-apify-kickoff
// Wrapper admin-only: prende il body, aggiunge x-job-secret dall'env e
// inoltra a padova-apify-launch o padova-apify-status.
// Auth: JWT utente (auto-injected dal preview Lovable) + has_role admin.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "missing_jwt" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const sbUser = createClient(sbUrl, anon, { global: { headers: { Authorization: auth } } });
  const { data: u } = await sbUser.auth.getUser();
  if (!u?.user) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_jwt" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const svc = createClient(sbUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } });
  const { data: roles } = await svc.from("user_roles").select("role").eq("user_id", u.user.id);
  const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin");
  if (!isAdmin) {
    return new Response(JSON.stringify({ ok: false, error: "not_admin" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const url = new URL(req.url);
  const target = url.searchParams.get("target") ?? "launch"; // launch | status
  const fnName = target === "status" ? "padova-apify-multi-status" : "padova-apify-multi-launch";
  const body = await req.text();

  const r = await fetch(`${sbUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-job-secret": jobSecret,
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: body || "{}",
  });
  const txt = await r.text();
  return new Response(txt, {
    status: r.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
