import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  getStripeConfig,
  planFromPriceId,
  AR_DEFAULT_CHECKOUT_OK,
  AR_DEFAULT_CHECKOUT_KO,
} from "../_shared/acquisitionradar-billing.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const cfg = getStripeConfig();
  if (!cfg.configured || !cfg.secretKey) {
    return jsonRes({ error: "billing_not_configured" }, 503);
  }
  const stripe = new Stripe(cfg.secretKey, { apiVersion: "2023-10-16" });
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // ── Dual auth: x-internal-secret OR user JWT ──
  let userId: string | null = null;
  let userEmail: string | null = null;

  const providedSecret = req.headers.get("x-internal-secret") ?? "";
  const internalSecret = Deno.env.get("CORE_INTERNAL_SECRET") ?? "";
  const internalAuthorized = !!providedSecret && !!internalSecret && safeEqual(providedSecret, internalSecret);

  if (!internalAuthorized) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return jsonRes({ error: "Unauthorized" }, 401);
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return jsonRes({ error: "Unauthorized" }, 401);
    userId = user.id;
    userEmail = user.email ?? null;
  }

  const body = await req.json().catch(() => ({}));
  const {
    price_id, email: bodyEmail, user_id: bodyUserId, workspace_id: bodyWorkspaceId,
    success_url: bodySuccessUrl, cancel_url: bodyCancelUrl,
  } = body as {
    price_id?: string; email?: string; user_id?: string; workspace_id?: string;
    success_url?: string; cancel_url?: string;
  };
  if (!price_id) return jsonRes({ error: "Missing price_id" }, 400);

  const plan = planFromPriceId(price_id);
  if (!plan) {
    // Unknown price_id: refuse rather than create an unattributed subscription.
    return jsonRes({ error: "unknown_price_id" }, 400);
  }

  const customerEmail = userEmail ?? bodyEmail ?? undefined;
  const metaUserId = userId ?? bodyUserId ?? "";
  const workspaceId = bodyWorkspaceId ?? "";

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: customerEmail,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: bodySuccessUrl || AR_DEFAULT_CHECKOUT_OK,
      cancel_url:  bodyCancelUrl  || AR_DEFAULT_CHECKOUT_KO,
      metadata: { user_id: metaUserId, workspace_id: workspaceId, plan, app: "AcquisitionRadar" },
    });
    console.log(JSON.stringify({
      level: "info", app: "AcquisitionRadar", endpoint: "/create-checkout",
      mode: cfg.mode, plan, workspace_id: workspaceId, outcome: "ok",
    }));
    return jsonRes({ url: session.url });
  } catch (e) {
    console.error(JSON.stringify({
      level: "error", app: "AcquisitionRadar", endpoint: "/create-checkout",
      mode: cfg.mode, plan, workspace_id: workspaceId, outcome: "stripe_error",
      msg: e instanceof Error ? e.message : "unknown",
    }));
    return jsonRes({ error: "stripe_error" }, 502);
  }
});
