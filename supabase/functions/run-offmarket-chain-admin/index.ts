// run-offmarket-chain-admin
// Admin-protected fire-and-forget proxy: verifies admin via JWT, then queues
// the 5 off-market derivation jobs in background and returns immediately.

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
  "build-advanced-veneto-opportunities",
];

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
  const invokedBy = userData.user.email ?? userId;

  const runChain = async () => {
    console.log(`[offmarket-chain] start invoked_by=${invokedBy}`);
    for (const job of JOBS) {
      const url = `${base}/functions/v1/civiko-radar-veneto/jobs/${job}`;
      const start = Date.now();
      const needsWriteParams =
        job === "discover-early-offmarket-signals" || job === "offmarket-padova";
      const jobBody = needsWriteParams
        ? {
            triggered_by: "manual_admin_chain",
            saveCandidates: true,
            dryRun: false,
            usePerplexityDiscovery: true,
          }
        : { triggered_by: "manual_admin_chain" };
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-job-secret": JOB_SECRET,
          },
          body: JSON.stringify(jobBody),
        });
        const txt = await r.text();
        console.log(
          `[offmarket-chain] job=${job} status=${r.status} ok=${r.ok} duration_ms=${Date.now() - start} excerpt=${txt.slice(0, 300)}`,
        );
      } catch (e) {
        console.error(
          `[offmarket-chain] job=${job} ERROR after ${Date.now() - start}ms: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    console.log(`[offmarket-chain] done invoked_by=${invokedBy}`);
  };

  const task = runChain();
  // @ts-ignore EdgeRuntime available in Supabase Edge Runtime
  const ert = (globalThis as any).EdgeRuntime;
  if (ert?.waitUntil) ert.waitUntil(task); else task.catch(() => {});

  return json({
    ok: true,
    started: true,
    invoked_by: invokedBy,
    message:
      "Catena off-market avviata in background. I 5 job girano lato server (alcuni minuti). Ricarica i contatori tra qualche minuto.",
    jobs: JOBS,
  }, 202);
});
