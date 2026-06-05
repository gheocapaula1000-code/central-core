// run-offmarket-chain-admin
// Admin-protected proxy: verifies the caller is an authenticated admin via JWT,
// then invokes the 5 off-market derivation jobs sequentially server-side
// using CENTRAL_CORE_JOB_SECRET so the browser never sees the secret.

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

const JOBS = [
  "padova-daily-radar",
  "build-padova-early-warning",
  "discover-early-offmarket-signals",
  "offmarket-padova",
  "build-offmarket-opportunity-scores",
];

const JOB_TIMEOUT_MS = 240_000; // 4 minutes per job

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

  if (!SUPABASE_URL || !ANON || !SERVICE) {
    return json({ ok: false, error: "config_missing" }, 500);
  }
  if (!JOB_SECRET) {
    return json({ ok: false, error: "CENTRAL_CORE_JOB_SECRET not configured" }, 500);
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

  const base = SUPABASE_URL.replace(/\/+$/, "");
  const t0 = Date.now();
  const steps: Array<{
    job: string;
    http_status: number;
    ok: boolean;
    excerpt?: string;
    error?: string;
    duration_ms: number;
  }> = [];

  for (const job of JOBS) {
    const url = `${base}/functions/v1/civiko-radar-veneto/jobs/${job}`;
    const start = Date.now();
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-job-secret": JOB_SECRET,
        },
        body: JSON.stringify({ triggered_by: "manual_admin_chain" }),
        signal: controller.signal,
      });
      const txt = await r.text();
      steps.push({
        job,
        http_status: r.status,
        ok: r.status >= 200 && r.status < 300,
        excerpt: txt.slice(0, 500),
        duration_ms: Date.now() - start,
      });
    } catch (e) {
      steps.push({
        job,
        http_status: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - start,
      });
    } finally {
      clearTimeout(to);
    }
  }

  return json(
    {
      ok: steps.every((s) => s.ok),
      invoked_by: userData.user.email ?? userId,
      steps,
      total_duration_ms: Date.now() - t0,
    },
    200,
  );
});
