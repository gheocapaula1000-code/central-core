// core-cron-health-public
// Diagnostica operativa interna sui cron Core + fonti scheduler.
// Checkpoint 1A: NON è anonimamente pubblica — 401 senza x-diagnostic-secret
// è il comportamento atteso. Fail-closed da DIAGNOSTIC_SECRET prima di
// qualunque client service-role, lettura DB o scrittura in cron_alerts_pending.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireDiagnosticSecret, makeDebugId } from "../_shared/http.ts";
import {
  AUTOMATED_TRIGGERS,
  SOURCE_PLAN,
  classifySourceRow,
} from "../_shared/sourceScheduler.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-diagnostic-secret",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};


type JobKind = "daily" | "frequent" | "weekly" | "monthly";

type CoreJob = {
  jobname: string;
  descrizione_leggibile: string;
  schedule_attesa: string;
  kind: JobKind;
  warning_ore: number;
  critico_ore: number;
  source: "executions_log" | "cron_catalog";
};

const CORE_JOBS: CoreJob[] = [
  // ─── Cron Core storici (executions_log) ──────────────────────────────────
  { jobname: "nightly-data-refresh-master",         descrizione_leggibile: "Aggiornamento notturno dati master",     schedule_attesa: "0 2 * * *",   kind: "daily",    warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "padova-daily-radar",                  descrizione_leggibile: "Radar giornaliero Padova",               schedule_attesa: "5 2 * * *",   kind: "daily",    warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "padova-contendibili-recompute",       descrizione_leggibile: "Ricalcolo immobili contendibili Padova", schedule_attesa: "15 3 * * *",  kind: "daily",    warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "civiko-private-leads-nightly",        descrizione_leggibile: "Estrazione notturna lead privati",       schedule_attesa: "25 2 * * *",  kind: "daily",    warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "civiko-private-leads-classify",       descrizione_leggibile: "Classificazione lead privati",           schedule_attesa: "50 2 * * *",  kind: "daily",    warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "civiko-private-leads-price-snapshot", descrizione_leggibile: "Fotografia prezzi lead privati",         schedule_attesa: "0 3 * * *",   kind: "daily",    warning_ore: 26, critico_ore: 36, source: "executions_log" },
  // ─── Cron pipeline agenzie (catalogo cron) ───────────────────────────────
  { jobname: "padova-agencies-soft-0400",   descrizione_leggibile: "Pipeline agenzie — soft 04:00 (Roma)",            schedule_attesa: "0 2 * * *",   kind: "daily",    warning_ore: 26,     critico_ore: 30,     source: "cron_catalog" },
  { jobname: "padova-agencies-soft-1100",   descrizione_leggibile: "Pipeline agenzie — soft 11:00 (Roma)",            schedule_attesa: "0 9 * * *",   kind: "daily",    warning_ore: 26,     critico_ore: 30,     source: "cron_catalog" },
  { jobname: "padova-agencies-soft-1530",   descrizione_leggibile: "Pipeline agenzie — soft 15:30 (Roma)",            schedule_attesa: "30 13 * * *", kind: "daily",    warning_ore: 26,     critico_ore: 30,     source: "cron_catalog" },
  { jobname: "padova-agencies-full-sunday", descrizione_leggibile: "Pipeline agenzie — full settimanale (domenica)",  schedule_attesa: "0 1 * * 0",   kind: "weekly",   warning_ore: 24 * 8, critico_ore: 24 * 9, source: "cron_catalog" },
  { jobname: "padova-agencies-finalize",    descrizione_leggibile: "Pipeline agenzie — finalize (ogni 20 min)",       schedule_attesa: "*/20 * * * *",kind: "frequent", warning_ore: 40 / 60, critico_ore: 1,     source: "cron_catalog" },
  // ─── Cron radar Padova Central Core (executions_log) ─────────────────────
  { jobname: "central-core-radar-padova-nightly-full", descrizione_leggibile: "Radar Padova — full notturno (Central Core)", schedule_attesa: "0 3 * * *",   kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "central-core-radar-padova-soft",         descrizione_leggibile: "Radar Padova — soft (Central Core)",          schedule_attesa: "0 2 * * *",   kind: "daily", warning_ore: 14, critico_ore: 24, source: "executions_log" },
  { jobname: "central-core-radar-arpav-weekly",        descrizione_leggibile: "ARPAV aria → territorial_signals (Padova)",  schedule_attesa: "20 4 * * 0",  kind: "weekly", warning_ore: 24 * 8, critico_ore: 24 * 9, source: "executions_log" },
  { jobname: "central-core-radar-ckan-weekly",         descrizione_leggibile: "ANAC/CKAN → territorial_signals (Padova)",   schedule_attesa: "35 4 * * 0",  kind: "weekly", warning_ore: 24 * 8, critico_ore: 24 * 9, source: "executions_log" },
  { jobname: "central-core-radar-aste-daily",          descrizione_leggibile: "Aste giudiziarie Padova (F16)",              schedule_attesa: "10 4 * * *",  kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "istat-sdmx-monthly",                     descrizione_leggibile: "ISTAT SDMX comuni Veneto",                    schedule_attesa: "0 4 1 * *",   kind: "monthly", warning_ore: 24 * 35, critico_ore: 24 * 40, source: "executions_log" },
  { jobname: "istat-demografia-monthly",               descrizione_leggibile: "ISTAT demografia segnali Padova",             schedule_attesa: "0 5 1 * *",   kind: "monthly", warning_ore: 24 * 35, critico_ore: 24 * 40, source: "executions_log" },
  { jobname: "official-osm-cantieri",                  descrizione_leggibile: "OSM cantieri Padova + cintura",               schedule_attesa: "30 4 * * 1",  kind: "weekly",  warning_ore: 24 * 8, critico_ore: 24 * 10, source: "executions_log" },
  { jobname: "official-pnrr-padova",                   descrizione_leggibile: "OpenPNRR opere Padova",                       schedule_attesa: "0 5 * * 1",   kind: "weekly",  warning_ore: 24 * 8, critico_ore: 24 * 10, source: "executions_log" },
  { jobname: "official-obituaries-aggregate",          descrizione_leggibile: "Necrologi aggregato F19 (k>=3)",              schedule_attesa: "30 4 * * *",  kind: "daily",   warning_ore: 36, critico_ore: 48, source: "executions_log" },
  { jobname: "portal-immobiliare-padova",               descrizione_leggibile: "Portale Immobiliare.it Padova",               schedule_attesa: "0 2 * * *",   kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "portal-idealista-padova",                 descrizione_leggibile: "Portale Idealista Padova",                    schedule_attesa: "10 2 * * *",  kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "portal-subito-padova",                    descrizione_leggibile: "Portale Subito Padova",                       schedule_attesa: "20 2 * * *",  kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "portal-casa-padova",                      descrizione_leggibile: "Portale Casa.it Padova",                      schedule_attesa: "30 2 * * *",  kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "portal-collect-pending",                  descrizione_leggibile: "Promozione run Apify in padova_listings",     schedule_attesa: "45 2 * * *",  kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "portal-collect-pending-drain",            descrizione_leggibile: "Drain run Apify pending ogni 15 minuti",      schedule_attesa: "*/15 * * * *",kind: "frequent", warning_ore: 1, critico_ore: 2, source: "executions_log" },
  { jobname: "portal-subito-promote",                   descrizione_leggibile: "Promote staging Subito → collect v2",         schedule_attesa: "50 2,3 * * *", kind: "frequent", warning_ore: 14, critico_ore: 26, source: "executions_log" },
  { jobname: "apify-subito-weekly",                     descrizione_leggibile: "Subito Padova weekly Apify launch",           schedule_attesa: "30 3 * * 0",  kind: "weekly", warning_ore: 24 * 8, critico_ore: 24 * 9, source: "executions_log" },
  { jobname: "padova-listings-contendibili-recompute",  descrizione_leggibile: "Ricalcolo contendibili dopo i portali",     schedule_attesa: "15 3 * * *",  kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "expire-stale-scrape-jobs",                descrizione_leggibile: "Watchdog: timeout job scrape stuck running", schedule_attesa: "*/15 * * * *", kind: "frequent", warning_ore: 40 / 60, critico_ore: 1, source: "executions_log" },
  { jobname: "civiko-bakeca-scrape",                    descrizione_leggibile: "Bakeca privati Padova (Firecrawl, timeout)", schedule_attesa: "35 2 * * *", kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  { jobname: "official-sue-padova",                     descrizione_leggibile: "SUE / cantieri Padova (F18)",                 schedule_attesa: "0 5 2 * *",  kind: "monthly", warning_ore: 24 * 35, critico_ore: 24 * 40, source: "executions_log" },
  { jobname: "official-piano-regolatore",               descrizione_leggibile: "Piano regolatore PAT/PI Padova",              schedule_attesa: "20 5 2 * *", kind: "monthly", warning_ore: 24 * 35, critico_ore: 24 * 40, source: "executions_log" },
  { jobname: "official-sentiment-refresh",              descrizione_leggibile: "Refresh microzone_sentiment per zona",       schedule_attesa: "40 5 * * *", kind: "daily", warning_ore: 26, critico_ore: 36, source: "executions_log" },
  // ─── Source scheduler (civiko-scheduler + dedicated source crons) ────────
  { jobname: "civiko-scheduler-daily",                 descrizione_leggibile: "Scheduler fonti — pass due-only giornaliero", schedule_attesa: "15 2 * * *",  kind: "daily",    warning_ore: 26,     critico_ore: 36,     source: "executions_log" },
  { jobname: "civiko-scheduler-weekly",                descrizione_leggibile: "Scheduler fonti — pass settimanale",          schedule_attesa: "30 3 * * 1",  kind: "weekly",   warning_ore: 24 * 8, critico_ore: 24 * 9, source: "executions_log" },
  { jobname: "connector-osm-cantieri-weekly",          descrizione_leggibile: "OSM cantieri Padova (F5)",                    schedule_attesa: "0 5 * * 1",   kind: "weekly",   warning_ore: 24 * 8, critico_ore: 24 * 9, source: "executions_log" },
  { jobname: "civiko-pnrr-padova-weekly",              descrizione_leggibile: "OpenPNRR Padova (F11)",                       schedule_attesa: "15 5 * * 1",  kind: "weekly",   warning_ore: 24 * 8, critico_ore: 24 * 9, source: "executions_log" },
  { jobname: "civiko-obituaries-aggregate-daily",      descrizione_leggibile: "Necrologi aggregati (F19)",                   schedule_attesa: "30 4 * * *",  kind: "daily",    warning_ore: 26,     critico_ore: 36,     source: "executions_log" },
];

// decoder per i pattern usati dai cron Core
function nextRunUtc(schedule: string): string | null {
  const s = schedule.trim();
  const every = s.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (every) {
    const step = parseInt(every[1], 10);
    const now = new Date();
    const nextMin = (Math.floor(now.getUTCMinutes() / step) + 1) * step;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0));
    next.setUTCMinutes(nextMin);
    return next.toISOString();
  }
  const daily = s.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (daily) {
    const mm = parseInt(daily[1], 10), hh = parseInt(daily[2], 10);
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  const weekly = s.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+(\d)$/);
  if (weekly) {
    const mm = parseInt(weekly[1], 10), hh = parseInt(weekly[2], 10), dow = parseInt(weekly[3], 10);
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
    const delta = (dow - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + delta);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 7);
    return next.toISOString();
  }
  const monthly = s.match(/^(\d+)\s+(\d+)\s+(\d+)\s+\*\s+\*$/);
  if (monthly) {
    const mm = parseInt(monthly[1], 10), hh = parseInt(monthly[2], 10), day = parseInt(monthly[3], 10);
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hh, mm, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
    return next.toISOString();
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const authFail = requireDiagnosticSecret(req, makeDebugId());
  if (authFail) return authFail;



  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const namesLog = CORE_JOBS.filter((j) => j.source === "executions_log").map((j) => j.jobname);
    const namesCat = CORE_JOBS.filter((j) => j.source === "cron_catalog").map((j) => j.jobname);
    const diagnostics_errors: Array<{ source: string; message: string }> = [];

    // 1) ultime esecuzioni dai job che scrivono in cron_executions_log
    const { data: logs, error: logsErr } = await sb
      .from("cron_executions_log")
      .select("job_name, status, triggered_at, completed_at, error_message")
      .in("job_name", namesLog.length ? namesLog : ["__none__"])
      .order("triggered_at", { ascending: false })
      .limit(500);
    if (logsErr) diagnostics_errors.push({ source: "cron_executions_log", message: logsErr.message });

    const lastByJob = new Map<string, { status: string | null; triggered_at: string | null; error_message: string | null }>();
    for (const r of logs ?? []) {
      if (!lastByJob.has(r.job_name)) {
        lastByJob.set(r.job_name, {
          status: r.status, triggered_at: r.triggered_at, error_message: r.error_message,
        });
      }
    }

    // 2) ultime esecuzioni dai cron del catalogo (pipeline agenzie)
    if (namesCat.length) {
      const { data: catRows, error: catErr } = await sb.rpc("get_cron_job_last_runs", { p_job_names: namesCat });
      if (catErr) diagnostics_errors.push({ source: "get_cron_job_last_runs", message: catErr.message });
      for (const r of (catRows ?? []) as any[]) {
        // mappa lo stato cron.job_run_details → schema cron_executions_log
        const st = r.status === "succeeded" ? "success"
                 : r.status === "failed"    ? "failure"
                 : r.status === "running"   ? "started"
                 : (r.status ?? null);
        lastByJob.set(r.jobname, {
          status: st,
          triggered_at: r.start_time,
          error_message: (st === "failure") ? (r.return_message ?? "Errore cron senza messaggio") : null,
        });
      }
    }

    // metriche reali ultimi 7 giorni
    const since7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

    const { data: leadRuns } = await sb
      .from("private_leads_run_status")
      .select("source, last_run_at, opportunita_totali, privato_stanco_count, notes")
      .gte("last_run_at", since7d);

    const subitoRuns = (leadRuns ?? []).filter((r: any) => (r.source ?? "").startsWith("subito"));
    const classifyRuns = (leadRuns ?? []).filter((r: any) => r.source === "classify" || r.source === "private_leads_classify");
    const snapshotRuns = (leadRuns ?? []).filter((r: any) => r.source === "price_snapshot");

    const { count: contendibiliCount } = await sb
      .from("padova_contendibili").select("id", { count: "exact", head: true });
    const { count: listingsCount } = await sb
      .from("padova_listings").select("id", { count: "exact", head: true });

    // metriche pipeline agenzie ultimi 7 giorni
    const { data: agencyRuns } = await sb
      .from("pipeline_runs")
      .select("id, mode, status, started_at, finished_at, cost_usd")
      .gte("started_at", since7d)
      .order("started_at", { ascending: false });
    const agencySoft = (agencyRuns ?? []).filter((r: any) => r.mode === "soft");
    const agencyFull = (agencyRuns ?? []).filter((r: any) => r.mode === "full");
    const agencyCostUsd7d = (agencyRuns ?? []).reduce((s, r: any) => s + (Number(r.cost_usd) || 0), 0);

    // ─── Delta snapshot Padova (per classificazione SANO/PARZIALE/ESEGUITO_SENZA_DATI) ───
    // Scope vendibile Civiko One: SOLO Padova Comune, 22 zone OMI ufficiali.
    // I 7 comuni precedenti sono stati dismessi: nessun comune limitrofo.
    const PADOVA_COMUNI = ["Padova"];
    const OMI_ZONES_EXPECTED = 22;
    const sinceFull = new Date(Date.now() - 26 * 3_600_000).toISOString();
    const sinceSoft = new Date(Date.now() - 14 * 3_600_000).toISOString();
    const fullDelta = new Map<string, number>();
    const softDelta = new Map<string, number>();
    const sourceDeltaFull: Record<string, number> = {};
    const sourceDeltaSoft: Record<string, number> = {};
    {
      const { data: rowsFull } = await sb
        .from("listing_price_snapshots")
        .select("municipality, source, created_at")
        .ilike("municipality", "padova")
        .gte("created_at", sinceFull);
      for (const r of rowsFull ?? []) {
        const m = String(r.municipality ?? "");
        fullDelta.set(m, (fullDelta.get(m) ?? 0) + 1);
        const src = String(r.source ?? "unknown");
        sourceDeltaFull[src] = (sourceDeltaFull[src] ?? 0) + 1;
        if (new Date(r.created_at).getTime() >= new Date(sinceSoft).getTime()) {
          softDelta.set(m, (softDelta.get(m) ?? 0) + 1);
          sourceDeltaSoft[src] = (sourceDeltaSoft[src] ?? 0) + 1;
        }
      }
    }

    // Breakdown per zona OMI ufficiale (point-in-polygon su omi_zone_geometry).
    let omiBreakdownFull: Array<{ omi_zone_code: string; fascia: string; zona_descr: string; snapshot_count: number }> = [];
    let omiBreakdownSoft: typeof omiBreakdownFull = [];
    let omiZonesWithDataFull = 0;
    let omiZonesWithDataSoft = 0;
    try {
      const { data: bF } = await sb.rpc("padova_omi_snapshot_breakdown", { p_since: sinceFull });
      omiBreakdownFull = (bF ?? []).map((r: any) => ({
        omi_zone_code: r.omi_zone_code, fascia: r.fascia, zona_descr: r.zona_descr,
        snapshot_count: Number(r.snapshot_count ?? 0),
      }));
      omiZonesWithDataFull = omiBreakdownFull.filter((r) => r.snapshot_count > 0).length;
      const { data: bS } = await sb.rpc("padova_omi_snapshot_breakdown", { p_since: sinceSoft });
      omiBreakdownSoft = (bS ?? []).map((r: any) => ({
        omi_zone_code: r.omi_zone_code, fascia: r.fascia, zona_descr: r.zona_descr,
        snapshot_count: Number(r.snapshot_count ?? 0),
      }));
      omiZonesWithDataSoft = omiBreakdownSoft.filter((r) => r.snapshot_count > 0).length;
    } catch (_e) { /* RPC non disponibile: lascia array vuoti */ }


    const nowMs = Date.now();
    const STUCK_MINUTES = 30;
    const alerts: { job: string; ore: number; soglia: number }[] = [];

    const jobs = CORE_JOBS.map((j) => {
      const last = lastByJob.get(j.jobname);
      const lastTs = last?.triggered_at ? new Date(last.triggered_at).getTime() : null;
      const ageH = lastTs ? (nowMs - lastTs) / 3_600_000 : null;
      const lastOk = last?.status === "success";
      const lastFailed = last?.status === "failure";
      const isStuck = last?.status === "started" && lastTs !== null && (nowMs - lastTs) / 60_000 > STUCK_MINUTES;
      const effectiveError = lastFailed
        ? (last?.error_message ?? "Errore registrato senza messaggio")
        : isStuck
          ? `Run bloccato in stato "started" da oltre ${STUCK_MINUTES} min — worker probabilmente interrotto o timeout senza cattura.`
          : null;

      let stato: "SANO" | "WARNING" | "CRITICO" | "PARZIALE" | "ESEGUITO_SENZA_DATI" | "ATTIVO_MA_MAI_ESEGUITO" | "ERRORE";
      if (!lastTs) stato = "ATTIVO_MA_MAI_ESEGUITO";
      else if (lastFailed || isStuck) stato = "ERRORE";
      else if (ageH! > j.critico_ore) stato = "CRITICO";
      else if (ageH! > j.warning_ore || last?.status === "started") stato = "WARNING";
      else stato = "SANO";

      if (ageH !== null && ageH > j.critico_ore) {
        alerts.push({ job: j.jobname, ore: Math.round(ageH * 10) / 10, soglia: j.critico_ore });
      }

      let ultimi7gg: Record<string, unknown> = {};
      switch (j.jobname) {
        case "civiko-private-leads-nightly":
          ultimi7gg = { run: subitoRuns.length, annunci_grezzi_totali: subitoRuns.reduce((s, r: any) => s + (r.opportunita_totali ?? 0), 0) };
          break;
        case "civiko-private-leads-classify":
          ultimi7gg = {
            run: classifyRuns.length,
            lead_classificati_totali: classifyRuns.reduce((s, r: any) => s + (r.opportunita_totali ?? 0), 0),
            privato_stanco_totali: classifyRuns.reduce((s, r: any) => s + (r.privato_stanco_count ?? 0), 0),
          };
          break;
        case "civiko-private-leads-price-snapshot":
          ultimi7gg = {
            run: snapshotRuns.length,
            snapshot_prezzi_totali: snapshotRuns.reduce((s, r: any) => s + (r.opportunita_totali ?? 0), 0),
            promossi_privato_stanco: snapshotRuns.reduce((s, r: any) => s + (r.privato_stanco_count ?? 0), 0),
          };
          break;
        case "padova-contendibili-recompute":
          ultimi7gg = { contendibili_correnti: contendibiliCount ?? 0 };
          break;
        case "padova-daily-radar":
          ultimi7gg = { annunci_padova_totali: listingsCount ?? 0 };
          break;
        case "nightly-data-refresh-master":
        case "istat-sdmx-monthly":
        case "istat-demografia-monthly":
        case "official-osm-cantieri":
        case "official-pnrr-padova":
        case "official-obituaries-aggregate":
        case "portal-immobiliare-padova":
        case "portal-idealista-padova":
        case "portal-subito-padova":
        case "portal-casa-padova":
        case "portal-collect-pending":
        case "portal-collect-pending-drain":
        case "portal-subito-promote":
        case "apify-subito-weekly":
        case "padova-listings-contendibili-recompute":
        case "expire-stale-scrape-jobs":
        case "central-core-radar-arpav-weekly":
        case "central-core-radar-ckan-weekly":
        case "central-core-radar-aste-daily":
        case "civiko-scheduler-daily":
        case "civiko-scheduler-weekly":
        case "connector-osm-cantieri-weekly":
        case "civiko-pnrr-padova-weekly":
        case "civiko-obituaries-aggregate-daily":
          ultimi7gg = { esecuzioni: (logs ?? []).filter((l: any) => l.job_name === j.jobname).length };
          break;
        case "padova-agencies-soft-0400":
        case "padova-agencies-soft-1100":
        case "padova-agencies-soft-1530":
          ultimi7gg = { run_soft_totali: agencySoft.length, costo_apify_usd_7gg: Math.round(agencyCostUsd7d * 100) / 100 };
          break;
        case "padova-agencies-full-sunday":
          ultimi7gg = { run_full_totali: agencyFull.length, ultimo_full_started_at: agencyFull[0]?.started_at ?? null };
          break;
        case "padova-agencies-finalize":
          ultimi7gg = { run_pipeline_chiusi_7gg: (agencyRuns ?? []).filter((r: any) => r.status === "done").length };
          break;
        case "central-core-radar-padova-nightly-full":
        case "central-core-radar-padova-soft": {
          const isSoft = j.jobname === "central-core-radar-padova-soft";
          const deltaMap = isSoft ? softDelta : fullDelta;
          const totalDelta = (deltaMap.get("Padova") ?? 0) + (deltaMap.get("padova") ?? 0);
          const omiZonesWithData = isSoft ? omiZonesWithDataSoft : omiZonesWithDataFull;
          const omiBreakdown = isSoft ? omiBreakdownSoft : omiBreakdownFull;
          const sourceBreakdown = isSoft ? sourceDeltaSoft : sourceDeltaFull;
          ultimi7gg = {
            scope: "padova_omi_zones",
            municipality: "Padova",
            finestra_ore: isSoft ? 14 : 26,
            snapshot_totali: totalDelta,
            omi_zones_expected: OMI_ZONES_EXPECTED,
            omi_zones_with_data: omiZonesWithData,
            snapshot_per_source: sourceBreakdown,
            snapshot_per_omi_zone: omiBreakdown,
          };
          // Override stato in base al delta dati reale (solo se base non è già ERRORE/CRITICO)
          if (stato === "SANO" || stato === "WARNING") {
            if (totalDelta === 0) stato = "ESEGUITO_SENZA_DATI";
            else if (omiZonesWithData < Math.ceil(OMI_ZONES_EXPECTED / 2)) stato = "PARZIALE";
          }
          break;
        }
      }

      return {
        jobname: j.jobname,
        descrizione_leggibile: j.descrizione_leggibile,
        schedule_cron: j.schedule_attesa,
        tipo: j.kind,
        soglia_warning_ore: j.warning_ore,
        soglia_critico_ore: j.critico_ore,
        prossima_esecuzione_utc: nextRunUtc(j.schedule_attesa),
        ultima_esecuzione_utc: last?.triggered_at ?? null,
        ultima_esecuzione_esito: last ? (lastOk ? "OK" : (lastFailed ? "FAILED" : (isStuck ? "STUCK" : "IN_CORSO"))) : null,
        ultimo_errore: effectiveError,
        stato,
        ultimi_7gg_risultati: ultimi7gg,
      };
    });

    // watchdog interno: alert per ogni job oltre la propria soglia critica
    for (const a of alerts) {
      const { data: dup } = await sb
        .from("cron_alerts_pending")
        .select("id")
        .eq("source", a.job)
        .is("acknowledged_at", null)
        .gte("created_at", new Date(Date.now() - 12 * 3_600_000).toISOString())
        .limit(1);
      if (!dup || dup.length === 0) {
        await sb.from("cron_alerts_pending").insert({
          severity: "critico",
          source: a.job,
          message: `Cron Core "${a.job}" fermo da ${a.ore}h (soglia critica ${a.soglia}h).`,
        });
      }
    }

    // Source registry: last_error / stale for every automated source.
    // Query errors stay visible — cron jobs still report independently.
    let fonti: Array<Record<string, unknown>> = [];
    const fonti_riepilogo = { sani: 0, errore: 0, stale: 0, mai_eseguiti: 0 };
    let fonti_read_error: string | null = null;
    try {
      const automatedCodes = Object.values(SOURCE_PLAN)
        .filter((p) => p.automation_status === "automated" || p.automation_status === "semi_automated")
        .map((p) => p.code);
      const { data: srcRows, error: srcErr } = await sb
        .from("civiko_source_registry")
        .select("source_code, last_run_at, last_success_at, last_error, record_count, next_run_at, stale_after_days, automation_status")
        .in("source_code", automatedCodes);
      if (srcErr) {
        fonti_read_error = srcErr.message;
        diagnostics_errors.push({ source: "civiko_source_registry", message: srcErr.message });
      }
      const byCode = new Map((srcRows ?? []).map((r: Record<string, unknown>) => [String(r.source_code), r]));
      fonti = automatedCodes.map((code) => {
        const plan = SOURCE_PLAN[code];
        const row = byCode.get(code) ?? {};
        const stato = classifySourceRow({
          last_run_at: (row.last_run_at as string | null) ?? null,
          last_success_at: (row.last_success_at as string | null) ?? null,
          last_error: (row.last_error as string | null) ?? null,
          stale_after_days: plan.stale_after_days,
        });
        if (stato === "SANO") fonti_riepilogo.sani++;
        else if (stato === "ERRORE") fonti_riepilogo.errore++;
        else if (stato === "STALE") fonti_riepilogo.stale++;
        else fonti_riepilogo.mai_eseguiti++;
        const trigger = AUTOMATED_TRIGGERS[code] ?? null;
        return {
          source_code: code,
          automation_status: plan.automation_status,
          scheduler_frequency: plan.scheduler_frequency,
          job: plan.job ?? null,
          ingestion_endpoint: plan.ingestion_endpoint ?? null,
          trigger,
          last_run_at: row.last_run_at ?? null,
          last_success_at: row.last_success_at ?? null,
          last_error: row.last_error ?? null,
          record_count: row.record_count ?? null,
          next_run_at: row.next_run_at ?? null,
          stato,
        };
      });
    } catch (e) {
      fonti_read_error = e instanceof Error ? e.message : String(e);
      diagnostics_errors.push({ source: "civiko_source_registry", message: fonti_read_error });
      fonti = [];
    }

    const summary = {
      sani: jobs.filter((j) => j.stato === "SANO").length,
      warning: jobs.filter((j) => j.stato === "WARNING").length,
      critici: jobs.filter((j) => j.stato === "CRITICO").length,
      parziali: jobs.filter((j) => j.stato === "PARZIALE").length,
      eseguiti_senza_dati: jobs.filter((j) => j.stato === "ESEGUITO_SENZA_DATI").length,
      mai_eseguiti: jobs.filter((j) => j.stato === "ATTIVO_MA_MAI_ESEGUITO").length,
      errore: jobs.filter((j) => j.stato === "ERRORE").length,
    };

    return new Response(
      JSON.stringify({
        ok: true,
        generato_il: new Date().toISOString(),
        scope: {
          name: "padova_omi_zones",
          municipality: "Padova",
          comuni: ["Padova"],
          province: ["PD"],
          omi_zones_expected: OMI_ZONES_EXPECTED,
          omi_zones_with_data_soft_14h: omiZonesWithDataSoft,
          omi_zones_with_data_full_26h: omiZonesWithDataFull,
        },
        totale_cron_monitorati: jobs.length,
        soglie_per_tipo: {
          daily: { warning_ore: 26, critico_ore: "26-36" },
          frequent: { warning_min: 40, critico_min: 60 },
          weekly: { warning_giorni: 8, critico_giorni: 9 },
        },
        riepilogo: summary,
        alert_emessi_ora: alerts.length,
        diagnostics_errors,
        jobs,
        fonti_scheduler: {
          auth_note: "Questo endpoint richiede x-diagnostic-secret. 401 senza secret è atteso (Checkpoint 1A).",
          read_error: fonti_read_error,
          riepilogo: fonti_riepilogo,
          fonti,
        },
      }),
      { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
