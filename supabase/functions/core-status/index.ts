// core-status — admin-only synthetic status of Central Core
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const VERSION = "v3.4.0";

const DEPLOYED_FUNCTIONS = [
  "health", "core-status", "connector-status",
  "sottra", "ecosystem-gateway", "viral-core", "ai-core-run",
  "listing-bridge", "omi-import", "omi-import-storage",
  "omi-geometry-import", "istat-ispra-import", "istat-sdmx-fetch",
  "core-proxy", "property-detail",
  "civiko-property-source-profile", "civiko-property-hyperlocal-signals",
  "civiko-property-zona-in-movimento", "civiko-property-piano-esclusiva",
  "civiko-property-owner-report", "civiko-property-objection-plan",
  "civiko-property-from-photo",
  "civiko-billing", "civiko-radar-veneto", "civiko-content-studio",
  "civiko-admin-secrets",
  "record-scan", "create-checkout", "check-subscription",
];

function getOwnerEmails(): string[] {
  const raw = Deno.env.get("CORE_ADMIN_BOOTSTRAP_EMAILS") ?? "";
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const token = auth.replace("Bearer ", "").trim();
    const { data: userData, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !userData.user) return json({ error: "Unauthorized" }, 401);

    const email = (userData.user.email ?? "").toLowerCase();
    const isOwner = getOwnerEmails().includes(email);
    let isAdmin = isOwner;
    if (!isAdmin) {
      const { data: role } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("role", "admin")
        .maybeSingle();
      isAdmin = !!role;
    }
    if (!isAdmin) return json({ error: "Forbidden" }, 403);

    // Best-effort: count active jobs from ingestion_runs if table exists
    let active_jobs: number | null = null;
    let recent_errors: number | null = null;
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await supabase
        .from("ingestion_runs")
        .select("id", { count: "exact", head: true })
        .eq("status", "running");
      active_jobs = count ?? 0;
      const { count: errCount } = await supabase
        .from("ingestion_runs")
        .select("id", { count: "exact", head: true })
        .eq("status", "error")
        .gte("created_at", since);
      recent_errors = errCount ?? 0;
    } catch { /* table may not exist */ }

    return json({
      ok: true,
      service: "central-core",
      status: "healthy",
      version: VERSION,
      checked_at: new Date().toISOString(),
      functions_deployed: DEPLOYED_FUNCTIONS,
      functions_count: DEPLOYED_FUNCTIONS.length,
      active_jobs,
      recent_errors_24h: recent_errors,
      viewer: { role: isOwner ? "owner" : "admin" },
    });
  } catch (e) {
    console.error("core-status unhandled:", e);
    return json({ error: "Errore temporaneo" }, 500);
  }
});
