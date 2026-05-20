// ═══════════════════════════════════════════════════════════════
// AcquisitionRadar — Stripe Checkout (live-ready)
// POST /functions/v1/create-checkout
//
// Auth: per-app secret obbligatorio
//   • x-source-app: acquisitionradar
//   • x-internal-secret: AI_CORE_SECRET_ACQUISITIONRADAR
//
// Body atteso (tutti string a meno di noto):
//   price_id, workspace_id, user_id, user_email,
//   plan, billing_interval, app, success_url, cancel_url
//
// Vincoli MVP Padova Comune:
//   • workspace_id obbligatorio
//   • price_id deve essere allowlistato via env (AR_STRIPE_PRICE_*)
//   • success_url/cancel_url solo su acquisitionradar.it/.app (https)
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import {
  getStripeConfig,
  resolveArPrice,
  isAllowedArUrl,
  AR_DEFAULT_CHECKOUT_OK,
  AR_DEFAULT_CHECKOUT_KO,
} from "../_shared/acquisitionradar-billing.ts";
import { makeDebugId, requireSecret } from "../_shared/http.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-source-app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
      level, app: "AcquisitionRadar", endpoint: "/create-checkout",
      ts: new Date().toISOString(), ...fields,
    }));
  } catch { /* noop */ }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);

  const debugId = makeDebugId();

  // ── Auth: per-app secret obbligatorio ──
  const authFail = requireSecret(req, debugId);
  if (authFail) return authFail;

  // ── Stripe config ──
  const cfg = getStripeConfig();
  if (!cfg.configured || !cfg.secretKey) {
    logEvent("error", { debug_id: debugId, outcome: "billing_not_configured" });
    return jsonRes({ error: "billing_not_configured" }, 503);
  }
  const stripe = new Stripe(cfg.secretKey, { apiVersion: "2023-10-16" });

  // ── Body ──
  let body: Record<string, unknown> = {};
  try { body = await req.json() ?? {}; } catch { /* noop */ }

  const price_id        = String(body.price_id ?? "").trim();
  const workspace_id    = String(body.workspace_id ?? "").trim();
  const user_id         = String(body.user_id ?? "").trim();
  const user_email      = String(body.user_email ?? body.email ?? "").trim();
  const planFromClient  = String(body.plan ?? "").trim();
  const billing_interval= String(body.billing_interval ?? "").trim().toLowerCase();
  const app             = String(body.app ?? "acquisitionradar").trim().toLowerCase();
  const success_url_in  = String(body.success_url ?? "").trim();
  const cancel_url_in   = String(body.cancel_url ?? "").trim();

  // ── Validazioni ──
  if (!workspace_id) {
    logEvent("warn", { debug_id: debugId, outcome: "missing_workspace_id" });
    return jsonRes({ error: "missing_workspace_id", message: "workspace_id è obbligatorio" }, 400);
  }
  if (!price_id) {
    logEvent("warn", { debug_id: debugId, outcome: "missing_price_id", workspace_id });
    return jsonRes({ error: "missing_price_id" }, 400);
  }

  const resolved = resolveArPrice(price_id);
  if (!resolved) {
    logEvent("warn", { debug_id: debugId, outcome: "price_not_allowed", workspace_id });
    return jsonRes({ error: "price_not_allowed", message: "price_id non consentito per Acquisition Radar" }, 400);
  }

  if (billing_interval && billing_interval !== resolved.interval) {
    logEvent("warn", {
      debug_id: debugId, outcome: "interval_mismatch", workspace_id,
      claimed: billing_interval, actual: resolved.interval,
    });
    return jsonRes({ error: "interval_mismatch", message: "billing_interval non coerente con il price_id" }, 400);
  }

  if (planFromClient && planFromClient !== resolved.plan) {
    logEvent("warn", { debug_id: debugId, outcome: "plan_mismatch", workspace_id });
    return jsonRes({ error: "plan_mismatch", message: "plan non coerente con il price_id" }, 400);
  }

  if (app !== "acquisitionradar") {
    return jsonRes({ error: "app_not_allowed" }, 400);
  }

  const success_url = isAllowedArUrl(success_url_in) ? success_url_in : AR_DEFAULT_CHECKOUT_OK;
  const cancel_url  = isAllowedArUrl(cancel_url_in)  ? cancel_url_in  : AR_DEFAULT_CHECKOUT_KO;

  const metadata = {
    workspace_id,
    user_id,
    plan: resolved.plan,
    billing_interval: resolved.interval,
    app: "acquisitionradar",
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: user_email || undefined,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url,
      cancel_url,
      metadata,
      subscription_data: { metadata },
      allow_promotion_codes: true,
    });
    logEvent("info", {
      debug_id: debugId, outcome: "ok", mode: cfg.mode, workspace_id,
      interval: resolved.interval, plan: resolved.plan,
    });
    return jsonRes({ url: session.url, session_id: session.id });
  } catch (e) {
    logEvent("error", {
      debug_id: debugId, outcome: "stripe_error", mode: cfg.mode, workspace_id,
      msg: e instanceof Error ? e.message : "unknown",
    });
    return jsonRes({ error: "stripe_error" }, 502);
  }
});
