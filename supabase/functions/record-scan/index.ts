import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const authHeader = req.headers.get("Authorization") ?? "";
  const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (authErr || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });

  // Get user subscription (billing_subscriptions uses agency_id which maps to the user/agency)
  const { data: sub } = await supabase
    .from("billing_subscriptions")
    .select("plan_key, status")
    .eq("agency_id", user.id)
    .maybeSingle();

  if (!sub) {
    // Trial: allow up to 3 free scans
    const { data: trialScans } = await supabase
      .from("sottra_scans")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    const count = (trialScans as unknown as { count: number })?.count ?? 0;
    if (count >= 3) return new Response(JSON.stringify({ limit_reached: true, error: "Trial esaurito. Abbonati per continuare." }), { headers: CORS });
    return new Response(JSON.stringify({ ok: true, scans_remaining: 3 - count }), { headers: CORS });
  }

  if (sub.status !== "active" && sub.status !== "trialing") {
    return new Response(JSON.stringify({ limit_reached: true, error: "Abbonamento non attivo." }), { headers: CORS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: CORS });
});
