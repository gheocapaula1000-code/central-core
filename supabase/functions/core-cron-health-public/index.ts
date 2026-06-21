// core-cron-health-public
// Endpoint pubblico (no auth) che espone lo stato dei 6 cron Core e produce
// alert in cron_alerts_pending per job fermi da > 36h. Solo dati operativi.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type JobKind = "daily" | "frequent" | "weekly";

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
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const names = CORE_JOBS.map((j) => j.jobname);

    // ultime esecuzioni (più recente per job)
    const { data: logs } = await sb
      .from("cron_executions_log")
      .select("job_name, status, triggered_at, completed_at, error_message")
      .in("job_name", names)
      .order("triggered_at", { ascending: false })
      .limit(500);

    const lastByJob = new Map<string, any>();
    for (const r of logs ?? []) {
      if (!lastByJob.has(r.job_name)) lastByJob.set(r.job_name, r);
    }

    // metriche reali ultimi 7 giorni
    const since7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

    // private_leads_run_status per i 3 lead-jobs
    const { data: leadRuns } = await sb
      .from("private_leads_run_status")
      .select("source, last_run_at, opportunita_totali, privato_stanco_count, notes")
      .gte("last_run_at", since7d);

    const subitoRuns = (leadRuns ?? []).filter((r: any) => r.source === "subito_full" || r.source === "subito" || (r.source ?? "").startsWith("subito"));
    const classifyRuns = (leadRuns ?? []).filter((r: any) => r.source === "classify" || r.source === "private_leads_classify");
    const snapshotRuns = (leadRuns ?? []).filter((r: any) => r.source === "price_snapshot");

    // contendibili: totale corrente
    const { count: contendibiliCount } = await sb
      .from("padova_contendibili")
      .select("id", { count: "exact", head: true });

    // padova listings totali (proxy radar)
    const { count: listingsCount } = await sb
      .from("padova_listings")
      .select("id", { count: "exact", head: true });

    const nowMs = Date.now();
    const STALE_HOURS = 36;
    const alerts: { job: string; ore: number }[] = [];

    const STUCK_MINUTES = 30;
    const jobs = CORE_JOBS.map((j) => {
      const last = lastByJob.get(j.jobname);
      const lastTs = last?.triggered_at ? new Date(last.triggered_at).getTime() : null;
      const ageH = lastTs ? (nowMs - lastTs) / 3_600_000 : null;
      const lastOk = last?.status === "success";
      const lastFailed = last?.status === "failure";
      // run rimasto in 'started' troppo a lungo: trattalo come fallito stuck
      const isStuck = last?.status === "started" && lastTs !== null && (nowMs - lastTs) / 60_000 > STUCK_MINUTES;
      const effectiveError = lastFailed
        ? (last?.error_message ?? "Errore registrato senza messaggio")
        : isStuck
          ? `Run bloccato in stato "started" da oltre ${STUCK_MINUTES} min — worker probabilmente interrotto o timeout senza cattura.`
          : null;
      let stato: "SANO" | "WARNING" | "CRITICO";
      if (!lastTs) stato = "WARNING";
      else if (ageH! > STALE_HOURS || lastFailed || isStuck) stato = "CRITICO";
      else if (ageH! > 26 || last?.status === "started") stato = "WARNING";
      else stato = "SANO";

      if (ageH !== null && ageH > STALE_HOURS) alerts.push({ job: j.jobname, ore: Math.round(ageH) });

      let ultimi7gg: Record<string, unknown> = {};
      switch (j.jobname) {
        case "civiko-private-leads-nightly":
          ultimi7gg = {
            run: subitoRuns.length,
            annunci_grezzi_totali: subitoRuns.reduce((s, r: any) => s + (r.opportunita_totali ?? 0), 0),
          };
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
          ultimi7gg = { esecuzioni: (logs ?? []).filter((l: any) => l.job_name === j.jobname).length };
          break;
      }

      return {
        jobname: j.jobname,
        descrizione_leggibile: j.descrizione_leggibile,
        schedule_cron: j.schedule_attesa,
        prossima_esecuzione_utc: nextRunUtc(j.schedule_attesa),
        ultima_esecuzione_utc: last?.triggered_at ?? null,
        ultima_esecuzione_esito: last ? (lastOk ? "OK" : (lastFailed ? "FAILED" : (isStuck ? "STUCK" : "IN_CORSO"))) : null,
        ultimo_errore: effectiveError,
        stato,
        ultimi_7gg_risultati: ultimi7gg,
      };
    });

    // watchdog interno: alert per ogni job fermo > 36h
    for (const a of alerts) {
      // dedup grezza: niente alert duplicato non-ack per stesso source nelle ultime 12h
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
          message: `Cron Core "${a.job}" fermo da ${a.ore}h (soglia ${STALE_HOURS}h).`,
        });
      }
    }

    const summary = {
      sani: jobs.filter((j) => j.stato === "SANO").length,
      warning: jobs.filter((j) => j.stato === "WARNING").length,
      critici: jobs.filter((j) => j.stato === "CRITICO").length,
    };

    return new Response(
      JSON.stringify({
        ok: true,
        generato_il: new Date().toISOString(),
        soglia_stallo_ore: STALE_HOURS,
        riepilogo: summary,
        alert_emessi_ora: alerts.length,
        jobs,
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
