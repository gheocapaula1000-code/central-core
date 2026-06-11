// ═══════════════════════════════════════════════════════════════
// Stripe Webhook (AcquisitionRadar / Civiko shared)
//
// - Verifica firma Stripe (constructEventAsync + STRIPE_WEBHOOK_SECRET)
// - Idempotenza via tabella public.stripe_webhook_events
// - Aggiorna billing_customers / billing_subscriptions (mapping legacy)
// - Per app="civiko" gestisce zona_status / zona_assegnata + notifiche email Resend
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getStripeConfig, planFromPriceId } from "../_shared/acquisitionradar-billing.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "stripe-signature, content-type",
};

const ADMIN_NOTIFY_EMAIL = "gheocapaula1000@gmail.com";
const NOTIFY_FROM = "Civiko One <onboarding@resend.dev>";
const PWA_BASE_URL = Deno.env.get("CIVIKO_PWA_BASE_URL") ?? "https://civiko-padova.lovable.app";

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

// ──────────────────────────────────────────────────────────────
// Email helpers (Resend)
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
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log("error", { op: "send_email", status: res.status, body, subject });
    } else {
      log("info", { op: "send_email", outcome: "sent", subject, to });
    }
  } catch (e) {
    log("error", { op: "send_email", msg: e instanceof Error ? e.message : String(e) });
  }
}

async function notifyAdminNewSubscription(args: {
  workspace_id: string | null;
  supabase_user_id: string | null;
  email: string;
  plan: string;
  amount: number;
  subscription_id: string;
}) {
  const body = `Nuovo abbonato Civiko One:

Email: ${args.email || "n/d"}
User ID: ${args.supabase_user_id ?? "n/d"}
Workspace / Agency ID: ${args.workspace_id ?? "n/d"}
Subscription ID: ${args.subscription_id}
Piano: ${args.plan} (${args.amount.toFixed(2)} EUR)
Pagamento ricevuto: ${new Date().toISOString()}

Azione richiesta entro 24h:
- Contatta cliente per definire zona Padova esclusiva
- Vai su admin -> /admin/esclusive
- Assegna zona al workspace ${args.workspace_id ?? "(usa subscription id)"}
- Stato passera automaticamente a "assegnata"

Link admin: ${PWA_BASE_URL}/admin/esclusive`;
  await sendEmail(ADMIN_NOTIFY_EMAIL, "🎉 Nuovo abbonato Civiko One — assegna zona", body);
}

async function notifyAdminZonaLiberata(args: {
  subscription_id: string;
  workspace_id: string | null;
  zona: string | null;
}) {
  const body = `Una zona Padova e ora disponibile.

Subscription cancellata: ${args.subscription_id}
Workspace ex-titolare: ${args.workspace_id ?? "n/d"}
Zona liberata: ${args.zona ?? "n/d"}

La zona e ora libera per essere riassegnata a un nuovo abbonato.`;
  await sendEmail(ADMIN_NOTIFY_EMAIL, "🔓 Zona Padova liberata — disponibile per nuovo abbonato", body);
}

async function notifyUserPaymentFailed(args: { email: string | null; subscription_id: string }) {
  if (!args.email) {
    log("warn", { op: "notify_user_payment_failed", outcome: "no_email", subscription_id: args.subscription_id });
    return;
  }
  const portalUrl = `${PWA_BASE_URL}/abbonamento`;
  const body = `Ciao,

Il rinnovo del tuo abbonamento Civiko One non e andato a buon fine.

Aggiorna il metodo di pagamento entro 7 giorni per non perdere l'esclusiva sulla tua zona:
${portalUrl}

Se hai bisogno di aiuto, scrivici a paula@civiko.it.`;
  await sendEmail(args.email, "⚠️ Problema con il pagamento Civiko One", body);
}

// ──────────────────────────────────────────────────────────────
// Mapping helpers
// ──────────────────────────────────────────────────────────────
async function resolveAgencyId(stripeCustomerId: string | null, metaWorkspaceId?: string, metaUserId?: string): Promise<string | null> {
  if (metaWorkspaceId) return metaWorkspaceId;
  if (metaUserId) return metaUserId;
  if (!stripeCustomerId) return null;
  const { data } = await supabase
    .from("billing_customers")
    .select("agency_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return (data?.agency_id as string | null) ?? null;
}

async function upsertCustomer(agencyId: string, stripeCustomerId: string, email: string | null, app: string) {
  const { error } = await supabase
    .from("billing_customers")
    .upsert(
      { agency_id: agencyId, app_id: app, stripe_customer_id: stripeCustomerId, email: email ?? null },
      { onConflict: "agency_id,app_id" },
    );
  if (error) log("error", { op: "upsert_customer", msg: error.message });
}

async function upsertSubscription(args: {
  agencyId: string;
  app: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  priceId: string | null;
  planKey: string | null;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  billingInterval?: string | null;
  zonaStatus?: string | null;
  zonaAssegnata?: string | null;
}) {
  const row: Record<string, unknown> = {
    agency_id: args.agencyId,
    app_id: args.app,
    stripe_customer_id: args.stripeCustomerId,
    stripe_subscription_id: args.stripeSubscriptionId,
    status: args.status,
    price_id: args.priceId,
    plan_key: args.planKey,
    current_period_end: args.currentPeriodEnd ? new Date(args.currentPeriodEnd * 1000).toISOString() : null,
    trial_end: args.trialEnd ? new Date(args.trialEnd * 1000).toISOString() : null,
    cancel_at_period_end: args.cancelAtPeriodEnd,
  };
  if (args.billingInterval !== undefined) row.billing_interval = args.billingInterval;
  if (args.zonaStatus !== undefined && args.zonaStatus !== null) row.zona_status = args.zonaStatus;
  if (args.zonaAssegnata !== undefined) row.zona_assegnata = args.zonaAssegnata;

  const { error } = await supabase
    .from("billing_subscriptions")
    .upsert(row, { onConflict: "stripe_subscription_id" });
  if (error) log("error", { op: "upsert_subscription", msg: error.message });
}

async function getSubscriptionRow(stripeSubscriptionId: string) {
  const { data } = await supabase
    .from("billing_subscriptions")
    .select("agency_id, app_id, zona_assegnata, stripe_customer_id")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();
  return data;
}

async function getCustomerEmail(stripeCustomerId: string): Promise<string | null> {
  const { data } = await supabase
    .from("billing_customers")
    .select("email")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return (data?.email as string | null) ?? null;
}

// ──────────────────────────────────────────────────────────────
// Main handler
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

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, cfg.webhookSecret);
  } catch (e) {
    log("warn", { outcome: "invalid_signature", msg: e instanceof Error ? e.message : "unknown" });
    return jsonRes({ error: "invalid_signature" }, 400);
  }

  // Idempotency check
  const { data: alreadyProcessed } = await supabase
    .from("stripe_webhook_events")
    .select("id")
    .eq("id", event.id)
    .maybeSingle();
  if (alreadyProcessed) {
    log("info", { outcome: "idempotent_skip", event: event.type, id: event.id });
    return jsonRes({ ok: true, idempotent: true });
  }

  log("info", { event: event.type, id: event.id, mode: cfg.mode });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode !== "subscription") break;

        const meta = (s.metadata ?? {}) as Record<string, string>;
        const app = meta.app || "civiko_one";
        const isCiviko = app === "civiko" || app === "civiko_one";
        const stripeCustomerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
        const agencyId = await resolveAgencyId(stripeCustomerId, meta.workspace_id, meta.supabase_user_id || meta.user_id);

        if (!agencyId || !stripeCustomerId) {
          log("warn", { outcome: "skip_no_agency", event: event.type, customer: stripeCustomerId });
          break;
        }

        await upsertCustomer(agencyId, stripeCustomerId, s.customer_details?.email ?? s.customer_email ?? null, app);

        if (s.subscription) {
          const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          const item = sub.items.data[0];
          const priceId = item?.price?.id ?? null;
          const interval = item?.price?.recurring?.interval; // 'month' | 'year'
          const billingInterval = meta.plan === "yearly" || interval === "year" ? "yearly" : "monthly";

          await upsertSubscription({
            agencyId,
            app,
            stripeCustomerId,
            stripeSubscriptionId: sub.id,
            status: sub.status,
            priceId,
            planKey: priceId ? (planFromPriceId(priceId) || meta.plan || null) : (meta.plan || null),
            currentPeriodEnd: sub.current_period_end ?? null,
            trialEnd: sub.trial_end ?? null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
            billingInterval: isCiviko ? billingInterval : null,
            zonaStatus: isCiviko ? "in_attesa" : undefined,
          });

          if (isCiviko) {
            await notifyAdminNewSubscription({
              workspace_id: meta.workspace_id ?? agencyId,
              supabase_user_id: meta.supabase_user_id ?? meta.user_id ?? null,
              email: s.customer_details?.email ?? s.customer_email ?? "",
              plan: billingInterval,
              amount: (s.amount_total ?? 0) / 100,
              subscription_id: sub.id,
            });
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const meta = (sub.metadata ?? {}) as Record<string, string>;
        const app = meta.app || "civiko_one";
        const isCiviko = app === "civiko" || app === "civiko_one";
        const agencyId = await resolveAgencyId(stripeCustomerId, meta.workspace_id, meta.supabase_user_id || meta.user_id);
        if (!agencyId) {
          log("warn", { outcome: "skip_no_agency", event: event.type, customer: stripeCustomerId });
          break;
        }
        const item = sub.items.data[0];
        const priceId = item?.price?.id ?? null;
        const interval = item?.price?.recurring?.interval;
        const billingInterval = interval === "year" ? "yearly" : "monthly";

        await upsertSubscription({
          agencyId,
          app,
          stripeCustomerId,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          priceId,
          planKey: priceId ? (planFromPriceId(priceId) || null) : null,
          currentPeriodEnd: sub.current_period_end ?? null,
          trialEnd: sub.trial_end ?? null,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          billingInterval: isCiviko ? billingInterval : null,
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const meta = (sub.metadata ?? {}) as Record<string, string>;
        const app = meta.app || "civiko_one";
        const isCiviko = app === "civiko" || app === "civiko_one";
        const existing = await getSubscriptionRow(sub.id);

        const update: Record<string, unknown> = {
          status: "canceled",
        };
        if (isCiviko) update.zona_status = "liberata";

        const { error } = await supabase
          .from("billing_subscriptions")
          .update(update)
          .eq("stripe_subscription_id", sub.id);
        if (error) log("error", { op: "cancel_sub", msg: error.message });

        if (isCiviko) {
          await notifyAdminZonaLiberata({
            subscription_id: sub.id,
            workspace_id: existing?.agency_id ?? meta.workspace_id ?? null,
            zona: (existing?.zona_assegnata as string | null) ?? null,
          });
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
        if (!subId) break;
        const { error } = await supabase
          .from("billing_subscriptions")
          .update({ status: "active" })
          .eq("stripe_subscription_id", subId);
        if (error) log("error", { op: "invoice_succeeded", msg: error.message });
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
        if (!subId) break;
        const { error } = await supabase
          .from("billing_subscriptions")
          .update({ status: "past_due" })
          .eq("stripe_subscription_id", subId);
        if (error) log("error", { op: "invoice_failed", msg: error.message });

        // Notify user
        const stripeCustomerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
        const email = inv.customer_email
          ?? (stripeCustomerId ? await getCustomerEmail(stripeCustomerId) : null);
        await notifyUserPaymentFailed({ email, subscription_id: subId });
        break;
      }

      default:
        log("info", { outcome: "ignored", event: event.type });
    }

    // Mark as processed
    await supabase.from("stripe_webhook_events").insert({
      id: event.id,
      type: event.type,
    });
  } catch (e) {
    log("error", { outcome: "handler_exception", event: event.type, msg: e instanceof Error ? e.message : "unknown" });
  }

  return jsonRes({ received: true });
});
