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
  buildManifest, enforceOriginPolicy, requireSecret, extractVerifiedEmail,
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
  "GET  /subscription",
  "POST /checkout",
  "POST /portal",
  "POST /civiko/billing/create-checkout",
  "POST /civiko/billing/customer-portal",
  "POST /civiko/billing/check-subscription",
  "POST /civiko/billing/record-usage",
  "POST /civiko/billing/stripe-webhook",
  "POST /create-checkout-direct",
  "POST /create-portal-session",
];

// ── /create-portal-session ───────────────────────────────────
// Civiko One — Stripe Billing Portal session, keyed by supabase_user_id.
// Auth: same as /create-checkout-direct.
async function handleCreatePortalSession(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
): Promise<Response> {
  const route = "create-portal-session";
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!secretKey) {
    return withIdentity(fail(req, 503, "BILLING_NOT_CONFIGURED", "Stripe non configurato sul Core.", debugId), route);
  }

  const supabaseUserId = String(body.supabase_user_id ?? "").trim();
  const returnUrl = String(body.return_url ?? "").trim();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuidRe.test(supabaseUserId)) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "supabase_user_id non è un UUID valido.", debugId), route);
  }
  if (!returnUrl || !/^https?:\/\//i.test(returnUrl)) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "return_url non valido.", debugId), route);
  }

  // 1) Try DB lookup (billing_customers / billing_subscriptions metadata)
  let customerId: string | null = null;
  const sb = getServiceSupabase();
  if (sb) {
    try {
      const { data: bc } = await sb
        .from("billing_customers")
        .select("stripe_customer_id, metadata")
        .contains("metadata", { supabase_user_id: supabaseUserId, app: "civiko" })
        .limit(1)
        .maybeSingle();
      if (bc?.stripe_customer_id) customerId = String(bc.stripe_customer_id);
    } catch (_) { /* ignore */ }

    if (!customerId) {
      try {
        const { data: bs } = await sb
          .from("billing_subscriptions")
          .select("stripe_customer_id, metadata")
          .contains("metadata", { supabase_user_id: supabaseUserId, app: "civiko" })
          .limit(1)
          .maybeSingle();
        if (bs?.stripe_customer_id) customerId = String(bs.stripe_customer_id);
      } catch (_) { /* ignore */ }
    }
  }

  // 2) Fallback: stripe.customers.search
  if (!customerId) {
    try {
      const q = encodeURIComponent(`metadata['supabase_user_id']:'${supabaseUserId}' AND metadata['app']:'civiko'`);
      const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, {
        headers: { "Authorization": `Bearer ${secretKey}` },
      });
      if (searchRes.ok) {
        const sr = await searchRes.json() as { data?: Array<{ id?: string }> };
        customerId = sr.data?.[0]?.id ?? null;
      } else {
        const t = await searchRes.text();
        console.warn(`[${FUNCTION_NAME}] portal customers/search failed status=${searchRes.status} body=${t.slice(0, 200)} debug_id=${debugId}`);
      }
    } catch (e) {
      console.warn(`[${FUNCTION_NAME}] portal customers/search exception debug_id=${debugId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!customerId) {
    return withIdentity(fail(req, 404, "CUSTOMER_NOT_FOUND", "Nessun customer Stripe trovato", debugId), route);
  }

  // 3) Create portal session
  const r = await stripeForm(secretKey, "billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
    locale: "it",
  });
  if (!r.ok || !r.data?.url) {
    console.error(`[${FUNCTION_NAME}] billing_portal.sessions.create failed status=${r.status} debug_id=${debugId}`);
    return withIdentity(fail(req, 502, "STRIPE_ERROR", `Portal non disponibile. Riferimento: ${debugId}`, debugId), route);
  }

  return withIdentity(json(req, 200, { ok: true, url: String(r.data.url) }, debugId), route);
}

// ── /create-checkout-direct ───────────────────────────────────
// Civiko One — direct Stripe Checkout for the consumer plan
// (monthly/yearly), keyed by supabase_user_id (NOT agency_id).
// Auth: x-source-app: civiko + (x-internal-secret | x-job-secret) = AI_CORE_SECRET_CIVIKO
async function handleCreateCheckoutDirect(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
): Promise<Response> {
  const route = "create-checkout-direct";
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!secretKey) {
    return withIdentity(fail(req, 503, "BILLING_NOT_CONFIGURED", "Stripe non configurato sul Core.", debugId), route);
  }

  const plan = String(body.plan ?? "").trim().toLowerCase();
  const supabaseUserId = String(body.supabase_user_id ?? "").trim();
  const email = String(body.email ?? "").trim();
  const workspaceId = String(body.workspace_id ?? "").trim();
  const successUrl = String(body.success_url ?? "").trim();
  const cancelUrl = String(body.cancel_url ?? "").trim();

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (plan !== "monthly" && plan !== "yearly") {
    return withIdentity(fail(req, 400, "INVALID_BODY", "plan deve essere 'monthly' o 'yearly'.", debugId), route);
  }
  if (!uuidRe.test(supabaseUserId)) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "supabase_user_id non è un UUID valido.", debugId), route);
  }
  if (!uuidRe.test(workspaceId)) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "workspace_id non è un UUID valido.", debugId), route);
  }
  if (!emailRe.test(email)) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "email non valida.", debugId), route);
  }
  if (!successUrl || !cancelUrl) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "success_url e cancel_url sono obbligatori.", debugId), route);
  }

  const priceId = plan === "monthly"
    ? (Deno.env.get("STRIPE_PRICE_CIVIKO_MONTHLY") ?? "")
    : (Deno.env.get("STRIPE_PRICE_CIVIKO_YEARLY") ?? "");
  if (!priceId) {
    return withIdentity(fail(req, 503, "PRICE_NOT_CONFIGURED", `Price Stripe per piano ${plan} non configurato.`, debugId), route);
  }

  // 1) Find existing customer by metadata.supabase_user_id (Stripe search)
  let customerId: string | null = null;
  try {
    const q = encodeURIComponent(`metadata['supabase_user_id']:'${supabaseUserId}'`);
    const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, {
      headers: { "Authorization": `Bearer ${secretKey}` },
    });
    if (searchRes.ok) {
      const sr = await searchRes.json() as { data?: Array<{ id?: string }> };
      customerId = sr.data?.[0]?.id ?? null;
    } else {
      const t = await searchRes.text();
      console.warn(`[${FUNCTION_NAME}] customers/search failed status=${searchRes.status} body=${t.slice(0, 200)} debug_id=${debugId}`);
    }
  } catch (e) {
    console.warn(`[${FUNCTION_NAME}] customers/search exception debug_id=${debugId}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Create customer if missing
  if (!customerId) {
    const r = await stripeForm(secretKey, "customers", {
      email,
      "metadata[supabase_user_id]": supabaseUserId,
      "metadata[workspace_id]": workspaceId,
      "metadata[app]": "civiko",
    });
    if (!r.ok || !r.data?.id) {
      console.error(`[${FUNCTION_NAME}] customers.create failed status=${r.status} debug_id=${debugId}`);
      return withIdentity(fail(req, 502, "STRIPE_ERROR", `Creazione customer fallita. Riferimento: ${debugId}`, debugId), route);
    }
    customerId = String(r.data.id);
  }

  // 3) Create Checkout Session
  const form: Record<string, string> = {
    "mode": "subscription",
    "customer": customerId,
    "customer_update[name]": "auto",
    "customer_update[address]": "auto",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "success_url": successUrl,
    "cancel_url": cancelUrl,
    "locale": "it",
    "allow_promotion_codes": "true",
    "billing_address_collection": "required",
    "tax_id_collection[enabled]": "true",
    "subscription_data[metadata][supabase_user_id]": supabaseUserId,
    "subscription_data[metadata][workspace_id]": workspaceId,
    "subscription_data[metadata][app]": "civiko",
    "subscription_data[metadata][plan]": plan,
    "metadata[supabase_user_id]": supabaseUserId,
    "metadata[workspace_id]": workspaceId,
    "metadata[app]": "civiko",
    "metadata[plan]": plan,
  };
  const r = await stripeForm(secretKey, "checkout/sessions", form);
  if (!r.ok || !r.data?.url) {
    const stripeMsg = (r.data as { error?: { message?: string } } | null)?.error?.message ?? null;
    const detailSuffix = stripeMsg ? ` Dettaglio: ${stripeMsg}` : "";
    return withIdentity(fail(req, 502, "STRIPE_ERROR", `Checkout non disponibile. Riferimento: ${debugId}.${detailSuffix}`, debugId), route);
  }

  return withIdentity(json(req, 200, {
    ok: true,
    url: String(r.data.url),
    session_id: String(r.data.id ?? ""),
  }, debugId), route);
}

// Lightweight auth for /create-checkout-direct:
// accepts x-internal-secret OR x-job-secret matched against AI_CORE_SECRET_CIVIKO.
function authCheckoutDirect(req: Request, debugId: string): Response | null {
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();
  if (sourceApp !== "civiko") {
    return fail(req, 401, "APP_SECRET_REQUIRED", "x-source-app: civiko richiesto", debugId);
  }
  const expected = Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "";
  if (!expected) {
    return fail(req, 500, "CONFIG_ERROR", "AI_CORE_SECRET_CIVIKO non configurato", debugId);
  }
  const incoming = (
    req.headers.get("x-internal-secret") ??
    req.headers.get("x-job-secret") ??
    req.headers.get("x-app-secret") ??
    ""
  ).trim();
  if (!incoming) return fail(req, 401, "APP_SECRET_REQUIRED", "Missing x-internal-secret / x-job-secret", debugId);
  // constant-time compare
  if (incoming.length !== expected.length) return fail(req, 401, "APP_SECRET_REJECTED", "Invalid secret", debugId);
  let diff = 0;
  for (let i = 0; i < incoming.length; i++) diff |= incoming.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return fail(req, 401, "APP_SECRET_REJECTED", "Invalid secret", debugId);
  return null;
}

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ── Dual-mode auth: accept either a valid Supabase JWT or app-secret.
// Returns { userId, email } when authenticated via JWT, or {} when via secret.
// Returns a Response on rejection.
async function authenticateDual(
  req: Request,
  debugId: string,
): Promise<{ ok: true; userId: string | null; email: string | null } | { ok: false; res: Response }> {
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const looksLikeJwt = bearer.startsWith("eyJ");

  // Try JWT first when the Bearer token is shaped like a JWT
  if (looksLikeJwt) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sb = createClient(supabaseUrl, supabaseKey);
        const { data: { user }, error } = await sb.auth.getUser(bearer);
        if (!error && user?.id) {
          return { ok: true, userId: user.id, email: user.email ?? null };
        }
      } catch (_) { /* fall through to app-secret */ }
    }
  }

  // Fall back to app-secret (legacy proxy pattern)
  const secretRes = requireSecret(req, debugId);
  if (secretRes) return { ok: false, res: withIdentity(secretRes, "auth-rejected") };
  return { ok: true, userId: null, email: null };
}

// ── Resolve agencyId from JWT user + optional body.agencyId.
// Rules:
//  - JWT user + body.agencyId → must be an active membership, else 403.
//  - JWT user + no body.agencyId → unique active membership, else 400/403.
//  - No JWT user (app-secret path) → body.agencyId is mandatory (400).
// Returns the resolved agencyId or a Response on rejection.
async function resolveAgencyForBilling(
  req: Request,
  debugId: string,
  userId: string | null,
  providedAgencyId: string,
): Promise<{ ok: true; agencyId: string } | { ok: false; res: Response }> {
  // App-secret path (no end-user) — legacy behaviour: client must pass agencyId.
  if (!userId) {
    if (!providedAgencyId) {
      return { ok: false, res: withIdentity(fail(req, 400, "INVALID_BODY", "agencyId is required.", debugId), "error") };
    }
    return { ok: true, agencyId: providedAgencyId };
  }

  const sb = getServiceSupabase();
  if (!sb) {
    return { ok: false, res: withIdentity(fail(req, 500, "STORAGE_UNAVAILABLE", `Backend not available. Reference: ${debugId}`, debugId), "error") };
  }

  if (providedAgencyId) {
    // Verify user belongs to the requested agency.
    const { data, error } = await sb
      .from("agency_memberships")
      .select("agency_id")
      .eq("user_id", userId)
      .eq("agency_id", providedAgencyId)
      .eq("status", "active")
      .maybeSingle();
    if (error) {
      console.error(`[${FUNCTION_NAME}] membership lookup error debug_id=${debugId}: ${error.message}`);
      return { ok: false, res: withIdentity(fail(req, 500, "DB_ERROR", `Database error. Reference: ${debugId}`, debugId), "error") };
    }
    if (!data) {
      return { ok: false, res: withIdentity(fail(req, 403, "AGENCY_FORBIDDEN", "User does not belong to the requested agency.", debugId), "error") };
    }
    return { ok: true, agencyId: providedAgencyId };
  }

  // Auto-resolve from memberships.
  const { data, error } = await sb
    .from("agency_memberships")
    .select("agency_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) {
    console.error(`[${FUNCTION_NAME}] membership lookup error debug_id=${debugId}: ${error.message}`);
    return { ok: false, res: withIdentity(fail(req, 500, "DB_ERROR", `Database error. Reference: ${debugId}`, debugId), "error") };
  }
  const ids = Array.from(new Set((data ?? []).map((r: { agency_id: string }) => r.agency_id))).filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, res: withIdentity(fail(req, 403, "AGENCY_NOT_FOUND", "No active agency for this user.", debugId), "error") };
  }
  if (ids.length > 1) {
    return { ok: false, res: withIdentity(fail(req, 400, "AGENCY_REQUIRED", "User has multiple agencies — agencyId must be provided.", debugId), "error") };
  }
  return { ok: true, agencyId: ids[0] };
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

async function handleCreateCheckout(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
  ctx: { agencyOverride?: string | null; route?: string } = {},
) {
  const route = ctx.route ?? "create-checkout";
  const env = readStripeEnv();
  if (!env.configured || !env.secretKey) return unconfiguredResponse(req, debugId, route);

  const agencyId = String(body.agencyId ?? ctx.agencyOverride ?? "");
  const planKey = String(body.planKey ?? "") as CivikoPlanKey;
  const intervalRaw = String(body.interval ?? "month");
  const interval = (intervalRaw === "year" || intervalRaw === "annual") ? "annual" : "monthly";
  const successUrl = String(body.successUrl ?? body.returnUrl ?? "");
  const cancelUrl = String(body.cancelUrl ?? body.returnUrl ?? "");
  const email = body.email ? String(body.email) : null;
  const uiModeRaw = String(body.uiMode ?? "hosted").toLowerCase();
  const uiMode: "embedded" | "hosted" = uiModeRaw === "embedded" ? "embedded" : "hosted";

  if (!agencyId) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId is required.", debugId), "error");
  if (!CIVIKO_PLANS.includes(planKey)) return withIdentity(fail(req, 400, "INVALID_BODY", "planKey not recognized.", debugId), "error");
  if (uiMode === "hosted" && (!successUrl || !cancelUrl)) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "successUrl and cancelUrl are required for hosted mode.", debugId), "error");
  }
  if (uiMode === "embedded" && !successUrl) {
    return withIdentity(fail(req, 400, "INVALID_BODY", "returnUrl (or successUrl) is required for embedded mode.", debugId), "error");
  }

  const priceKey = `${planKey}_${interval}`;
  const priceId = env.prices[priceKey];
  if (!priceId) return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: false, reason: "price_not_configured",
    message: "Variante di abbonamento non configurata.",
  }), debugId), route);

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
    "client_reference_id": agencyId,
    "metadata[agency_id]": agencyId,
    "metadata[app_id]": CIVIKO_APP_ID,
    "metadata[plan_key]": planKey,
  };
  if (uiMode === "embedded") {
    form["ui_mode"] = "embedded";
    form["return_url"] = successUrl;
  } else {
    form["success_url"] = successUrl;
    form["cancel_url"] = cancelUrl;
  }
  if (stripeCustomerId) form["customer"] = stripeCustomerId;
  else if (email) form["customer_email"] = email;

  const r = await stripeForm(env.secretKey, "checkout/sessions", form);
  if (!r.ok) {
    console.error(`[${FUNCTION_NAME}] checkout.create failed status=${r.status} debug_id=${debugId}`);
    return withIdentity(fail(req, 502, "STRIPE_ERROR", `Checkout non disponibile. Riferimento: ${debugId}`, debugId), "error");
  }
  const url = (r.data?.url as string) ?? null;
  const clientSecret = (r.data?.client_secret as string) ?? null;
  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true,
    uiMode,
    ...(uiMode === "embedded" ? { clientSecret } : { checkoutUrl: url, url }),
    planKey, interval,
  }), debugId), route);
}

async function handleCustomerPortal(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
  ctx: { agencyOverride?: string | null; route?: string } = {},
) {
  const route = ctx.route ?? "customer-portal";
  const env = readStripeEnv();
  if (!env.configured || !env.secretKey) return unconfiguredResponse(req, debugId, route);

  const agencyId = String(body.agencyId ?? ctx.agencyOverride ?? "");
  const returnUrl = String(body.returnUrl ?? "");
  if (!agencyId || !returnUrl) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId and returnUrl are required.", debugId), "error");

  const sb = getServiceSupabase();
  if (!sb) return withIdentity(fail(req, 503, "STORAGE_UNAVAILABLE", "Backend not configured.", debugId), "error");
  const { data } = await sb.from("billing_customers")
    .select("stripe_customer_id")
    .eq("agency_id", agencyId).eq("app_id", CIVIKO_APP_ID).maybeSingle();
  if (!data?.stripe_customer_id) return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true, available: false, reason: "no_customer",
  }), debugId), route);

  const r = await stripeForm(env.secretKey, "billing_portal/sessions", {
    customer: data.stripe_customer_id,
    return_url: returnUrl,
  });
  if (!r.ok) {
    console.error(`[${FUNCTION_NAME}] portal.create failed status=${r.status} debug_id=${debugId}`);
    return withIdentity(fail(req, 502, "STRIPE_ERROR", `Portale non disponibile. Riferimento: ${debugId}`, debugId), "error");
  }
  const url = (r.data?.url as string) ?? null;
  return withIdentity(json(req, 200, sanitizeOutgoing({
    billingReady: true, portalUrl: url, url,
  }), debugId), route);
}

const PLAN_LABELS: Record<string, string> = {
  civiko_studio: "Studio",
  civiko_pro: "Pro",
  civiko_elite: "Elite",
};

function daysBetween(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86_400_000));
}

async function handleCheckSubscription(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
  ctx: { agencyOverride?: string | null; route?: string } = {},
) {
  const route = ctx.route ?? "check-subscription";
  const env = readStripeEnv();
  const agencyId = String(body.agencyId ?? ctx.agencyOverride ?? "");
  if (!agencyId) return withIdentity(fail(req, 400, "INVALID_BODY", "agencyId is required.", debugId), "error");

  if (!env.configured) {
    // Billing predisposition: PWA must see a deterministic contract.
    return withIdentity(json(req, 200, sanitizeOutgoing({
      // Normalized contract for PWA
      status: "trial",
      allowed: true,
      upgradeRequired: false,
      planLabel: "Trial",
      daysLeft: null,
      // Legacy/extended fields
      billingReady: false,
      reason: "billing_not_configured",
      plan: null,
      stripeStatus: null,
    }), debugId), route);
  }

  const sb = getServiceSupabase();
  if (!sb) {
    // Real server error — do NOT fake trial.
    return withIdentity(fail(req, 500, "STORAGE_UNAVAILABLE", `Backend not available. Reference: ${debugId}`, debugId), "error");
  }

  let sub, usage, ent;
  try {
    sub = await getActiveSubscription(sb, agencyId);
    usage = await getCurrentUsage(sb, agencyId);
    ent = sub?.planKey ? await getEntitlements(sb, sub.planKey) : null;
  } catch (e) {
    console.error(`[${FUNCTION_NAME}] check-subscription db error debug_id=${debugId}: ${e instanceof Error ? e.message : String(e)}`);
    return withIdentity(fail(req, 500, "DB_ERROR", `Database error. Reference: ${debugId}`, debugId), "error");
  }

  // ── Normalize to PWA contract ──
  const stripeStatus = sub?.status ?? null;
  const planKey = sub?.planKey ?? null;
  let normStatus: "trial" | "active" | "expired";
  let allowed: boolean;
  let upgradeRequired: boolean;
  let planLabel: string;
  let daysLeft: number | null;

  if (stripeStatus === "trialing") {
    normStatus = "trial";
    allowed = true;
    upgradeRequired = false;
    planLabel = planKey ? PLAN_LABELS[planKey] ?? "Trial" : "Trial";
    daysLeft = daysBetween(sub?.currentPeriodEnd ?? null);
  } else if (planKey && (stripeStatus === "active" || stripeStatus === "past_due")) {
    normStatus = "active";
    allowed = true;
    upgradeRequired = false;
    planLabel = PLAN_LABELS[planKey] ?? planKey;
    daysLeft = null;
  } else if (!sub) {
    // No subscription record → free-trial window driven by scan usage (matches evaluateBillingGate logic)
    const scansUsed = usage?.scans_used ?? 0;
    if (scansUsed < 3) {
      normStatus = "trial";
      allowed = true;
      upgradeRequired = false;
      planLabel = "Trial";
      daysLeft = null;
    } else {
      normStatus = "expired";
      allowed = false;
      upgradeRequired = true;
      planLabel = "Trial";
      daysLeft = 0;
    }
  } else {
    normStatus = "expired";
    allowed = false;
    upgradeRequired = true;
    planLabel = planKey ? PLAN_LABELS[planKey] ?? planKey : "Trial";
    daysLeft = 0;
  }

  return withIdentity(json(req, 200, sanitizeOutgoing({
    // ── Normalized PWA contract ──
    status: normStatus,
    allowed,
    upgradeRequired,
    planLabel,
    daysLeft,
    // ── Legacy/extended fields (kept for backward compatibility) ──
    billingReady: true,
    plan: planKey,
    stripeStatus,
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
  }), debugId), route);
}

async function handleRecordUsage(req: Request, body: Record<string, unknown>, debugId: string) {
  const agencyId = String(body.agencyId ?? "");
  const usageType = String(body.usageType ?? "") as UsageType;
  const validTypes: UsageType[] = ["scan", "owner_report", "piano_esclusiva", "zona_in_movimento", "hyperlocal_signals", "radar"];
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

    // ── New RESTful sub-paths (dual-auth: JWT user OR app-secret) ──
    // GET /subscription
    // POST /checkout
    // POST /portal
    const isRestSubscription = req.method === "GET" && (pathname.endsWith("/subscription") || pathname === EXPECTED_BASE_PATH + "/subscription");
    const isRestCheckout = req.method === "POST" && (pathname.endsWith("/checkout") && !pathname.endsWith("/create-checkout"));
    const isRestPortal = req.method === "POST" && pathname.endsWith("/portal") && !pathname.endsWith("/customer-portal");

    if (isRestSubscription || isRestCheckout || isRestPortal) {
      const auth = await authenticateDual(req, debugId);
      if (!auth.ok) return auth.res;
      const agencyOverride = auth.userId;

      if (isRestSubscription) {
        return await handleCheckSubscription(req, {}, debugId, { agencyOverride, route: "subscription" });
      }

      let body: Record<string, unknown> = {};
      try { body = (await req.json()) as Record<string, unknown>; }
      catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
      if (body == null || typeof body !== "object" || Array.isArray(body)) {
        return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
      }
      // Inject email from JWT if not provided
      if (!body.email && auth.email) body.email = auth.email;

      if (isRestCheckout) return await handleCreateCheckout(req, body, debugId, { agencyOverride, route: "checkout" });
      if (isRestPortal) return await handleCustomerPortal(req, body, debugId, { agencyOverride, route: "portal" });
    }

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

    // ── /create-checkout-direct (Civiko One consumer checkout) ──
    if (pathname.endsWith("/create-checkout-direct") || pathname.endsWith("/create-portal-session")) {
      const authFail = authCheckoutDirect(req, debugId);
      if (authFail) return withIdentity(authFail, "auth-rejected");
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) as Record<string, unknown>; }
      catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
      if (body == null || typeof body !== "object" || Array.isArray(body)) {
        return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
      }
      if (pathname.endsWith("/create-portal-session")) {
        return await handleCreatePortalSession(req, body, debugId);
      }
      return await handleCreateCheckoutDirect(req, body, debugId);
    }

    let body: Record<string, unknown> = {};
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }

    // Legacy POST sub-paths — resolve agency from JWT (with spoofing protection)
    // before invoking the handler, so PWA clients don't need to pass agencyId.
    if (
      pathname.endsWith("/create-checkout") ||
      pathname.endsWith("/customer-portal") ||
      pathname.endsWith("/check-subscription") ||
      pathname.endsWith("/record-usage")
    ) {
      const auth = await authenticateDual(req, debugId);
      if (!auth.ok) return auth.res;
      const provided = String(body.agencyId ?? "").trim();
      const resolved = await resolveAgencyForBilling(req, debugId, auth.userId, provided);
      if (!resolved.ok) return resolved.res;
      body.agencyId = resolved.agencyId;
      if (auth.email && !body.email) body.email = auth.email;

      if (pathname.endsWith("/create-checkout")) return await handleCreateCheckout(req, body, debugId);
      if (pathname.endsWith("/customer-portal")) return await handleCustomerPortal(req, body, debugId);
      if (pathname.endsWith("/check-subscription")) return await handleCheckSubscription(req, body, debugId);
      if (pathname.endsWith("/record-usage")) return await handleRecordUsage(req, body, debugId);
    }

    return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `POST ${pathname}`, debugId), "error");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, {
      error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` },
      debug_id: debugId,
    }, debugId), "error");
  }
});
