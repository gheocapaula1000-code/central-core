// padova-apify-kickoff
// Cron + admin wrapper: forwards to padova-apify-multi-launch or
// padova-apify-multi-status after injecting the job secret from env.
//
// Auth Path A (cron / orchestrator): x-job-secret | x-internal-secret |
//   Authorization: Bearer <CENTRAL_CORE_JOB_SECRET>
// Auth Path B (Lovable admin preview): user JWT + has_role admin.
//
// Empty launch body is filled with the default Padova portal plan so
// pg_cron can start scrapes without inventing a payload.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isJobSecretAuthorized, jobAuthFailure, jobAuthHeaders } from "../_shared/jobAuth.ts";
import { defaultMultiLaunchBody, isEmptyLaunchBody } from "../_shared/padovaPortalLaunch.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAdminJwt(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  if (!token || !token.startsWith("eyJ")) return false;

  const sbUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!sbUrl || !anon || !service) return false;

  const sbUser = createClient(sbUrl, anon, { global: { headers: { Authorization: auth } } });
  const { data: u } = await sbUser.auth.getUser();
  if (!u?.user) return false;
  const svc = createClient(sbUrl, service, { auth: { persistSession: false } });
  const { data: roles } = await svc.from("user_roles").select("role").eq("user_id", u.user.id);
  return (roles ?? []).some((r: { role: string }) => r.role === "admin");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret) {
    const auth = jobAuthFailure(false);
    return json({ ok: false, error: auth.error }, auth.status);
  }

  const jobOk = isJobSecretAuthorized(req.headers, jobSecret);
  if (!jobOk) {
    const adminOk = await isAdminJwt(req);
    if (!adminOk) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }

  const sbUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!sbUrl || !service) {
    return json({ ok: false, error: "config_missing" }, 500);
  }

  const url = new URL(req.url);
  const target = url.searchParams.get("target") ?? "launch";
  const fnName = target === "status" ? "padova-apify-multi-status" : "padova-apify-multi-launch";
  const raw = await req.text();
  let bodyText = raw && raw.trim().length > 0 ? raw : "{}";
  if (fnName === "padova-apify-multi-launch") {
    let parsed: unknown = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
    if (isEmptyLaunchBody(parsed)) {
      bodyText = JSON.stringify(defaultMultiLaunchBody());
    }
  }

  const r = await fetch(`${sbUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      ...jobAuthHeaders(jobSecret),
      Authorization: `Bearer ${service}`,
    },
    body: bodyText,
  });
  const txt = await r.text();
  return new Response(txt, {
    status: r.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
