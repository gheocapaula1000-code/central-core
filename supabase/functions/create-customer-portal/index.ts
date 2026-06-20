// ═══════════════════════════════════════════════════════════════
// AcquisitionRadar — Stripe Customer Portal
// POST /functions/v1/create-customer-portal
//
// Auth: per-app secret obbligatorio
//   • x-source-app: acquisitionradar
//   • x-internal-secret: AI_CORE_SECRET_ACQUISITIONRADAR
//
// Body o header server-side:
//   • workspace_id (body)  oppure  x-workspace-id (header)
//   • return_url (opzionale, default https://acquisitionradar.it/account)
//
// Lookup stripe_customer_id da billing_customers
// (agency_id = workspace_id, app_id = 'acquisitionradar').
// La tabella workspaces nel Core non ha owner_id — non usato.
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getStripeConfig, AR_DEFAULT_ACCOUNT_URL, isAllowedArUrl } from "../_shared/acquisitionradar-billing.ts";
import { makeDebugId, requireSecret } from "../_shared/http.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-source-app, x-workspace-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function corsHeaders(_req: Request) { return CORS; }

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function logEvent(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const fn = level === "error" ? console.error : console.log;
  try {
    fn(JSON.stringify({
      level, app: "AcquisitionRadar", endpoint: "/create-customer-portal",
      ts: new Date().toISOString(), ...fields,
    }));
  } catch { /* noop */ }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);

  const debugId = makeDebugId();

  const authFail = requireSecret(req, debugId);
  if (authFail) return authFail;

  // ── JWT utente obbligatorio ──
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    logEvent("warn", { debug_id: debugId, outcome: "missing_user_jwt" });
    return jsonRes({ error: "missing_user_jwt", message: "Missing user JWT" }, 401);
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    logEvent("warn", { debug_id: debugId, outcome: "invalid_user_jwt", msg: userErr?.message });
    return jsonRes({ error: "invalid_user_jwt", message: "Invalid user JWT" }, 401);
  }
  const userId = userData.user.id;

  const cfg = getStripeConfig();
  if (!cfg.configured || !cfg.secretKey) {
    logEvent("error", { debug_id: debugId, outcome: "billing_not_configured" });
    return jsonRes({ error: "billing_not_configured" }, 503);
  }
  const stripe = new Stripe(cfg.secretKey, { apiVersion: "2023-10-16" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json() ?? {}; } catch { /* noop */ }

  const headerWorkspace = (req.headers.get("x-workspace-id") ?? "").trim();
  const workspace_id    = headerWorkspace || String(body.workspace_id ?? "").trim();
  const return_url_in   = String(body.return_url ?? "").trim();
  const return_url      = isAllowedArUrl(return_url_in) ? return_url_in : AR_DEFAULT_ACCOUNT_URL;

  if (!workspace_id) {
    logEvent("warn", { debug_id: debugId, outcome: "missing_workspace_id" });
    return jsonRes({ error: "missing_workspace_id", message: "workspace_id obbligatorio (body o header x-workspace-id)" }, 400);
  }

  // ── Ownership/membership check: user must be active member of the agency ──
  try {
    const { data: member, error: memberErr } = await supabase
      .from("agency_memberships")
      .select("role, status")
      .eq("agency_id", workspace_id)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (memberErr) {
      logEvent("error", { debug_id: debugId, outcome: "membership_query_error", workspace_id, user_id: userId, msg: memberErr.message });
      return jsonRes({ error: "db_error" }, 500);
    }
    if (!member) {
      console.warn(`[customer-portal] forbidden user=${userId} workspace=${workspace_id}`);
      logEvent("warn", { debug_id: debugId, outcome: "forbidden_not_member", workspace_id, user_id: userId });
      return jsonRes({ error: "forbidden", message: "User is not a member of this workspace" }, 403);
    }
  } catch (e) {
    logEvent("error", { debug_id: debugId, outcome: "membership_exception", workspace_id, user_id: userId, msg: e instanceof Error ? e.message : "unknown" });
    return jsonRes({ error: "db_exception" }, 500);
  }


  // ── Lookup stripe_customer_id da billing_customers (acquisitionradar) ──
  let stripeCustomerId: string | null = null;
  try {
    const { data, error } = await supabase
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("agency_id", workspace_id)
      .eq("app_id", "acquisitionradar")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logEvent("error", { debug_id: debugId, outcome: "db_error", workspace_id, msg: error.message });
      return jsonRes({ error: "db_error" }, 500);
    }
    stripeCustomerId = (data?.stripe_customer_id as string | null) ?? null;
  } catch (e) {
    logEvent("error", { debug_id: debugId, outcome: "db_exception", workspace_id, msg: e instanceof Error ? e.message : "unknown" });
    return jsonRes({ error: "db_exception" }, 500);
  }

  if (!stripeCustomerId) {
    logEvent("warn", { debug_id: debugId, outcome: "no_stripe_customer", workspace_id });
    return jsonRes({
      error: "no_stripe_customer",
      message: "Nessun customer Stripe associato a questo workspace",
    }, 404);
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url,
    });
    logEvent("info", { debug_id: debugId, outcome: "ok", mode: cfg.mode, workspace_id });
    return jsonRes({ url: session.url });
  } catch (e) {
    logEvent("error", { debug_id: debugId, outcome: "stripe_error", mode: cfg.mode, workspace_id, msg: e instanceof Error ? e.message : "unknown" });
    return jsonRes({ error: "stripe_error" }, 502);
  }
});
