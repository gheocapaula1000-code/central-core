// civiko-cron-health-private-leads
// Endpoint GET di sola lettura: espone lo stato delle fonti lead private (Subito + Bakeca)
// + budget combinato, per la sezione fonti notturne del cron-health.
// Pubblico in lettura (nessun dato sensibile, solo aggregati).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getPrivateLeadsBudget } from "../_shared/privateLeadsBudget.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  async function lastRun(source: string) {
    const { data } = await sb
      .from("private_leads_run_status")
      .select("last_run_at, opportunita_totali, privato_stanco_count, status, error_message, duration_ms")
      .eq("source", source)
      .order("last_run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) {
      return {
        source,
        last_run_at: null,
        opportunita_totali: 0,
        privato_stanco_count: 0,
        status: "in_attesa_primo_run",
        error_message: null,
        duration_ms: null,
        display_label: source === "subito"
          ? "Subito Padova: in attesa primo run"
          : "Bakeca Padova: in attesa primo run",
      };
    }
    // deno-lint-ignore no-explicit-any
    const d = data as any;
    const tot = d.opportunita_totali ?? 0;
    const st = d.privato_stanco_count ?? 0;
    const label = source === "subito"
      ? `Subito Padova: ${tot} opportunità trovate, ${st} privato_stanco`
      : `Bakeca Padova: ${tot} opportunità trovate, ${st} privato_stanco`;
    return { source, ...d, display_label: label };
  }

  // Aste disattivate (esposte come tile)
  const { data: asteRows } = await sb
    .from("civiko_data_sources")
    .select("code, label, is_active, notes, updated_at")
    .in("code", ["aste_giudiziarie", "aste_giudiziarie_veneto", "tribunale_padova", "tribunale_venezia", "tribunale_verona"]);

  const [subito, bakeca, budget] = await Promise.all([
    lastRun("subito"),
    lastRun("bakeca"),
    getPrivateLeadsBudget(),
  ]);

  return new Response(JSON.stringify({
    ok: true,
    generated_at: new Date().toISOString(),
    fonti_attive: [subito, bakeca],
    fonti_disattivate: (asteRows ?? []).map((r) => ({
      code: r.code,
      label: r.label,
      stato: r.is_active ? "attiva" : "disattivata",
      motivo: "Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari.",
      disattivata_il: r.updated_at,
    })),
    budget_mensile_combinato: budget,
  }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
});
