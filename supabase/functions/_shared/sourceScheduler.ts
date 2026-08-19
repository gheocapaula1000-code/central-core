// _shared/sourceScheduler.ts
// Authoritative scheduler manifest for the Civiko F1–F22 catalog.
// This is the contract the source registry MUST stay in sync with.
// "automation_status" reflects the REAL ingestion path in this repo.
// Manual fallback is honest, not a placeholder for fake automation.

export type AutomationStatus =
  | "automated"
  | "semi_automated"
  | "manual_fallback"
  | "premium_on_demand"
  | "disabled";

export type SchedulerFrequency =
  | "daily" | "weekly" | "monthly" | "quarterly"
  | "semiannual" | "annual" | "on_demand";

export interface SourcePlan {
  code: string;
  automation_status: AutomationStatus;
  scheduler_frequency: SchedulerFrequency;
  stale_after_days: number | null;
  job?: string;                // scheduler_job_name (edge function or module) when real
  ingestion_endpoint?: string; // logical path to trigger ingestion (admin or scheduled)
  cross_check_enabled?: boolean;
  automation_todo?: string;    // required when automation_status === 'manual_fallback'
  notes: string;
}

export const SOURCE_PLAN: Record<string, SourcePlan> = {
  F1:  { code: "F1",  automation_status: "manual_fallback",   scheduler_frequency: "semiannual", stale_after_days: 200, ingestion_endpoint: "/civiko-source-registry/import/omi", cross_check_enabled: true,  automation_todo: "Automate AdE OMI semiannual download (or ondata GitHub mirror).", notes: "OMI: target auto AdE export; fallback CSV via civiko-source-registry." },
  F2:  { code: "F2",  automation_status: "automated",         scheduler_frequency: "monthly",    stale_after_days: 60,  job: "istat-sdmx-fetch", ingestion_endpoint: "/istat-sdmx-fetch", cross_check_enabled: true, notes: "ISTAT SDMX DCIS_POPRES1." },
  F3:  { code: "F3",  automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/apr4", cross_check_enabled: true,  automation_todo: "Add monitored downloader for ISTAT APR4 (demo.istat.it) when stable URL is available.", notes: "APR4 iscritti/cancellati: manual import; target monitored downloader." },
  F4:  { code: "F4",  automation_status: "manual_fallback",   scheduler_frequency: "monthly",    stale_after_days: 60,  ingestion_endpoint: "/civiko-source-registry/import/padova-elderly", cross_check_enabled: true,  automation_todo: "Add validated PDF/CSV parser for Comune di Padova elderly stats.", notes: "Padova elderly: manual CSV today; target PDF/CSV parser." },
  F5:  { code: "F5",  automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "connector-osm-cantieri", ingestion_endpoint: "/connector-osm-cantieri", cross_check_enabled: true, notes: "OSM Overpass live." },
  F6:  { code: "F6",  automation_status: "semi_automated",    scheduler_frequency: "quarterly",  stale_after_days: 120, job: "istat-ispra-import", ingestion_endpoint: "/istat-ispra-import", cross_check_enabled: true, automation_todo: "Switch from storage import to live WFS pull.", notes: "ISPRA: storage import today; target WFS auto." },
  F7:  { code: "F7",  automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/jobs/import-arpav-air-quality", cross_check_enabled: true, automation_todo: "Add automated noise dataset path when public source is identified.", notes: "ARPAV air + environmental importer. Triggered by civiko-scheduler-weekly." },
  F8:  { code: "F8",  automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/mim-schools", cross_check_enabled: true,  automation_todo: "Wire MIM open-data CSV downloader (annual).", notes: "MIM schools: manual; target open-data CSV." },
  F9:  { code: "F9",  automation_status: "manual_fallback",   scheduler_frequency: "quarterly",  stale_after_days: 120, ingestion_endpoint: "/civiko-source-registry/import/infratel", cross_check_enabled: true,  automation_todo: "Wire Infratel BUL API refresh.", notes: "Infratel: manual; target API." },
  F10: { code: "F10", automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/jobs/import-veneto-open-data", cross_check_enabled: true, notes: "ANAC/open-data Veneto via CKAN importer. Triggered by civiko-scheduler-weekly." },
  F11: { code: "F11", automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "civiko-pnrr-padova", ingestion_endpoint: "/civiko-pnrr-padova", cross_check_enabled: true, notes: "OpenPNRR live." },
  F12: { code: "F12", automation_status: "manual_fallback",   scheduler_frequency: "monthly",    stale_after_days: 90,  ingestion_endpoint: "/civiko-source-registry/import/market-benchmark", cross_check_enabled: true,  automation_todo: "No compliant Borsino/FIAIP machine endpoint. Keep admin-only manual import.", notes: "Borsino/FIAIP: no compliant API → admin import only." },
  F13: { code: "F13", automation_status: "semi_automated",    scheduler_frequency: "monthly",    stale_after_days: 60,  job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/portalScrapers/quotations", cross_check_enabled: true, automation_todo: "Label as listing-derived; flag clearly vs F1 official OMI.", notes: "Immobiliare quotations derived from listings; labelled separately." },
  F14: { code: "F14", automation_status: "premium_on_demand", scheduler_frequency: "on_demand",  stale_after_days: null, ingestion_endpoint: "/civiko-premium-catasto", cross_check_enabled: false, notes: "Catasto: premium only, no mass automation." },
  F15: { code: "F15", automation_status: "premium_on_demand", scheduler_frequency: "on_demand",  stale_after_days: null, ingestion_endpoint: "/civiko-premium-conservatoria", cross_check_enabled: false, notes: "Conservatoria: premium only, no mass automation." },
  F16: { code: "F16", automation_status: "automated",         scheduler_frequency: "daily",      stale_after_days: 3,   job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/jobs/refresh-padova-auctions", cross_check_enabled: true, notes: "Padova auctions refresh (astegiudiziarie.it). PVP stays manual_only." },
  F17: { code: "F17", automation_status: "manual_fallback",   scheduler_frequency: "quarterly",  stale_after_days: 180, ingestion_endpoint: "/civiko-source-registry/import/ape-veneto", cross_check_enabled: true,  automation_todo: "Confirm Regione Veneto APE official endpoint and wire downloader. AI estimate stays separate.", notes: "Veneto APE: manual official; AI estimate stays separate, never labelled official." },
  F18: { code: "F18", automation_status: "manual_fallback",   scheduler_frequency: "monthly",    stale_after_days: 60,  ingestion_endpoint: "/civiko-source-registry/import/sue-padova", cross_check_enabled: false, automation_todo: "No stable public SUE endpoint; admin manual import only.", notes: "SUE Padova: manual with compliance_verified flag." },
  F19: { code: "F19", automation_status: "automated",         scheduler_frequency: "daily",      stale_after_days: 7,   job: "civiko-obituaries-aggregate", ingestion_endpoint: "/civiko-obituaries-aggregate", cross_check_enabled: false, notes: "Aggregate-only via civiko-obituaries-aggregate, k>=3, visible_to_pwa=false." },
  F20: { code: "F20", automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/apr4-mobility", cross_check_enabled: true,  automation_todo: "Share downloader with F3 once stable APR4 source is wired.", notes: "APR4 mobility: manual; target same as F3." },
  F21: { code: "F21", automation_status: "automated",         scheduler_frequency: "daily",      stale_after_days: 3,   job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/jobs/deep-scan-padova", cross_check_enabled: true, notes: "Portals + ribassiPortali via deep-scan-padova; portal-* pg_cron jobs also run nightly." },
  F22: { code: "F22", automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/istat-separations", cross_check_enabled: true,  automation_todo: "Switch to ISTAT SDMX once dataset id is confirmed.", notes: "ISTAT separations: manual; target SDMX." },
};

const FREQUENCY_DAYS: Record<SchedulerFrequency, number | null> = {
  daily: 1, weekly: 7, monthly: 30, quarterly: 90,
  semiannual: 182, annual: 365, on_demand: null,
};

export function nextRunAfter(freq: SchedulerFrequency, from = new Date()): Date | null {
  const d = FREQUENCY_DAYS[freq];
  if (d == null) return null;
  return new Date(from.getTime() + d * 86_400_000);
}

export function isStale(lastSuccessAt: string | Date | null, staleAfterDays: number | null): boolean {
  if (!lastSuccessAt || staleAfterDays == null) return false;
  const t = lastSuccessAt instanceof Date ? lastSuccessAt.getTime() : Date.parse(String(lastSuccessAt));
  if (!Number.isFinite(t)) return false;
  const ageDays = (Date.now() - t) / 86_400_000;
  return ageDays > staleAfterDays;
}

/** Padova comune centroid — used when F11 (OpenPNRR) needs coords. */
export const PADOVA_CENTER = { lat: 45.4064, lng: 11.8768 };

export type SourceHealthStato = "SANO" | "ERRORE" | "STALE" | "MAI_ESEGUITO";

export interface TriggerSpec {
  /** pg_cron jobname (and cron_executions_log.job_name). */
  cron_job: string;
  /** UTC crontab. */
  schedule: string;
  /** Edge path POSTed by the trigger. */
  endpoint: string;
}

/**
 * Real HTTP trigger for every automated source.
 * Shared jobs (civiko-scheduler-*) still isolate per-source last_error.
 */
export const AUTOMATED_TRIGGERS: Record<string, TriggerSpec> = {
  F2:  { cron_job: "istat-sdmx-monthly",                 schedule: "0 4 1 * *",  endpoint: "/istat-sdmx-fetch" },
  F5:  { cron_job: "connector-osm-cantieri-weekly",      schedule: "0 5 * * 1",  endpoint: "/connector-osm-cantieri" },
  F7:  { cron_job: "civiko-scheduler-weekly",            schedule: "30 3 * * 1", endpoint: "/civiko-radar-veneto/jobs/import-arpav-air-quality" },
  F10: { cron_job: "civiko-scheduler-weekly",            schedule: "30 3 * * 1", endpoint: "/civiko-radar-veneto/jobs/import-veneto-open-data" },
  F11: { cron_job: "civiko-pnrr-padova-weekly",          schedule: "15 5 * * 1", endpoint: "/civiko-pnrr-padova" },
  F16: { cron_job: "nightly-data-refresh-master",        schedule: "0 2 * * *",  endpoint: "/civiko-radar-veneto/jobs/refresh-padova-auctions" },
  F19: { cron_job: "civiko-obituaries-aggregate-daily",  schedule: "30 4 * * *", endpoint: "/civiko-obituaries-aggregate" },
  F21: { cron_job: "nightly-data-refresh-master",        schedule: "0 2 * * *",  endpoint: "/civiko-radar-veneto/jobs/deep-scan-padova" },
};

/** All 22 codes must be present. Defensive sanity used by tests + boot. */
export function assertManifestComplete(): void {
  for (let i = 1; i <= 22; i++) {
    const code = `F${i}`;
    if (!SOURCE_PLAN[code]) throw new Error(`SOURCE_PLAN missing ${code}`);
  }
}

/** Every automated source must declare a job, endpoint, and a real trigger. */
export function assertAutomatedHaveTriggers(): void {
  for (const p of Object.values(SOURCE_PLAN)) {
    if (p.automation_status !== "automated") continue;
    if (!p.job) throw new Error(`${p.code} automated without job`);
    if (!p.ingestion_endpoint) throw new Error(`${p.code} automated without ingestion_endpoint`);
    const t = AUTOMATED_TRIGGERS[p.code];
    if (!t?.cron_job || !t.schedule || !t.endpoint) {
      throw new Error(`${p.code} automated without AUTOMATED_TRIGGERS entry`);
    }
    if (t.endpoint !== p.ingestion_endpoint) {
      throw new Error(`${p.code} trigger endpoint ${t.endpoint} != plan ${p.ingestion_endpoint}`);
    }
  }
}

export function classifySourceRow(args: {
  last_run_at: string | null | undefined;
  last_success_at: string | null | undefined;
  last_error: string | null | undefined;
  stale_after_days: number | null | undefined;
}): SourceHealthStato {
  const err = typeof args.last_error === "string" ? args.last_error.trim() : "";
  if (err) return "ERRORE";
  if (!args.last_run_at && !args.last_success_at) return "MAI_ESEGUITO";
  if (isStale(args.last_success_at ?? null, args.stale_after_days ?? null)) return "STALE";
  return "SANO";
}
