// ═══════════════════════════════════════════════════════════════
// Edge function: civiko-data-sources
// ───────────────────────────────────────────────────────────────
// GET /civiko/data-sources
//   → ritorna il registro fonti, raggruppato per stato e categoria.
//   → legge SEMPRE da public.civiko_data_sources (sorgente di verità).
//   → mai chiama fonti esterne (è solo un registro/manifesto).
//   → enforce: fonti manual_or_phase_2 non possono comparire come "connected".
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

interface SourceRow {
  code: string;
  label: string;
  description: string | null;
  category: "free" | "premium" | "manual_or_phase_2";
  status:
    | "connected" | "connectable" | "account_required"
    | "manual" | "not_yet_available" | "phase_2";
  provider: string | null;
  base_url: string | null;
  env_var: string | null;
  coverage: string | null;
  requires_premium_consent: boolean;
  estimated_cost_eur: number | null;
  notes: string | null;
  display_order: number;
}

function debugId(): string {
  return `cds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function envelope(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "X-Core-Function": "civiko-data-sources" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return envelope({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use GET" } }, 405);
  }

  const did = debugId();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return envelope({
      ok: false, debug_id: did,
      error: { code: "BACKEND_NOT_CONFIGURED", message: "Service role not available" },
    }, 500);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from("civiko_data_sources")
    .select(
      "code,label,description,category,status,provider,base_url,env_var,coverage,requires_premium_consent,estimated_cost_eur,notes,display_order",
    )
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (error) {
    console.error("[civiko-data-sources] query error", error.message);
    return envelope({
      ok: false, debug_id: did,
      error: { code: "QUERY_FAILED", message: "Unable to load registry" },
    }, 500);
  }

  const sources = (data ?? []) as SourceRow[];

  // Enforce hard rule: nessuna manual_or_phase_2 deve apparire come connected.
  const warnings: string[] = [];
  const sanitized = sources.map((s) => {
    if (s.category === "manual_or_phase_2" && s.status === "connected") {
      warnings.push(`source ${s.code} reclassified: manual_or_phase_2 cannot be 'connected'`);
      return { ...s, status: "phase_2" as const };
    }
    return s;
  });

  // Raggruppamenti
  const byStatus: Record<string, SourceRow[]> = {
    connected: [], connectable: [], account_required: [],
    manual: [], not_yet_available: [], phase_2: [],
  };
  const byCategory: Record<string, SourceRow[]> = {
    free: [], premium: [], manual_or_phase_2: [],
  };
  for (const s of sanitized) {
    (byStatus[s.status] ??= []).push(s);
    (byCategory[s.category] ??= []).push(s);
  }

  const counts = {
    total: sanitized.length,
    by_status: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length])),
    by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
  };

  return envelope({
    ok: true,
    debug_id: did,
    data: {
      generated_at: new Date().toISOString(),
      counts,
      by_status: byStatus,
      by_category: byCategory,
      sources: sanitized,
    },
    warnings,
  });
});
