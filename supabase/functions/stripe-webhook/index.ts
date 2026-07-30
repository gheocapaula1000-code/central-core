// ═══════════════════════════════════════════════════════════════
// Stripe Webhook — Central Core (Civiko One)
// CHECKPOINT 9E2 — zona pagata automatica e transazionale
//
// - Verifica SEMPRE la firma Stripe (constructEventAsync)
// - Claim atomico dell'evento PRIMA delle scritture (processing)
// - processed SOLO dopo il successo completo; altrimenti failed + non-2xx
// - Pagamento valido → RPC atomica: customer + subscription + zona occupata
// - Subscription cancellata → RPC atomica: zona liberata
// - invoice.* risolve l'app dai metadata della SUBSCRIPTION, non dell'invoice
// - Nessun flusso manuale "in attesa di assegnazione"
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getStripeConfig } from "../_shared/acquisitionradar-billing.ts";
import {
  CIVIKO_TIER_PRICE_ENV,
  isCivikoZoneTier,
  type CivikoZoneTier,
} from "../_shared/civikoCheckoutContract.ts";
import { PADOVA_PILOT_ALLOWED_ZONE_SLUG } from "../_shared/civikoTerritoryContractPadovaPilotV1.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "stripe-signature, content-type",
};

const ADMIN_NOTIFY_EMAIL = "gheocapaula1000@gmail.com";
const NOTIFY_FROM = "Civiko One <onboarding@resend.dev>";
const PWA_BASE_URL = Deno.env.get("CIVIKO_PWA_BASE_URL") ?? "https://civiko-padova.lovable.app";
const APP_ID = "civiko_one";

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  try {
    console[level === "error" ? "error" : "log"](JSON.stringify({
      level, app: "stripe-webhook",
      ts: new Date().toISOString(), ...fields,
    }));
  } catch { /* noop */ }
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

/** Errore che rende l'evento ritentabile (failed + risposta non-2xx). */
class RetryableError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ──────────────────────────────────────────────────────────────
// Email — SOLO informativa (zona già confermata). Mai bloccante.
// ──────────────────────────────────────────────────────────────
async function sendEmail(to: string | string[], subject: string, text: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    log("warn", { op: "send_email", outcome: "missing_resend_key", subject });
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: NOTIFY_FROM, to: Array.isArray(to) ? to : [to], subject, text }),
    });
    if (!res.ok) log("error", { op: "send_email", status: res.status, subject });
    else log("info", { op: "send_email", outcome: "sent", subject });
  } catch (e) {
    log("error", { op: "send_email", msg: e instanceof Error ? e.message : String(e) });
  }
}

async function notifyAdminZonaConfermata(args: {
  workspace_id: string;
  email: string;
  zone: string;
  amount: number;
  subscription_id: string;
}) {
  const body = `Pagamento ricevuto e zona GIA' CONFERMATA automaticamente.

Email cliente: ${args.email || "n/d"}
Workspace / Agency ID: ${args.workspace_id}
Subscription ID: ${args.subscription_id}
Zona assegnata: ${args.zone}
Importo: ${args.amount.toFixed(2)} EUR
Confermata il: ${new Date().toISOString()}

Nessuna azione manuale richiesta: la zona risulta occupata dall'agenzia pagante.
Pannello: ${PWA_BASE_URL}/admin/esclusive`;
  await sendEmail(ADMIN_NOTIFY_EMAIL, "✅ Civiko One — pagamento ricevuto, zona confermata", body);
}

async function notifyAdminZonaLiberata(args: {
  subscription_id: string;
  workspace_id: string | null;
  zona: string | null;
  released: boolean;
}) {
  const body = `Subscription cancellata: ${args.subscription_id}
Workspace ex-titolare: ${args.workspace_id ?? "n/d"}
Zona: ${args.zona ?? "n/d"}
Zona effettivamente liberata: ${args.released ? "si" : "no"}`;
  await sendEmail(ADMIN_NOTIFY_EMAIL, "🔓 Civiko One — zona liberata automaticamente", body);
}

async function notifyUserPaymentFailed(args: { email: string | null; subscription_id: string }) {
  if (!args.email) return;
  const body = `Ciao,

Il rinnovo del tuo abbonamento Civiko One non e andato a buon fine.
La tua zona resta riservata: aggiorna il metodo di pagamento qui:
${PWA_BASE_URL}/abbonamento

Se hai bisogno di aiuto, scrivici a paula@civiko.it.`;
  await sendEmail(args.email, "⚠️ Problema con il pagamento Civiko One", body);
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function isCivikoMeta(meta: Record<string, string> | null | undefined): boolean {
  const m = meta ?? {};
  const app = String(m.app ?? "").toLowerCase();
  const source = String(m.source ?? "").toLowerCase();
  return app === "civiko" || app === "civiko_one" || source === "civiko";
}

/** Il price id deve corrispondere alla env var della fascia dichiarata. */
function priceMatchesTier(priceId: string | null, tier: string): boolean {
  if (!priceId) return false;
  if (!isCivikoZoneTier(tier)) return false;
  const envKey = CIVIKO_TIER_PRICE_ENV[tier as CivikoZoneTier];
  const expected = (Deno.env.get(envKey) ?? "").trim();
  if (!expected) return false;
  return expected === priceId.trim();
}

async function retrieveSubscription(stripe: Stripe, subId: string): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.retrieve(subId);
  } catch (e) {
    throw new RetryableError("stripe_retrieve_failed", e instanceof Error ? e.message : "unknown");
  }
}

function tsToIso(v: number | null | undefined): string | null {
  return v ? new Date(v * 1000).toISOString() : null;
}

/** Attivazione atomica via RPC. Qualunque fallimento è ritentabile. */
async function activatePaidZone(args: {
  agencyId: string;
  zoneSlug: string;
  customerId: string;
  subscriptionId: string;
  status: string;
  priceId: string | null;
  planKey: string | null;
  email: string | null;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
}): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("civiko_activate_paid_zone_atomic", {
    p_agency_id: args.agencyId,
    p_zone_slug: args.zoneSlug,
    p_stripe_customer_id: args.customerId,
    p_stripe_subscription_id: args.subscriptionId,
    p_status: args.status,
    p_price_id: args.priceId,
    p_plan_key: args.planKey,
    p_billing_interval: "monthly",
    p_email: args.email,
    p_current_period_end: tsToIso(args.currentPeriodEnd),
    p_trial_end: tsToIso(args.trialEnd),
    p_cancel_at_period_end: args.cancelAtPeriodEnd,
    p_app_id: APP_ID,
  });
  if (error) throw new RetryableError("activate_rpc_error", error.message);
  const res = (data ?? {}) as Record<string, unknown>;
  if (res.ok !== true) throw new RetryableError("activate_rejected", String(res.code ?? "unknown"));
  return res;
}

// ──────────────────────────────────────────────────────────────
// Event handlers — throw = evento ritentabile
// ──────────────────────────────────────────────────────────────
async function handleCheckoutCompleted(stripe: Stripe, event: Stripe.Event) {
  const s = event.data.object as Stripe.Checkout.Session;
  const meta = (s.metadata ?? {}) as Record<string, string>;

  if (!isCivikoMeta(meta)) return { skipped: "non_civiko" };
  if (s.mode !== "subscription") return { skipped: "not_subscription_mode" };
  if (s.status !== "complete") return { skipped: "session_not_complete" };
  if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
    return { skipped: "not_paid" };
  }
  if (!s.subscription) return { skipped: "no_subscription" };

  const workspaceId = String(meta.workspace_id ?? "").trim();
  if (!workspaceId) return { skipped: "no_workspace_id" };

  const zoneSlug = String(meta.zone_slug ?? "").trim();
  if (zoneSlug !== PADOVA_PILOT_ALLOWED_ZONE_SLUG) return { skipped: "zone_not_in_pilot" };

  const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
  if (!customerId) return { skipped: "no_customer" };

  const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
  const sub = await retrieveSubscription(stripe, subId);
  if (sub.status !== "active" && sub.status !== "trialing") {
    return { skipped: "subscription_not_active" };
  }

  const priceId = sub.items.data[0]?.price?.id ?? null;
  const tier = String(meta.zone_tier ?? "").trim().toLowerCase();
  if (!priceMatchesTier(priceId, tier)) {
    return { skipped: "price_tier_mismatch" };
  }

  const email = s.customer_details?.email ?? s.customer_email ?? null;

  const res = await activatePaidZone({
    agencyId: workspaceId,
    zoneSlug,
    customerId,
    subscriptionId: sub.id,
    status: sub.status,
    priceId,
    planKey: tier,
    email,
    currentPeriodEnd: sub.current_period_end ?? null,
    trialEnd: sub.trial_end ?? null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  });

  await notifyAdminZonaConfermata({
    workspace_id: workspaceId,
    email: email ?? "",
    zone: zoneSlug,
    amount: (s.amount_total ?? 0) / 100,
    subscription_id: sub.id,
  });

  return { activated: true, zone: res.zone, occupied_since: res.occupied_since };
}

async function handleSubscriptionUpsert(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const meta = (sub.metadata ?? {}) as Record<string, string>;
  if (!isCivikoMeta(meta)) return { skipped: "non_civiko" };

  const workspaceId = String(meta.workspace_id ?? "").trim();
  const zoneSlug = String(meta.zone_slug ?? "").trim();
  const tier = String(meta.zone_tier ?? "").trim().toLowerCase();
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const priceId = sub.items.data[0]?.price?.id ?? null;

  // Aggiorna lo stato di una subscription già nota, senza toccare la zona.
  const { data: existing, error: selErr } = await supabase
    .from("billing_subscriptions")
    .select("id")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  if (selErr) throw new RetryableError("db_select_error", selErr.message);

  if (existing) {
    const { error } = await supabase
      .from("billing_subscriptions")
      .update({
        status: sub.status,
        price_id: priceId,
        current_period_end: tsToIso(sub.current_period_end ?? null),
        trial_end: tsToIso(sub.trial_end ?? null),
        cancel_at_period_end: !!sub.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", sub.id);
    if (error) throw new RetryableError("db_update_error", error.message);
    return { updated: true };
  }

  // Non nota: attiva solo se il pagamento è valido e la zona è quella pilot.
  if (!workspaceId) return { skipped: "no_workspace_id" };
  if (zoneSlug !== PADOVA_PILOT_ALLOWED_ZONE_SLUG) return { skipped: "zone_not_in_pilot" };
  if (sub.status !== "active" && sub.status !== "trialing") return { skipped: "subscription_not_active" };
  if (!priceMatchesTier(priceId, tier)) return { skipped: "price_tier_mismatch" };

  const res = await activatePaidZone({
    agencyId: workspaceId,
    zoneSlug,
    customerId,
    subscriptionId: sub.id,
    status: sub.status,
    priceId,
    planKey: tier,
    email: null,
    currentPeriodEnd: sub.current_period_end ?? null,
    trialEnd: sub.trial_end ?? null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  });
  return { activated: true, zone: res.zone };
}

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;

  const { data, error } = await supabase.rpc("civiko_release_zone_on_cancel_atomic", {
    p_stripe_subscription_id: sub.id,
  });
  if (error) throw new RetryableError("release_rpc_error", error.message);

  const res = (data ?? {}) as Record<string, unknown>;
  if (res.ok !== true) throw new RetryableError("release_rejected", String(res.code ?? "unknown"));

  if (res.zone) {
    await notifyAdminZonaLiberata({
      subscription_id: sub.id,
      workspace_id: (res.agency_id as string | null) ?? null,
      zona: (res.zone as string | null) ?? null,
      released: res.released === true,
    });
  }
  return { released: res.released === true, zone: res.zone ?? null };
}

async function handleInvoice(stripe: Stripe, event: Stripe.Event, succeeded: boolean) {
  const inv = event.data.object as Stripe.Invoice;
  const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? null;
  if (!subId) return { skipped: "no_subscription" };

  // L'app si risolve dai metadata della SUBSCRIPTION, non dell'invoice.
  const sub = await retrieveSubscription(stripe, subId);
  if (!isCivikoMeta((sub.metadata ?? {}) as Record<string, string>)) {
    return { skipped: "non_civiko" };
  }

  const { data: existing, error: selErr } = await supabase
    .from("billing_subscriptions")
    .select("id, agency_id, stripe_customer_id")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  if (selErr) throw new RetryableError("db_select_error", selErr.message);
  if (!existing) return { skipped: "subscription_unknown" };

  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: succeeded ? "active" : "past_due",
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subId);
  if (error) throw new RetryableError("db_update_error", error.message);

  // past_due NON libera la zona.
  if (!succeeded) {
    await notifyUserPaymentFailed({
      email: inv.customer_email ?? null,
      subscription_id: subId,
    });
  }
  return { status: succeeded ? "active" : "past_due", zone_preserved: true };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);

  const cfg = getStripeConfig();
  if (!cfg.configured || !cfg.secretKey) return jsonRes({ error: "billing_not_configured" }, 503);
  if (!cfg.webhookSecret) {
    log("error", { outcome: "missing_webhook_secret" });
    return jsonRes({ error: "webhook_not_configured" }, 503);
  }

  const stripe = new Stripe(cfg.secretKey, { apiVersion: "2023-10-16" });
  const sig = req.headers.get("stripe-signature") ?? "";
  const raw = await req.text();

  // 1) Firma SEMPRE verificata
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, cfg.webhookSecret);
  } catch (e) {
    log("warn", { outcome: "invalid_signature", msg: e instanceof Error ? e.message : "unknown" });
    return jsonRes({ error: "invalid_signature" }, 400);
  }

  // 2) Claim atomico PRIMA di qualunque scrittura
  const { data: claimData, error: claimErr } = await supabase.rpc("stripe_webhook_event_claim", {
    p_event_id: event.id,
    p_type: event.type,
  });
  if (claimErr) {
    log("error", { outcome: "claim_error", event: event.type, id: event.id, msg: claimErr.message });
    return jsonRes({ error: "claim_failed", retryable: true }, 500);
  }
  const claim = (claimData ?? {}) as Record<string, unknown>;
  if (claim.claimed !== true) {
    log("info", { outcome: "idempotent_skip", event: event.type, id: event.id, status: claim.status });
    return jsonRes({ ok: true, idempotent: true });
  }

  log("info", { outcome: "claimed", event: event.type, id: event.id, attempts: claim.attempts, livemode: event.livemode });

  // 3) Elaborazione
  try {
    let result: Record<string, unknown>;
    switch (event.type) {
      case "checkout.session.completed":
        result = await handleCheckoutCompleted(stripe, event);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        result = await handleSubscriptionUpsert(event);
        break;
      case "customer.subscription.deleted":
        result = await handleSubscriptionDeleted(event);
        break;
      case "invoice.payment_succeeded":
        result = await handleInvoice(stripe, event, true);
        break;
      case "invoice.payment_failed":
        result = await handleInvoice(stripe, event, false);
        break;
      default:
        result = { ignored: true };
    }

    // 4) processed SOLO dopo il successo completo
    const { error: markErr } = await supabase.rpc("stripe_webhook_event_mark_processed", {
      p_event_id: event.id,
    });
    if (markErr) {
      log("error", { outcome: "mark_processed_failed", id: event.id, msg: markErr.message });
      return jsonRes({ error: "registry_close_failed", retryable: true }, 500);
    }

    log("info", { outcome: "processed", event: event.type, id: event.id, ...result });
    return jsonRes({ received: true, ...result });
  } catch (e) {
    const code = e instanceof RetryableError ? e.code : "handler_exception";
    const msg = e instanceof Error ? e.message : "unknown";
    log("error", { outcome: "failed", event: event.type, id: event.id, code, msg });
    await supabase.rpc("stripe_webhook_event_mark_failed", {
      p_event_id: event.id,
      p_error: `${code}: ${msg}`,
    });
    return jsonRes({ error: code, retryable: true }, 500);
  }
});
