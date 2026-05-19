// ═══════════════════════════════════════════════════════════════
// Stripe Webhook (AcquisitionRadar / Civiko shared)
//
// Receives Stripe events and projects them into the Core billing tables:
//   • billing_customers          (agency_id ↔ stripe_customer_id)
//   • billing_subscriptions      (agency_id ↔ stripe_subscription_id + status/plan/period)
//
// Mapping rules:
//   • agency_id is resolved from session.metadata.workspace_id (preferred)
//     or session.metadata.user_id (fallback). On subscription-only events
//     we look up agency_id from billing_customers by stripe_customer_id.
//   • plan_key resolved via _shared/acquisitionradar-billing.planFromPriceId
//   • app_id = "AcquisitionRadar" for events tagged with metadata.app, otherwise
//     we keep the row default ("civiko_one") to stay backward-compatible.
//
// Signature verification is MANDATORY. No JWT auth (public endpoint).
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getStripeConfig, planFromPriceId } from "../_shared/acquisitionradar-billing.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "stripe-signature, content-type",
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  try {
    console[level === "error" ? "error" : "log"](JSON.stringify({
      level, app: "AcquisitionRadar", endpoint: "/stripe-webhook",
      ts: new Date().toISOString(), ...fields,
    }));
  } catch { /* noop */ }
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

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
}) {
  const row = {
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
  const { error } = await supabase
    .from("billing_subscriptions")
    .upsert(row, { onConflict: "stripe_subscription_id" });
  if (error) log("error", { op: "upsert_subscription", msg: error.message });
}

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

  log("info", { event: event.type, id: event.id, mode: cfg.mode });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const meta = (s.metadata ?? {}) as Record<string, string>;
        const app = meta.app || "civiko_one";
        const stripeCustomerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
        const agencyId = await resolveAgencyId(stripeCustomerId, meta.workspace_id, meta.user_id);
        if (!agencyId || !stripeCustomerId) {
          log("warn", { outcome: "skip_no_agency", event: event.type, customer: stripeCustomerId });
          break;
        }
        await upsertCustomer(agencyId, stripeCustomerId, s.customer_email ?? null, app);
        if (s.subscription) {
          const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          const item = sub.items.data[0];
          const priceId = item?.price?.id ?? null;
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
          });
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const meta = (sub.metadata ?? {}) as Record<string, string>;
        const app = meta.app || "civiko_one";
        const agencyId = await resolveAgencyId(stripeCustomerId, meta.workspace_id, meta.user_id);
        if (!agencyId) {
          log("warn", { outcome: "skip_no_agency", event: event.type, customer: stripeCustomerId });
          break;
        }
        const item = sub.items.data[0];
        const priceId = item?.price?.id ?? null;
        const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
        await upsertSubscription({
          agencyId,
          app,
          stripeCustomerId,
          stripeSubscriptionId: sub.id,
          status,
          priceId,
          planKey: priceId ? (planFromPriceId(priceId) || null) : null,
          currentPeriodEnd: sub.current_period_end ?? null,
          trialEnd: sub.trial_end ?? null,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        });
        break;
      }

      case "invoice.payment_succeeded":
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
        if (!subId) break;
        const sub = await stripe.subscriptions.retrieve(subId);
        const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const meta = (sub.metadata ?? {}) as Record<string, string>;
        const app = meta.app || "civiko_one";
        const agencyId = await resolveAgencyId(stripeCustomerId, meta.workspace_id, meta.user_id);
        if (!agencyId) break;
        const item = sub.items.data[0];
        const priceId = item?.price?.id ?? null;
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
        });
        break;
      }

      default:
        log("info", { outcome: "ignored", event: event.type });
    }
  } catch (e) {
    log("error", { outcome: "handler_exception", event: event.type, msg: e instanceof Error ? e.message : "unknown" });
  }

  return jsonRes({ received: true });
});
