// Temporary diagnostic — verify AR Stripe prices + run non-charging
// checkout probes (sessions expired immediately). No secrets logged.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Auth: JWT verified upstream by Supabase (verify_jwt = true).


  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const monthly = Deno.env.get("AR_STRIPE_PRICE_AGENZIA_MONTHLY") ?? "";
  const annual = Deno.env.get("AR_STRIPE_PRICE_AGENZIA_ANNUAL") ?? "";
  const stripe = new Stripe(key, { apiVersion: "2023-10-16" });

  const out: Record<string, unknown> = {
    key_mode: key.startsWith("sk_live_") ? "live" : key.startsWith("sk_test_") ? "test" : "unknown",
    monthly_id_present: !!monthly,
    annual_id_present: !!annual,
  };

  async function inspectPrice(id: string) {
    try {
      const p = await stripe.prices.retrieve(id);
      return {
        exists: true,
        livemode: p.livemode,
        currency: p.currency,
        unit_amount: p.unit_amount,
        interval: p.recurring?.interval ?? null,
        active: p.active,
      };
    } catch (e) {
      return { exists: false, error: e instanceof Error ? e.message : "err" };
    }
  }

  out.monthly_price = await inspectPrice(monthly);
  out.annual_price = await inspectPrice(annual);

  async function probe(priceId: string, label: string) {
    try {
      const s = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: "https://acquisitionradar.it/checkout/successo",
        cancel_url: "https://acquisitionradar.it/pricing",
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        metadata: {
          workspace_id: "diag-probe",
          user_id: "diag",
          plan: "agenzia",
          billing_interval: label,
          app: "acquisitionradar",
        },
      });
      try { await stripe.checkout.sessions.expire(s.id); } catch { /* noop */ }
      return { ok: true, session_id: s.id, amount_total: s.amount_total, currency: s.currency, livemode: s.livemode, status: "expired" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "err" };
    }
  }

  out.probe_monthly = await probe(monthly, "monthly");
  out.probe_annual = await probe(annual, "annual");

  // Verify no leftover active subscriptions from probes
  try {
    const subs = await stripe.subscriptions.list({ limit: 10, status: "active" });
    const probeSubs = subs.data.filter((s) => (s.metadata as Record<string, string>)?.workspace_id === "diag-probe");
    out.probe_active_subs_count = probeSubs.length;
  } catch { out.probe_active_subs_count = "unknown"; }

  return new Response(JSON.stringify(out, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
});
