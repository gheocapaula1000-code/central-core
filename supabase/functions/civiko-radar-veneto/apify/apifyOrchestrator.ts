// Apify orchestrator — connects registry, client, mapper, importer.
// Never logs/returns the token.

import { isApifyConfigured, runActorSync, testApifyConnection } from "./apifyClient.ts";
import { findApifySource, isApifyActorAllowed } from "./apifySourceRegistry.ts";
import { mapApifyDataset } from "./apifyMapper.ts";
import { importApifyRecords } from "./apifyDatasetImporter.ts";

export interface ApifyRunReport {
  ok: boolean;
  source_name: string;
  actor_id: string;
  allowed: boolean;
  apifyConfigured: boolean;
  dryRun: boolean;
  imported_to_target?: string;
  dataset_items_read: number;
  records_normalized: number;
  records_rejected: { reason: string; count: number }[];
  records_imported: number;
  skipped_existing: number;
  warnings: string[];
  errors: string[];
  tokenExposed: false;
}

export async function runApifyForVenetoSourceV2(opts: {
  source_name: string;
  actor_id: string;
  input?: Record<string, unknown>;
  dryRun: boolean;
  import: boolean;
}): Promise<ApifyRunReport> {
  const report: ApifyRunReport = {
    ok: false,
    source_name: opts.source_name,
    actor_id: opts.actor_id,
    allowed: false,
    apifyConfigured: isApifyConfigured(),
    dryRun: opts.dryRun,
    dataset_items_read: 0,
    records_normalized: 0,
    records_rejected: [],
    records_imported: 0,
    skipped_existing: 0,
    warnings: [],
    errors: [],
    tokenExposed: false,
  };

  if (!report.apifyConfigured) {
    report.errors.push("apify_not_configured");
    return report;
  }

  const binding = isApifyActorAllowed(opts.source_name, opts.actor_id) ?? findApifySource(opts.source_name);
  if (!binding) {
    report.errors.push("source_not_registered_or_actor_not_allowed");
    return report;
  }
  if (opts.actor_id && opts.actor_id !== binding.actor_id) {
    report.errors.push("actor_mismatch_with_registry");
    return report;
  }
  report.allowed = true;
  report.actor_id = binding.actor_id;
  report.imported_to_target = binding.import_target;

  const input = { ...binding.input_template, ...(opts.input ?? {}) };

  if (opts.dryRun) {
    // Validate connectivity only.
    const conn = await testApifyConnection();
    if (!conn.ok) {
      report.errors.push("apify_connection_failed");
      return report;
    }
    report.warnings.push("dry_run_no_actor_invocation");
    report.ok = true;
    return report;
  }

  let items: unknown[] = [];
  try {
    items = await runActorSync(binding.actor_id, input, 120_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Strip any token traces defensively (should not appear, but belt-and-braces).
    report.errors.push(msg.replace(/token=[^&\s]+/gi, "token=[redacted]").slice(0, 200));
    return report;
  }
  report.dataset_items_read = items.length;

  const mapped = await mapApifyDataset(items, binding);
  report.records_normalized = mapped.records.length;
  report.records_rejected = mapped.rejected;
  report.warnings.push(...mapped.warnings);

  const imp = await importApifyRecords(mapped.records, binding, { dryRun: opts.dryRun, doImport: opts.import });
  report.records_imported = imp.inserted;
  report.skipped_existing = imp.skipped_existing;
  if (imp.errors.length) report.errors.push(...imp.errors.slice(0, 5));

  report.ok = report.errors.length === 0;
  return report;
}

export async function apifyDiagnostics(): Promise<{
  ok: boolean;
  apifyConfigured: boolean;
  canReachApify: boolean;
  userOrAccountAvailable: boolean;
  tokenExposed: false;
  registry_size: number;
}> {
  const configured = isApifyConfigured();
  if (!configured) {
    return { ok: false, apifyConfigured: false, canReachApify: false, userOrAccountAvailable: false, tokenExposed: false, registry_size: 0 };
  }
  const conn = await testApifyConnection();
  return {
    ok: conn.ok,
    apifyConfigured: true,
    canReachApify: conn.ok,
    userOrAccountAvailable: conn.userOrAccountAvailable,
    tokenExposed: false,
    registry_size: (await import("./apifySourceRegistry.ts")).APIFY_VENETO_REGISTRY.length,
  };
}
