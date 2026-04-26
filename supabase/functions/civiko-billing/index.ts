// ═══════════════════════════════════════════════════════════════
// Civiko One — Billing (Stripe orchestration)
//
// Sub-routes (all POST):
//   /civiko/billing/create-checkout
//   /civiko/billing/customer-portal
//   /civiko/billing/check-subscription
//   /civiko/billing/record-usage
//   /civiko/billing/stripe-webhook
//
// Stripe is OPTIONAL: if STRIPE_SECRET_KEY is missing, every route
// returns billingReady=false instead of failing. No Stripe secret
// or raw event ever leaks into responses or logs.
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import { sanitizeOutgoing, getServiceSupabase } from "../_shared/civiko.ts";
import {
  readStripeEnv, planFromPriceId, recordUsage, evaluateBillingGate,
  getActiveSubscription, getCurrentUsage, getEntitlements,
  CIVIKO_APP_ID, CIVIKO_PLANS, type CivikoPlanKey, type UsageType,
} from "../_shared/billing.ts";

const FUNCTION_NAME = "civiko-billing";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-billing";
const ROUTES = [
  "GET  /health",
  "GET  /manifest",
  "POST /civiko/billing/create-checkout",
  "POST /civiko/billing/customer-portal",
  "POST /civiko/billing/check-subscription",
  "POST /civiko/billing/record-usage",
  "POST /civiko/billing/stripe-webhook",
];

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ── Stripe minimal helpers (form-encoded REST, no SDK) ────────
async function stripeForm(secretKey: string, path: string, body: Record<string, string>) {
  const params = new URLSearchParams(body);
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* keep null */ }
  return { ok: res.ok, status: res.status, data: data as Record<string, unknown> | null };
}

function unconfiguredResponse(req: Request, debugId: string, route: string) {
  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: false,
    reason: "billing_not_configured",
    message: "Predisposizione presente: configurare le variabili Stripe per attivare i pagamenti.",
    plan: null, status: null,
    updatedAt: new Date().toISOString(),
  }), debugId), route);
}

// ── handlers ──────────────────────────────────────────────────

async function handleCreateCheckout(req: Request, body: Record<string, unknown>, debugId: string) {
  const env = readStripeEnv();
  if (!env.configured || !env.secretKey) return unconfiguredResponse(req, debugId, "create-checkout");

  const agencyId = String(body.agencyId ?? "");
  const planKey = String(body.planKey ?? "") as CivikoPlanKey;
  const interval = String(body.interval ?? "monthly");
  const successUrl = String(body.successUrl ?? "");
  const cancelUrl = String(body.cancelUrl ?? "");
  const email = body.email ? String(body.email) : null;

  if (!agencyId) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId is required.", debugId), "error");
  if (!CIVIKO_PLANS.includes(planKey)) return withIdentity(fail(req, 400, "INVALID_BODY", "planKey not recognized.", debugId), "error");
  if (!successUrl || !cancelUrl) return withIdentity(fail(req, 400, "INVALID_BODY", "successUrl and cancelUrl are required.", debugId), "error");

  const priceKey = `${planKey}_${interval}`;
  const priceId = env.prices[priceKey];
  if (!priceId) return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: false, reason: "price_not_configured",
    message: "Variante di abbonamento non configurata.",
  }), debugId), "create-checkout");

  // Reuse customer if exists
  const sb = getServiceSupabase();
  let stripeCustomerId: string | null = null;
  if (sb) {
    const { data } = await sb.from("billing_customers")
      .select("stripe_customer_id")
      .eq("agency_id", agencyId).eq("app_id", CIVIKO_APP_ID).maybeSingle();
    stripeCustomerId = data?.stripe_customer_id ?? null;
  }

  const form: Record<string, string> = {
    "mode": "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "success_url": successUrl,
    "cancel_url": cancelUrl,
    "client_reference_id": agencyId,
    "metadata[agency_id]": agencyId,
    "metadata[app_id]": CIVIKO_APP_ID,
    "metadata[plan_key]": planKey,
  };
  if (stripeCustomerId) form["customer"] = stripeCustomerId;
  else if (email) form["customer_email"] = email;

  const r = await stripeForm(env.secretKey, "checkout/sessions", form);
  if (!r.ok) {
    console.error(`[${FUNCTION_NAME}] checkout.create failed status=${r.status} debug_id=${debugId}`);
    return withIdentity(fail(req, 502, "STRIPE_ERROR", `Checkout non disponibile. Riferimento: ${debugId}`, debugId), "error");
  }
  const url = (r.data?.url as string) ?? null;
  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true, checkoutUrl: url, planKey, interval,
  }), debugId), "create-checkout");
}

async function handleCustomerPortal(req: Request, body: Record<string, unknown>, debugId: string) {
  const env = readStripeEnv();
  if (!env.configured || !env.secretKey) return unconfiguredResponse(req, debugId, "customer-portal");

  const agencyId = String(body.agencyId ?? "");
  const returnUrl = String(body.returnUrl ?? "");
  if (!agencyId || !returnUrl) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId and returnUrl are required.", debugId), "error");

  const sb = getServiceSupabase();
  if (!sb) return withIdentity(fail(req, 503, "STORAGE_UNAVAILABLE", "Backend not configured.", debugId), "error");
  const { data } = await sb.from("billing_customers")
    .select("stripe_customer_id")
    .eq("agency_id", agencyId).eq("app_id", CIVIKO_APP_ID).maybeSingle();
  if (!data?.stripe_customer_id) return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true, available: false, reason: "no_customer",
  }), debugId), "customer-portal");

  const r = await stripeForm(env.secretKey, "billing_portal/sessions", {
    customer: data.stripe_customer_id,
    return_url: returnUrl,
  });
  if (!r.ok) {
    console.error(`[${FUNCTION_NAME}] portal.create failed status=${r.status} debug_id=${debugId}`);
    return withIdentity(fail(req, 502, "STRIPE_ERROR", `Portale non disponibile. Riferimento: ${debugId}`, debugId), "error");
  }
  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true, portalUrl: (r.data?.url as string) ?? null,
  }), debugId), "customer-portal");
}

async function handleCheckSubscription(req: Request, body: Record<string, unknown>, debugId: string) {
  const env = readStripeEnv();
  const agencyId = String(body.agencyId ?? "");
  if (!agencyId) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId is required.", debugId), "error");

  if (!env.configured) return unconfiguredResponse(req, debugId, "check-subscription");

  const sb = getServiceSupabase();
  if (!sb) return unconfiguredResponse(req, debugId, "check-subscription");

  const sub = await getActiveSubscription(sb, agencyId);
  const usage = await getCurrentUsage(sb, agencyId);
  const ent = sub?.planKey ? await getEntitlements(sb, sub.planKey) : null;

  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true,
    plan: sub?.planKey ?? null,
    status: sub?.status ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    usage,
    limits: ent ? {
      monthly_scans: ent.monthly_scans ?? null,
      monthly_owner_reports: ent.monthly_owner_reports ?? null,
      monthly_piano_esclusiva: ent.monthly_piano_esclusiva ?? null,
      team_seats: ent.team_seats ?? null,
      allow_hyperlocal_signals: !!ent.allow_hyperlocal_signals,
      allow_local_buzz: !!ent.allow_local_buzz,
      allow_pdf_export: !!ent.allow_pdf_export,
      allow_white_label: !!ent.allow_white_label,
    } : null,
  }), debugId), "check-subscription");
}

async function handleRecordUsage(req: Request, body: Record<string, unknown>, debugId: string) {
  const agencyId = String(body.agencyId ?? "");
  const usageType = String(body.usageType ?? "") as UsageType;
  const validTypes: UsageType[] = ["scan", "owner_report", "piano_esclusiva", "zona_in_movimento", "hyperlocal_signals"];
  if (!agencyId) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId is required.", debugId), "error");
  if (!validTypes.includes(usageType)) return withIdentity(fail(req, 400, "INVALID_BODY", "usageType not recognized.", debugId), "error");

  const env = readStripeEnv();
  if (!env.configured) return unconfiguredResponse(req, debugId, "record-usage");

  const gate = await evaluateBillingGate(agencyId, usageType);
  if (!gate.allowed) {
    return withIdentity(json(req, 200, sanitizeOutgoing({
      billingReady: true, recorded: false, reason: gate.reason,
      upgradeRequired: gate.upgradeRequired, plan: gate.plan, usage: gate.usage, limits: gate.limits,
    }), debugId), "record-usage");
  }
  await recordUsage(agencyId, usageType, 1);
  const usage = await getCurrentUsage(getServiceSupabase()!, agencyId);
  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true, recorded: true, usage, plan: gate.plan,
  }), debugId), "record-usage");
}

// Stripe webhook signature verification (HMAC-SHA256, t=...,v1=...)
async function verifyStripeSignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => {
    const [k, v] = p.split("=");
    return [k.trim(), (v ?? "").trim()];
  }));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

async function handleStripeWebhook(req: Request, rawBody: string, debugId: string) {
  const env = readStripeEnv();
  if (!env.configured || !env.webhookSecret) {
    // Do not process without webhook secret — but acknowledge to avoid retries during predisposition.
    return withIdentity(json(req, 200, { received: true, processed: false, reason: "webhook_not_configured" }, debugId), "stripe-webhook");
  }
  const sig = req.headers.get("Stripe-Signature");
  const ok = await verifyStripeSignature(rawBody, sig, env.webhookSecret);
  if (!ok) return withIdentity(fail(req, 400, "INVALID_SIGNATURE", "Invalid signature.", debugId), "error");

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); }
  catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Invalid event payload.", debugId), "error"); }

  const sb = getServiceSupabase();
  if (!sb) return withIdentity(fail(req, 503, "STORAGE_UNAVAILABLE", "Backend not configured.", debugId), "error");

  const type = String(event.type ?? "");
  const obj = (event.data as { object?: Record<string, unknown> } | undefined)?.object ?? {};

  try {
    if (type === "checkout.session.completed") {
      const agencyId = String((obj.metadata as Record<string, string> | undefined)?.agency_id ?? (obj.client_reference_id ?? ""));
      const stripeCustomerId = String(obj.customer ?? "");
      const email = (obj.customer_details as Record<string, unknown> | undefined)?.email as string | undefined;
      if (agencyId && stripeCustomerId) {
        await sb.from("billing_customers").upsert({
          agency_id: agencyId,
          app_id: CIVIKO_APP_ID,
          stripe_customer_id: stripeCustomerId,
          email: email ?? null,
        }, { onConflict: "agency_id,app_id" });
      }
    } else if (type.startsWith("customer.subscription.")) {
      const stripeCustomerId = String(obj.customer ?? "");
      const stripeSubscriptionId = String(obj.id ?? "");
      const status = String(obj.status ?? "");
      const cancelAtPeriodEnd = !!obj.cancel_at_period_end;
      const currentPeriodEnd = obj.current_period_end ? new Date((obj.current_period_end as number) * 1000).toISOString() : null;
      const trialEnd = obj.trial_end ? new Date((obj.trial_end as number) * 1000).toISOString() : null;
      const items = (obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data ?? [];
      const priceId = items[0]?.price?.id ?? "";
      const planKey = priceId ? planFromPriceId(env, priceId) : null;

      // Resolve agency_id via customer
      const { data: cust } = await sb.from("billing_customers")
        .select("agency_id")
        .eq("stripe_customer_id", stripeCustomerId).maybeSingle();
      const agencyId = cust?.agency_id ?? null;
      if (agencyId && stripeSubscriptionId) {
        await sb.from("billing_subscriptions").upsert({
          agency_id: agencyId,
          app_id: CIVIKO_APP_ID,
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: stripeSubscriptionId,
          status,
          plan_key: planKey,
          price_id: priceId || null,
          current_period_end: currentPeriodEnd,
          trial_end: trialEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
        }, { onConflict: "stripe_subscription_id" });
      }
    }
    return withIdentity(json(req, 200, { received: true, processed: true }, debugId), "stripe-webhook");
  } catch (e) {
    console.error(`[${FUNCTION_NAME}] webhook handler error debug_id=${debugId}: ${e instanceof Error ? e.message : String(e)}`);
    return withIdentity(json(req, 200, { received: true, processed: false }, debugId), "stripe-webhook");
  }
}

// ── server ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "GET") {
      if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
        return withIdentity(json(req, 200, {
          status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION,
          contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString(),
          billingReady: readStripeEnv().configured,
        }, debugId), "health");
      }
      if (pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({
          functionName: FUNCTION_NAME, serviceKind: "civiko-billing",
          expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct",
        }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname}`, debugId), "error");
    }

    if (req.method !== "POST") return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");

    // Webhook needs raw body (no JSON parse before signature verification)
    if (pathname.endsWith("/stripe-webhook")) {
      const raw = await req.text();
      return await handleStripeWebhook(req, raw, debugId);
    }

    let body: Record<string, unknown> = {};
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }

    if (pathname.endsWith("/create-checkout")) return await handleCreateCheckout(req, body, debugId);
    if (pathname.endsWith("/customer-portal")) return await handleCustomerPortal(req, body, debugId);
    if (pathname.endsWith("/check-subscription")) return await handleCheckSubscription(req, body, debugId);
    if (pathname.endsWith("/record-usage")) return await handleRecordUsage(req, body, debugId);

    return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `POST ${pathname}`, debugId), "error");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, {
      error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` },
      debug_id: debugId,
    }, debugId), "error");
  }
});
