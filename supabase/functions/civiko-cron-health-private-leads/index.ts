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
        display_label: "Subito Padova: in attesa primo run",
      };
    }
    // deno-lint-ignore no-explicit-any
    const d = data as any;
    const tot = d.opportunita_totali ?? 0;
    const st = d.privato_stanco_count ?? 0;
    const label = `Subito Padova: ${tot} opportunità trovate, ${st} privato_stanco`;
    return { source, ...d, display_label: label };
  }

  // Fonti disattivate (esposte come tile informativo)
  const { data: disattivateRows } = await sb
    .from("civiko_data_sources")
    .select("code, label, is_active, notes, updated_at")
    .in("code", [
      "aste_giudiziarie",
      "aste_giudiziarie_veneto",
      "tribunale_padova",
      "tribunale_venezia",
      "tribunale_verona",
      "bakeca_padova_privati",
    ]);

  const [subito, budget] = await Promise.all([
    lastRun("subito"),
    getPrivateLeadsBudget(),
  ]);

  const motiviDisattivazione: Record<string, string> = {
    bakeca_padova_privati: "Solo 14 annunci privati su tutta Padova provincia: volume troppo basso per giustificare il costo.",
  };

  // Calendario settimanale di sampling Subito (UTC)
  const giorniIt = ["domenica","lunedì","martedì","mercoledì","giovedì","venerdì","sabato"];
  const fullDays = new Set([1, 4]);
  const calendario_settimanale = giorniIt.map((g, i) => ({
    giorno: g,
    dow_utc: i,
    modalita: fullDays.has(i) ? "full" : "incremental",
    max_annunci: fullDays.has(i) ? 1200 : 200,
    costo_stimato_usd: fullDays.has(i) ? 1.80 : 0.30,
  }));
  const dowOggi = new Date().getUTCDay();

  return new Response(JSON.stringify({
    ok: true,
    generated_at: new Date().toISOString(),
    fonti_attive: [subito],
    fonti_disattivate: (disattivateRows ?? []).map((r) => ({
      code: r.code,
      label: r.label,
      stato: r.is_active ? "attiva" : "disattivata",
      motivo: motiviDisattivazione[r.code]
        ?? "Mercato verticale già presidiato. Aste non producono incarichi di vendita per agenti immobiliari.",
      disattivata_il: r.updated_at,
    })),
    sampling_subito: {
      strategia: "Full pull lunedì + giovedì (1200 annunci, ~$1.80). Incremental martedì-mercoledì-venerdì-sabato-domenica (200 annunci, ~$0.30).",
      costo_mensile_stimato_usd: 20,
      cap_mensile_usd: budget.cap_usd,
      calendario_settimanale,
      modalita_oggi: fullDays.has(dowOggi) ? "full" : "incremental",
      prossimo_orario_utc: "02:25",
    },
    classificazione_subito: {
      job: "civiko-private-leads-classify",
      orario_utc: "02:50",
      descrizione: "Classifica i lead privati estratti da Subito in 'privato' o 'privato_stanco' (anzianità >=60 giorni o ribasso >=5%) e li sincronizza nell'elenco lead Padova prima delle 05:00.",
    },
    snapshot_prezzi_subito: {
      job: "civiko-private-leads-price-snapshot",
      orario_utc: "03:00",
      descrizione: "Salva lo snapshot giornaliero del prezzo dei lead Subito e promuove a 'privato_stanco' gli annunci con almeno 7 giorni di storia e ribasso cumulato >=5% dal massimo storico.",
    },
    budget_mensile_subito: budget,
  }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
});


