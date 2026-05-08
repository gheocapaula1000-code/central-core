import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const billing_active = !!stripeKey;

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const authHeader = req.headers.get("Authorization") ?? "";
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));

  if (!user) return new Response(JSON.stringify({ billing_active, subscriptionStatus: null, plan: null }), { headers: CORS });

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, plan, scans_used, scans_limit, current_period_end")
    .eq("user_id", user.id)
    .single();

  return new Response(JSON.stringify({
    billing_active,
    subscriptionStatus: sub?.status ?? "trialing",
    plan: sub?.plan ?? null,
    scans_used: sub?.scans_used ?? 0,
    scans_limit: sub?.scans_limit ?? 3,
    current_period_end: sub?.current_period_end ?? null,
  }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
