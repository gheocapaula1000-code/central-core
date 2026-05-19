import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const DEFAULT_RETURN_URL = "https://acquisitionradar.app/account";

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

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  try {
    console[level === "error" ? "error" : "log"](JSON.stringify({
      level, app: "AcquisitionRadar", endpoint: "/create-customer-portal",
      ts: new Date().toISOString(), ...fields,
    }));
  } catch { /* noop */ }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2023-10-16" });
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // ── Dual auth: same logic as /create-checkout ──
  let userId: string | null = null;

  const providedSecret = req.headers.get("x-internal-secret") ?? "";
  const internalSecret = Deno.env.get("CORE_INTERNAL_SECRET") ?? "";
  const internalAuthorized = !!providedSecret && !!internalSecret && safeEqual(providedSecret, internalSecret);

  if (!internalAuthorized) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      log("warn", { outcome: "unauthorized", reason: "missing_token" });
      return jsonRes({ error: "Unauthorized" }, 401);
    }
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      log("warn", { outcome: "unauthorized", reason: "invalid_token" });
      return jsonRes({ error: "Unauthorized" }, 401);
    }
    userId = user.id;
  }

  const body = await req.json().catch(() => ({})) as {
    return_url?: string;
    workspace_id?: string;
    user_id?: string;
  };
  const returnUrl = body.return_url || DEFAULT_RETURN_URL;
  const workspaceId = body.workspace_id ?? "";
  const effectiveUserId = userId ?? body.user_id ?? "";

  // ── Resolve workspace.stripe_customer_id ──
  let stripeCustomerId: string | null = null;
  try {
    let q = supabase.from("workspaces").select("stripe_customer_id").limit(1);
    if (workspaceId) {
      q = supabase.from("workspaces").select("stripe_customer_id").eq("id", workspaceId).limit(1);
    } else if (effectiveUserId) {
      q = supabase.from("workspaces").select("stripe_customer_id").eq("owner_id", effectiveUserId).limit(1);
    }
    const { data, error } = await q.maybeSingle();
    if (error) {
      log("error", { outcome: "db_error", workspace_id: workspaceId, msg: error.message });
    } else {
      stripeCustomerId = (data?.stripe_customer_id as string | null) ?? null;
    }
  } catch (e) {
    log("error", { outcome: "db_exception", workspace_id: workspaceId, msg: e instanceof Error ? e.message : "unknown" });
  }

  if (!stripeCustomerId) {
    log("warn", { outcome: "missing_stripe_customer_id", workspace_id: workspaceId });
    return jsonRes({ error: "missing_stripe_customer_id" }, 422);
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });
    log("info", { outcome: "ok", workspace_id: workspaceId });
    return jsonRes({ url: session.url });
  } catch (e) {
    log("error", { outcome: "stripe_error", workspace_id: workspaceId, msg: e instanceof Error ? e.message : "unknown" });
    return jsonRes({ error: "stripe_error" }, 502);
  }
});
