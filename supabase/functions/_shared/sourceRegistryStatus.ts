// _shared/sourceRegistryStatus.ts
// Each automated collection function writes last_run_at / last_success_at /
// last_error / record_count on civiko_source_registry. pg_cron and GitHub
// Actions can call the functions directly (not only via civiko-scheduler),
// so the functions themselves MUST persist status.

export const SOURCE_REGISTRY_TABLE = "civiko_source_registry";

export interface SourceRegistryOutcome {
  ok: boolean;
  records?: number;
  error?: string | null;
  now?: string;
  /** When false, leave record_count untouched (downstream F2 demografia). Default true. */
  writeRecordCount?: boolean;
  /** Optional next scheduled run (set by civiko-scheduler). */
  next_run_at?: string | null;
}

export function normalizeRecordCount(records: unknown): number {
  const n = typeof records === "number" ? records : Number(records);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

export function buildSourceRegistryPatch(
  outcome: SourceRegistryOutcome,
): Record<string, unknown> {
  const now = outcome.now ?? new Date().toISOString();
  const patch: Record<string, unknown> = { last_run_at: now };
  const writeCount = outcome.writeRecordCount !== false;
  if (writeCount) {
    patch.record_count = typeof outcome.records === "number"
      ? normalizeRecordCount(outcome.records)
      : 0;
  }
  if (outcome.ok) {
    patch.last_success_at = now;
    patch.last_error = null;
  } else {
    patch.last_error = String(outcome.error ?? "unknown").slice(0, 500);
  }
  if (outcome.next_run_at !== undefined) {
    patch.next_run_at = outcome.next_run_at;
  }
  return patch;
}

/**
 * Best-effort registry write. Never throws — a writer failure must not
 * crash the collection job or sibling sources.
 */
export async function writeSourceRegistryStatus(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  sourceCode: string,
  outcome: SourceRegistryOutcome,
): Promise<void> {
  if (!supabase || typeof supabase.from !== "function") return;
  if (!sourceCode) return;
  const patch = buildSourceRegistryPatch(outcome);
  try {
    const { error } = await supabase
      .from(SOURCE_REGISTRY_TABLE)
      .update(patch)
      .eq("source_code", sourceCode);
    if (error) {
      console.warn("writeSourceRegistryStatus", sourceCode, error.message);
    }
  } catch (e) {
    console.warn(
      "writeSourceRegistryStatus failed",
      sourceCode,
      (e as Error).message ?? String(e),
    );
  }
}

/** Padova centro — default for scheduled F11 (OpenPNRR) when no pin is supplied. */
export const PADOVA_CRON_COORDS = { lat: 45.4064, lng: 11.8768 } as const;
export const PADOVA_CRON_RADIUS_M = 15_000;
