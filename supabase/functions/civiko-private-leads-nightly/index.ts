// civiko-private-leads-nightly
// Orchestratore notturno per fonti lead privati (Subito.it + Bakeca.it).
// 1. Verifica budget combinato mensile ($8 cap soft).
// 2. Lancia Subito tramite padova-apify-multi-launch (only_private=true).
// 3. Lancia Bakeca tramite civiko-bakeca-scrape.
// 4. Aggiorna private_leads_run_status per la visibilità in cron-health.
//
// Schedulato ogni notte alle 02:25 UTC via pg_cron.
// Rispetta operational_mode: in saving mode skippa se gate non aperto.
// Skip soft (non blocca altri cron) se cap superato.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getPrivateLeadsBudget, recordPrivateLeadsSpend } from "../_shared/privateLeadsBudget.ts";
import { shouldRunHeavyCron } from "../_shared/heavyCronGate.ts";

const SUBITO_URL = "https://www.subito.it/annunci-padova/vendita/immobili/padova/";
const SUBITO_EST_COST = 1.0; // USD stimato per run subito_full (max_items 1000)

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
      { source: "bakeca", opportunita_totali: 0, privato_stanco_count: 0, status: "skipped", error_message: `gate: ${gate.reason}`, duration_ms: 0 },
    ]);
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: gate.reason, gate }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Budget guard combinato
  const budget = await getPrivateLeadsBudget();
  if (budget.reached) {
    const reason = `private_leads_monthly_cap_reached (${budget.total_usd.toFixed(2)}/${budget.cap_usd} USD)`;
    await sb.from("private_leads_run_status").insert([
      { source: "subito", opportunita_totali: 0, privato_stanco_count: 0, status: "skipped", error_message: reason, duration_ms: 0 },
      { source: "bakeca", opportunita_totali: 0, privato_stanco_count: 0, status: "skipped", error_message: reason, duration_ms: 0 },
    ]);
    console.warn("[private-leads-nightly]", reason);
    return new Response(JSON.stringify({ ok: true, skipped: true, reason, budget }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- 1. Subito tramite padova-apify-multi-launch ---
  try {
    const r = await fetch(`${supaUrl}/functions/v1/padova-apify-multi-launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
      body: JSON.stringify({
        subito_full: {
          search_url: SUBITO_URL,
          max_items: 600,
          cost_cap_usd: 1.0,
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
        notes: { launched: j, only_private: true, est_usd: SUBITO_EST_COST },
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

  // --- 2. Bakeca tramite civiko-bakeca-scrape (sync, scrive il proprio status) ---
  try {
    const r = await fetch(`${supaUrl}/functions/v1/civiko-bakeca-scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
      body: JSON.stringify({ trigger: "nightly" }),
    });
    result.bakeca = await r.json().catch(() => ({}));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.bakeca = { error: msg };
  }

  return new Response(JSON.stringify({
    ok: true,
    duration_ms: Date.now() - started,
    budget_before: budget,
    result,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
