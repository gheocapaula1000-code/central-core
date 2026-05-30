// civiko-force-backfill-admin
// Admin-protected proxy: verifies the caller is an authenticated admin via JWT,
// then invokes civiko-force-backfill server-side with DIAGNOSTIC_SECRET so the
// browser never sees the secret.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const DIAG = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";

  if (!SUPABASE_URL || !ANON || !SERVICE) {
    return json({ ok: false, error: "config_missing" }, 500);
  }
  if (!DIAG) {
    return json({ ok: false, error: "DIAGNOSTIC_SECRET not configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "missing_bearer" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }
  const userId = userData.user.id;

  const adminClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false },
  });
  const { data: roleData, error: roleErr } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (roleErr || !roleData) {
    return json({ ok: false, error: "forbidden_not_admin" }, 403);
  }

  const t0 = Date.now();
  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/civiko-force-backfill`;
  let status = 0;
  let body: unknown = null;
  let error: string | null = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-diagnostic-secret": DIAG,
      },
      body: JSON.stringify({}),
    });
    status = r.status;
    const txt = await r.text();
    try { body = JSON.parse(txt); } catch { body = txt; }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return json({
    ok: status >= 200 && status < 300,
    invoked_by: userData.user.email ?? userId,
    backfill_status: status,
    backfill_error: error,
    backfill_report: body,
    duration_ms: Date.now() - t0,
  }, 200);
});
