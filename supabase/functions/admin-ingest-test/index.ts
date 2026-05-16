// ═══════════════════════════════════════════════════════════════
// admin-ingest-test — proxy admin-only verso ingest-opportunity
// Verifica JWT + ruolo admin, poi inoltra il payload aggiungendo
// l'header x-job-secret server-side (mai esposto al frontend).
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: { code: "unauthorized", message: "missing bearer token" } });
  }

  // verifica utente + ruolo admin
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json(401, { error: { code: "unauthorized", message: "invalid token" } });
  }

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: isAdmin, error: roleErr } = await svc.rpc("has_role", {
    _user_id: userData.user.id,
    _role: "admin",
  });
  if (roleErr || !isAdmin) {
    return json(403, { error: { code: "forbidden", message: "admin role required" } });
  }

  let payload: unknown;
  try { payload = await req.json(); } catch {
    return json(400, { error: { code: "bad_json" } });
  }

  // forward a ingest-opportunity col job secret
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-opportunity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "apikey": SERVICE_KEY,
      "x-job-secret": JOB_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
