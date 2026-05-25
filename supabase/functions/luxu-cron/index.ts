import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CORE_BASE = Deno.env.get("SUPABASE_URL")?.replace(".supabase.co", ".supabase.co/functions/v1") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const scanRunId = `cron_${new Date().toISOString().slice(0, 10)}_${Date.now()}`;

  try {
    // STEP 1 — Scan
    const scanRes = await fetch(`${CORE_BASE}/luxuradar-scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ limit: 100 }),
    });

    if (!scanRes.ok) {
      throw new Error(`Scan failed: ${scanRes.status}`);
    }

    const scanData = await scanRes.json();
    const assets = scanData?.data?.assets ?? scanData?.assets ?? [];

    if (assets.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "Scan returned 0 assets", scan_run_id: scanRunId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // STEP 2 — Persist
    const persistRes = await fetch(`${CORE_BASE}/luxu-persist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ assets, scan_run_id: scanRunId }),
    });

    const persistData = await persistRes.json();

    return new Response(
      JSON.stringify({
        ok: true,
        scan_run_id: scanRunId,
        assets_scanned: assets.length,
        persist_result: persistData,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err), scan_run_id: scanRunId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
