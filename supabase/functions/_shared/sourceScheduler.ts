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

/** A = official public ingest. C = portal scrapers (fail-closed, never mixed). */
export type PipelineClass = "A" | "C" | "premium" | "other";

export interface SourcePlan {
  code: string;
  pipeline_class: PipelineClass;
  automation_status: AutomationStatus;
  scheduler_frequency: SchedulerFrequency;
  stale_after_days: number | null;
  job?: string;                // scheduler_job_name (edge function or module) when real
  ingestion_endpoint?: string; // logical path to trigger ingestion (admin or scheduled)
  write_table?: string;        // primary table written by a successful run
  cross_check_enabled?: boolean;
  automation_todo?: string;    // required when automation_status === 'manual_fallback'
  notes: string;
}

export const SOURCE_PLAN: Record<string, SourcePlan> = {
  F1:  { code: "F1",  pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "semiannual", stale_after_days: 200, ingestion_endpoint: "/civiko-source-registry/import/omi", write_table: "omi_zone / omi_valori", cross_check_enabled: true,  automation_todo: "Automate AdE OMI semiannual download (or ondata GitHub mirror).", notes: "OMI: target auto AdE export; fallback CSV via civiko-source-registry." },
  F2:  { code: "F2",  pipeline_class: "A", automation_status: "automated",         scheduler_frequency: "monthly",    stale_after_days: 60,  job: "istat-sdmx-fetch", ingestion_endpoint: "/istat-sdmx-fetch", write_table: "istat_comuni", cross_check_enabled: true, notes: "ISTAT SDMX DCIS_POPRES1." },
  F3:  { code: "F3",  pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/apr4", write_table: "istat_apr4_mobility", cross_check_enabled: true,  automation_todo: "Add monitored downloader for ISTAT APR4 (demo.istat.it) when stable URL is available.", notes: "APR4 iscritti/cancellati: manual import; target monitored downloader." },
  F4:  { code: "F4",  pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "monthly",    stale_after_days: 60,  ingestion_endpoint: "/civiko-source-registry/import/padova-elderly", write_table: "padova_elderly_population", cross_check_enabled: true,  automation_todo: "Add validated PDF/CSV parser for Comune di Padova elderly stats.", notes: "Padova elderly: manual CSV today; target PDF/CSV parser." },
  F5:  { code: "F5",  pipeline_class: "A", automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "connector-osm-cantieri", ingestion_endpoint: "/connector-osm-cantieri", write_table: "raw_sources_ingest", cross_check_enabled: true, notes: "OSM Overpass live." },
  F6:  { code: "F6",  pipeline_class: "A", automation_status: "semi_automated",    scheduler_frequency: "quarterly",  stale_after_days: 120, job: "istat-ispra-import", ingestion_endpoint: "/istat-ispra-import", write_table: "istat_ispra_risk", cross_check_enabled: true, automation_todo: "Switch from storage import to live WFS pull.", notes: "ISPRA: storage import today; target WFS auto." },
  F7:  { code: "F7",  pipeline_class: "A", automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/jobs/import-arpav-air-quality", write_table: "civiko_evidence", cross_check_enabled: true, automation_todo: "Add automated noise dataset path when public source is identified.", notes: "ARPAV air + environmental importer." },
  F8:  { code: "F8",  pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/mim-schools", write_table: "civiko_source_registry", cross_check_enabled: true,  automation_todo: "Wire MIM open-data CSV downloader (annual).", notes: "MIM schools: manual; target open-data CSV." },
  F9:  { code: "F9",  pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "quarterly",  stale_after_days: 120, ingestion_endpoint: "/civiko-source-registry/import/infratel", write_table: "civiko_source_registry", cross_check_enabled: true,  automation_todo: "Wire Infratel BUL API refresh.", notes: "Infratel: manual; target API." },
  F10: { code: "F10", pipeline_class: "A", automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/jobs/anac-ckan", write_table: "civiko_evidence", cross_check_enabled: true, notes: "ANAC CKAN open-data." },
  F11: { code: "F11", pipeline_class: "A", automation_status: "automated",         scheduler_frequency: "weekly",     stale_after_days: 14,  job: "civiko-pnrr-padova", ingestion_endpoint: "/civiko-pnrr-padova", write_table: "civiko_pnrr_padova", cross_check_enabled: true, notes: "OpenPNRR live." },
  F12: { code: "F12", pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "monthly",    stale_after_days: 90,  ingestion_endpoint: "/civiko-source-registry/import/market-benchmark", write_table: "market_benchmark_padova", cross_check_enabled: true,  automation_todo: "No compliant Borsino/FIAIP machine endpoint. Keep admin-only manual import.", notes: "Borsino/FIAIP: no compliant API → admin import only." },
  F13: { code: "F13", pipeline_class: "C", automation_status: "semi_automated",    scheduler_frequency: "monthly",    stale_after_days: 60,  job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/portalScrapers/quotations", write_table: "padova_listings", cross_check_enabled: true, automation_todo: "Label as listing-derived; flag clearly vs F1 official OMI.", notes: "Immobiliare quotations derived from listings; labelled separately." },
  F14: { code: "F14", pipeline_class: "premium", automation_status: "premium_on_demand", scheduler_frequency: "on_demand",  stale_after_days: null, ingestion_endpoint: "/civiko-premium-catasto", cross_check_enabled: false, notes: "Catasto: premium only, no mass automation." },
  F15: { code: "F15", pipeline_class: "premium", automation_status: "premium_on_demand", scheduler_frequency: "on_demand",  stale_after_days: null, ingestion_endpoint: "/civiko-premium-conservatoria", cross_check_enabled: false, notes: "Conservatoria: premium only, no mass automation." },
  F16: { code: "F16", pipeline_class: "other", automation_status: "automated",         scheduler_frequency: "daily",      stale_after_days: 3,   job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/asteGiudiziarie", write_table: "padova_auctions", cross_check_enabled: true, notes: "PVP auctions live. Matcher excludes auctions." },
  F17: { code: "F17", pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "quarterly",  stale_after_days: 180, ingestion_endpoint: "/civiko-source-registry/import/ape-veneto", write_table: "civiko_source_registry", cross_check_enabled: true,  automation_todo: "Confirm Regione Veneto APE official endpoint and wire downloader. Official register only; heuristic class stays separate.", notes: "Veneto APE: manual official register; heuristic class stays separate, never labelled official." },
  F18: { code: "F18", pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "monthly",    stale_after_days: 60,  ingestion_endpoint: "/civiko-source-registry/import/sue-padova", write_table: "sue_padova_permits", cross_check_enabled: false, automation_todo: "No stable public SUE endpoint; admin manual import only.", notes: "SUE Padova: manual with compliance_verified flag." },
  F19: { code: "F19", pipeline_class: "other", automation_status: "automated",         scheduler_frequency: "daily",      stale_after_days: 7,   job: "civiko-source-registry", ingestion_endpoint: "/civiko-source-registry/import/obituaries-aggregate", write_table: "civiko_obituaries_aggregate", cross_check_enabled: false, notes: "Aggregate-only, k>=3, visible_to_pwa=false." },
  F20: { code: "F20", pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/apr4-mobility", write_table: "istat_apr4_mobility", cross_check_enabled: true,  automation_todo: "Share downloader with F3 once stable APR4 source is wired.", notes: "APR4 mobility: manual; target same as F3." },
  F21: { code: "F21", pipeline_class: "C", automation_status: "automated",         scheduler_frequency: "daily",      stale_after_days: 3,   job: "civiko-radar-veneto", ingestion_endpoint: "/civiko-radar-veneto/portalScrapers", write_table: "padova_listings", cross_check_enabled: true, notes: "Portals + ribassiPortali. Fail-closed; not invoked from the official scheduler." },
  F22: { code: "F22", pipeline_class: "A", automation_status: "manual_fallback",   scheduler_frequency: "annual",     stale_after_days: 400, ingestion_endpoint: "/civiko-source-registry/import/istat-separations", write_table: "istat_separations_padova", cross_check_enabled: true,  automation_todo: "Switch to ISTAT SDMX once dataset id is confirmed.", notes: "ISTAT separations: manual; target SDMX." },
  // Official street-number anchor used by the Padova matcher (via+civico). Not an F-code.
  CIVICI: { code: "CIVICI", pipeline_class: "A", automation_status: "automated", scheduler_frequency: "weekly", stale_after_days: 14, job: "padova-civici-ingest", ingestion_endpoint: "/padova-civici-ingest?action=ingest", write_table: "padova_civici", cross_check_enabled: true, notes: "Comune di Padova street numbers (Open Data Veneto, CC BY 4.0)." },
};

export const CLASS_C_PORTAL_CODES = new Set(["F13", "F21"]);
export const PREMIUM_ON_DEMAND_CODES = new Set(["F14", "F15"]);

export function isOfficialPipelineCode(code: string): boolean {
  const p = SOURCE_PLAN[code];
  return Boolean(p && p.pipeline_class === "A");
}

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

/** All 22 codes must be present. Defensive sanity used by tests + boot. */
export function assertManifestComplete(): void {
  for (let i = 1; i <= 22; i++) {
    const code = `F${i}`;
    if (!SOURCE_PLAN[code]) throw new Error(`SOURCE_PLAN missing ${code}`);
  }
}
