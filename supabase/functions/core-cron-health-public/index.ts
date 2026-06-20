// core-cron-health-public
// Endpoint pubblico (no auth) che espone lo stato dei 6 cron Core e produce
// alert in cron_alerts_pending per job fermi da > 36h. Solo dati operativi.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type CoreJob = {
  jobname: string;
  descrizione_leggibile: string;
  schedule_attesa: string;
};

const CORE_JOBS: CoreJob[] = [
  { jobname: "nightly-data-refresh-master",       descrizione_leggibile: "Aggiornamento notturno dati master",         schedule_attesa: "0 2 * * *" },
  { jobname: "padova-daily-radar",                descrizione_leggibile: "Radar giornaliero Padova",                  schedule_attesa: "5 2 * * *" },
  { jobname: "padova-contendibili-recompute",     descrizione_leggibile: "Ricalcolo immobili contendibili Padova",    schedule_attesa: "15 3 * * *" },
  { jobname: "civiko-private-leads-nightly",      descrizione_leggibile: "Estrazione notturna lead privati",          schedule_attesa: "25 2 * * *" },
  { jobname: "civiko-private-leads-classify",     descrizione_leggibile: "Classificazione lead privati",              schedule_attesa: "50 2 * * *" },
  { jobname: "civiko-private-leads-price-snapshot", descrizione_leggibile: "Fotografia prezzi lead privati",          schedule_attesa: "0 3 * * *" },
];

// piccolo decoder per i pattern usati dai cron Core (tutti minuti/ore fissi)
function nextRunUtc(schedule: string): string | null {
  const m = schedule.trim().match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const hh = parseInt(m[2], 10);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
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

    const jobs = CORE_JOBS.map((j) => {
      const last = lastByJob.get(j.jobname);
      const lastTs = last?.triggered_at ? new Date(last.triggered_at).getTime() : null;
      const ageH = lastTs ? (nowMs - lastTs) / 3_600_000 : null;
      const lastOk = last?.status === "success";
      let stato: "SANO" | "WARNING" | "CRITICO";
      if (!lastTs) stato = "WARNING";
      else if (ageH! > STALE_HOURS || !lastOk) stato = "CRITICO";
      else if (ageH! > 26) stato = "WARNING";
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
        ultima_esecuzione_esito: last ? (lastOk ? "OK" : "FAILED") : null,
        ultimo_errore: last?.error_message ?? null,
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
