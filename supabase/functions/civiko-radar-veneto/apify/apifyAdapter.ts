// Apify adapter scaffolding — minimal, compliance-aware.
// Actors must be explicitly allow-listed per source_name.

export interface ApifyActorBinding {
  source_name: string;
  actor_id: string;
  expected_schema: string;
  compliance_notes: string;
  output_mapping: "source_documents" | "legal_property_signals" | "territorial_signals" | "listing_price_snapshots";
  quality_rules: string[];
}

// Empty allow-list: no actors authorized yet. Add explicit bindings here once vetted.
export const APIFY_ALLOWED_ACTORS: ApifyActorBinding[] = [];

export function isApifyAllowed(source_name: string, actor_id: string): ApifyActorBinding | null {
  return APIFY_ALLOWED_ACTORS.find((a) => a.source_name === source_name && a.actor_id === actor_id) ?? null;
}

export interface ApifyRunReport {
  ok: boolean;
  source_name: string;
  actor_id: string;
  allowed: boolean;
  run_id?: string;
  dataset_items?: number;
  imported?: number;
  errors: string[];
  notes: string[];
}

export async function runApifyForVenetoSource(opts: {
  source_name: string;
  actor_id: string;
  input: Record<string, unknown>;
  dryRun: boolean;
  import: boolean;
}): Promise<ApifyRunReport> {
  const report: ApifyRunReport = {
    ok: false, source_name: opts.source_name, actor_id: opts.actor_id,
    allowed: false, errors: [], notes: [],
  };
  const binding = isApifyAllowed(opts.source_name, opts.actor_id);
  if (!binding) {
    report.errors.push("actor_not_allowlisted");
    report.notes.push("Add an explicit ApifyActorBinding before running this actor.");
    return report;
  }
  report.allowed = true;
  const { getApifyToken } = await import("../../_shared/apify.ts");
  const apiKey = getApifyToken();
  if (!apiKey) {
    report.errors.push("APIFY_API_TOKEN missing");
    return report;
  }
  if (opts.dryRun) {
    report.ok = true;
    report.notes.push("dryRun: did not call Apify");
    return report;
  }
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(opts.actor_id)}/run-sync-get-dataset-items?token=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.input ?? {}),
    });
    if (!res.ok) { report.errors.push(`apify HTTP ${res.status}`); return report; }
    const items = await res.json();
    report.dataset_items = Array.isArray(items) ? items.length : 0;
    report.notes.push(`mapping target: ${binding.output_mapping}`);
    // Mapping/import is intentionally a noop scaffold; actual mappers must be added per binding.
    report.ok = true;
    return report;
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
    return report;
  }
}
