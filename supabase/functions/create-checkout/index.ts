import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Constant-time string compare to avoid timing leaks on secret check
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2023-10-16" });
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // ── Dual auth: accept x-internal-secret (server-to-server) OR user JWT ──
  let userId: string | null = null;
  let userEmail: string | null = null;

  const providedSecret = req.headers.get("x-internal-secret") ?? "";
  const internalSecret = Deno.env.get("CORE_INTERNAL_SECRET") ?? "";
  const internalAuthorized = !!providedSecret && !!internalSecret && safeEqual(providedSecret, internalSecret);

  if (!internalAuthorized) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    userId = user.id;
    userEmail = user.email ?? null;
  }

  const body = await req.json().catch(() => ({}));
  const { price_id, email: bodyEmail, user_id: bodyUserId } = body as { price_id?: string; email?: string; user_id?: string };
  if (!price_id) return new Response(JSON.stringify({ error: "Missing price_id" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

  // When called via internal secret, allow caller to specify customer email / user_id in body
  const customerEmail = userEmail ?? bodyEmail ?? undefined;
  const metaUserId = userId ?? bodyUserId ?? "";

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    customer_email: customerEmail,
    line_items: [{ price: price_id, quantity: 1 }],
    success_url: "https://sottra.app?checkout=success",
    cancel_url: "https://sottra.app?checkout=cancel",
    metadata: { user_id: metaUserId },
  });

  return new Response(JSON.stringify({ url: session.url }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
