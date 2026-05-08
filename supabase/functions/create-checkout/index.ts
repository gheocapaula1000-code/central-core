import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2023-10-16" });
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  const authHeader = req.headers.get("Authorization") ?? "";
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });

  const { price_id } = await req.json();
  if (!price_id) return new Response(JSON.stringify({ error: "Missing price_id" }), { status: 400, headers: CORS });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    customer_email: user.email,
    line_items: [{ price: price_id, quantity: 1 }],
    success_url: "https://sottra.app?checkout=success",
    cancel_url: "https://sottra.app?checkout=cancel",
    metadata: { user_id: user.id },
  });

  return new Response(JSON.stringify({ url: session.url }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
