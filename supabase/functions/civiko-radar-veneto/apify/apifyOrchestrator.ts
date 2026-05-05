// Apify orchestrator — connects registry, client, mapper, importer.
// Never logs/returns the token.

import { getDatasetItems, getRunStatus, isApifyConfigured, runActorSync, startActorRun, testApifyConnection } from "./apifyClient.ts";
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
  invokeActor: boolean;
  imported_to_target?: string;
  actor_run_id?: string;
  actor_status?: string;
  dataset_id?: string;
  dataset_items_read: number;
  records_normalized: number;
  records_importable: number;
  records_rejected_count: number;
  records_rejected: { reason: string; count: number }[];
  records_imported: number;
  skipped_existing: number;
  sample_records: Array<{ source_url: string; title: string | null; data_basis: "real" | "partial"; classification?: string }>;
  sample_importable_records: Array<{ source_url: string; title: string | null; classification: string }>;
  sample_rejected_records: Array<{ source_url: string; title: string | null; classification: string; reject_reason?: string }>;
  input_template_used?: Record<string, unknown>;
  warnings: string[];
  errors: string[];
  tokenExposed: false;
}

export async function runApifyForVenetoSourceV2(opts: {
  source_name: string;
  actor_id: string;
  input?: Record<string, unknown>;
  dryRun: boolean;
  invokeActor?: boolean;
  import: boolean;
}): Promise<ApifyRunReport> {
  const invokeActor = opts.invokeActor === true;
  const report: ApifyRunReport = {
    ok: false,
    source_name: opts.source_name,
    actor_id: opts.actor_id,
    allowed: false,
    apifyConfigured: isApifyConfigured(),
    dryRun: opts.dryRun,
    invokeActor,
    dataset_items_read: 0,
    records_normalized: 0,
    records_importable: 0,
    records_rejected_count: 0,
    records_rejected: [],
    records_imported: 0,
    skipped_existing: 0,
    sample_records: [],
    sample_importable_records: [],
    sample_rejected_records: [],
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

  // Safe input merge: if caller passed empty input, use registry template as-is.
  const userInput = opts.input && Object.keys(opts.input).length > 0 ? opts.input : {};
  const input = { ...binding.input_template, ...userInput };
  report.input_template_used = input;

  // Pure dry-run (no actor invocation): validation only.
  if (opts.dryRun && !invokeActor) {
    const conn = await testApifyConnection();
    if (!conn.ok) {
      report.errors.push("apify_connection_failed");
      return report;
    }
    report.warnings.push("dry_run_no_actor_invocation");
    report.ok = true;
    return report;
  }

  // Invoke actor (either real run or test-invocation without import).
  let items: unknown[] = [];
  try {
    if (invokeActor) {
      // Async start + bounded poll, so we can return running state on timeout.
      const started = await startActorRun(binding.actor_id, input, 30_000);
      report.actor_run_id = started.id;
      report.actor_status = started.status;
      report.dataset_id = started.defaultDatasetId;

      const POLL_MS = 3000;
      const MAX_WAIT_MS = 90_000;
      const t0 = Date.now();
      let status = started.status;
      let datasetId = started.defaultDatasetId;
      while (Date.now() - t0 < MAX_WAIT_MS && status && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        try {
          const s = await getRunStatus(started.id);
          status = s.status;
          datasetId = s.defaultDatasetId ?? datasetId;
        } catch (e) {
          report.warnings.push(`poll_error:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
          break;
        }
      }
      report.actor_status = status;
      report.dataset_id = datasetId;

      if (status !== "SUCCEEDED") {
        report.warnings.push(`actor_not_finished:${status ?? "unknown"}`);
        if (datasetId) {
          try {
            items = await getDatasetItems(datasetId, 200);
          } catch { /* ignore */ }
        }
      } else if (datasetId) {
        items = await getDatasetItems(datasetId, 1000);
      }
    } else {
      items = await runActorSync(binding.actor_id, input, 120_000);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report.errors.push(msg.replace(/token=[^&\s]+/gi, "token=[redacted]").slice(0, 200));
    // Continue so we still return partial report.
  }
  report.dataset_items_read = items.length;

  const mapped = await mapApifyDataset(items, binding);
  report.records_normalized = mapped.records.length;
  report.records_importable = mapped.records.length;
  report.records_rejected = mapped.rejected;
  report.warnings.push(...mapped.warnings);
  report.sample_records = mapped.records.slice(0, 3).map((r) => ({
    source_url: r.source_url,
    title: r.title,
    data_basis: r.data_basis,
  }));

  // Hard guard: never write when dryRun OR when import flag false.
  const doImport = opts.import === true && opts.dryRun === false;
  if (!doImport) {
    report.warnings.push("import_skipped_test_mode");
  } else {
    const imp = await importApifyRecords(mapped.records, binding, { dryRun: false, doImport: true });
    report.records_imported = imp.inserted;
    report.skipped_existing = imp.skipped_existing;
    if (imp.errors.length) report.errors.push(...imp.errors.slice(0, 5));
  }

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
