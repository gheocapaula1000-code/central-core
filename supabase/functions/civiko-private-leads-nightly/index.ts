// civiko-private-leads-nightly
// Orchestratore notturno per fonti lead privati.
// Stato 2026-06-20: SOLO Subito.it (Bakeca disattivata — volume troppo basso, 14 annunci).
//
// Calendario settimanale di sampling:
//   - Lunedì + Giovedì (UTC): full pull (max 1200 items, ~$1.80) — copertura ampia.
//   - Martedì, Mercoledì, Venerdì, Sabato, Domenica: incremental (max 200 items, ~$0.30)
//     Subito ordina per data discendente, quindi 200 items intercetta i nuovi annunci.
//   Costo stimato a regime: ~$20/mese, cap mensile $25 (vedi privateLeadsBudget.ts).
//
// 1. Verifica budget mensile.
// 2. Sceglie modalità (full/incremental) in base al giorno UTC.
// 3. Lancia Subito tramite padova-apify-multi-launch.
// 4. Aggiorna private_leads_run_status per la visibilità in cron-health.
//
// Schedulato ogni notte alle 02:25 UTC via pg_cron.
// Rispetta operational_mode: in saving mode skippa se gate non aperto.
// Skip soft (non blocca altri cron) se cap superato.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getPrivateLeadsBudget, recordPrivateLeadsSpend } from "../_shared/privateLeadsBudget.ts";
import { shouldRunHeavyCron } from "../_shared/heavyCronGate.ts";

// URL Subito filtrato per soli annunci di privati (?is=t = "inserzionista privato"),
// percorso regionale Veneto con filtro città Padova (verificato 2026-06-20: il path
// annunci-padova/...?is=t restituisce 0 risultati sull'actor, il path Veneto+padova/?is=t
// è l'unico che funziona).
const SUBITO_URL = "https://www.subito.it/annunci-veneto/vendita/immobili/padova/?is=t";

// Sampling settimanale. Override possibile via body {mode:"full"|"incremental"}.
const FULL_DAYS_UTC = new Set([1, 4]); // 1=Lun, 4=Gio
const FULL_MAX_ITEMS = 1200;
const FULL_EST_COST = 1.80;     // ~1200 × $0.0015
const FULL_COST_CAP = 2.50;
const INC_MAX_ITEMS = 200;
const INC_EST_COST = 0.30;       // ~200 × $0.0015
const INC_COST_CAP = 0.50;

function pickMode(override?: string): { mode: "full" | "incremental"; max_items: number; est_cost: number; cost_cap: number } {
  if (override === "full" || override === "incremental") {
    return override === "full"
      ? { mode: "full", max_items: FULL_MAX_ITEMS, est_cost: FULL_EST_COST, cost_cap: FULL_COST_CAP }
      : { mode: "incremental", max_items: INC_MAX_ITEMS, est_cost: INC_EST_COST, cost_cap: INC_COST_CAP };
  }
  const dow = new Date().getUTCDay();
  return FULL_DAYS_UTC.has(dow)
    ? { mode: "full", max_items: FULL_MAX_ITEMS, est_cost: FULL_EST_COST, cost_cap: FULL_COST_CAP }
    : { mode: "incremental", max_items: INC_MAX_ITEMS, est_cost: INC_EST_COST, cost_cap: INC_COST_CAP };
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(
    supaUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const started = Date.now();
  const result: Record<string, unknown> = {};

  // Heavy cron gate (saving mode rispetta heavy_cron_every_n_days)
  const gate = await shouldRunHeavyCron();
  if (!gate.run) {
    await sb.from("private_leads_run_status").insert([
      { source: "subito", opportunita_totali: 0, privato_stanco_count: 0, status: "skipped", error_message: `gate: ${gate.reason}`, duration_ms: 0 },
    ]);
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: gate.reason, gate }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Budget guard (ora dedicato a Subito)
  const budget = await getPrivateLeadsBudget();
  if (budget.reached) {
    const reason = `private_leads_monthly_cap_reached (${budget.total_usd.toFixed(2)}/${budget.cap_usd} USD)`;
    await sb.from("private_leads_run_status").insert([
      { source: "subito", opportunita_totali: 0, privato_stanco_count: 0, status: "skipped", error_message: reason, duration_ms: 0 },
    ]);
    console.warn("[private-leads-nightly]", reason);
    return new Response(JSON.stringify({ ok: true, skipped: true, reason, budget }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Subito tramite padova-apify-multi-launch ---
  try {
    const r = await fetch(`${supaUrl}/functions/v1/padova-apify-multi-launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
      body: JSON.stringify({
        subito_full: {
          search_url: SUBITO_URL,
          max_items: 1200,
          cost_cap_usd: 1.5,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    result.subito = j;

    if (r.ok && Array.isArray((j as { launched?: unknown[] }).launched)) {
      await recordPrivateLeadsSpend("apify", SUBITO_EST_COST);
      // Conteggi reali arrivano async dall'actor → status iniziale
      await sb.from("private_leads_run_status").insert({
        source: "subito",
        opportunita_totali: 0,
        privato_stanco_count: 0,
        status: "launched",
        error_message: null,
        duration_ms: Date.now() - started,
        notes: { launched: j, only_private_url: true, search_url: SUBITO_URL, est_usd: SUBITO_EST_COST },
      });
    } else {
      await sb.from("private_leads_run_status").insert({
        source: "subito",
        opportunita_totali: 0,
        privato_stanco_count: 0,
        status: "error",
        error_message: `launch_failed_${r.status}`,
        duration_ms: Date.now() - started,
        notes: j,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.subito = { error: msg };
    await sb.from("private_leads_run_status").insert({
      source: "subito",
      opportunita_totali: 0,
      privato_stanco_count: 0,
      status: "error",
      error_message: msg.slice(0, 500),
      duration_ms: Date.now() - started,
    });
  }

  // --- Bakeca DISATTIVATA 2026-06-20 ---
  // Motivazione: solo 14 annunci privati totali su Padova provincia (verificato sul vivo).
  // Volume troppo basso per giustificare il costo Firecrawl. Mercato presidiato da
  // agenzie e Dove.it / Tecnocasa. Riattivabile rimuovendo questo blocco e ripristinando
  // is_active=true in civiko_data_sources(bakeca_padova_privati).
  // try {
  //   const r = await fetch(`${supaUrl}/functions/v1/civiko-bakeca-scrape`, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
  //     body: JSON.stringify({ trigger: "nightly" }),
  //   });
  //   result.bakeca = await r.json().catch(() => ({}));
  // } catch (e) {
  //   const msg = e instanceof Error ? e.message : String(e);
  //   result.bakeca = { error: msg };
  // }

  return new Response(JSON.stringify({
    ok: true,
    duration_ms: Date.now() - started,
    budget_before: budget,
    result,
    bakeca_disabled_since: "2026-06-20",
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
