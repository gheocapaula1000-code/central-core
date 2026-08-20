export const COVERAGE_WINDOW_HOURS = 26;
export const RUN_STALE_AFTER_MINUTES = 20;
export const REFRESH_PREFERENCE_MAX_BYPASS_MINUTES = 30;
export const COLLECTION_PARTIAL_ERROR_CODE = "COLLECTION_PARTIAL";

export type CollectionCompletionOutcome =
  | {
      runStatus: "SUCCEEDED";
      httpStatus: 200;
      ok: true;
      errorCode: null;
    }
  | {
      runStatus: "PARTIAL";
      httpStatus: 502;
      ok: false;
      errorCode: typeof COLLECTION_PARTIAL_ERROR_CODE;
    };

export type DueSource = {
  id: string;
  source_kind: string;
  priority: number;
  region?: string | null;
  last_scanned_at: string | null;
  next_scan_at: string;
};

export type SuccessfulRun = {
  source_id: string | null;
  provider_usage: unknown;
};

export type ReleaseGateInput = {
  enabledSources: DueSource[];
  recentSuccessfulRuns: SuccessfulRun[];
  staleRunningCount: number;
  verifiedActiveCount: number;
  partialActiveCount: number;
  coverageSinceIso: string;
};

type ProviderUsage = {
  firecrawl_search_status?: unknown;
  perplexity_search_status?: unknown;
  pages_attempted?: unknown;
  pages_scraped?: unknown;
};

export function boundedMaxPages(value: unknown, fallback = 2): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(5, parsed));
}

export function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * PARTIAL is a durable diagnostic state, never a successful scheduler result.
 * Keeping this mapping pure makes the HTTP contract and the persisted state
 * impossible to classify independently.
 */
export function collectionCompletionOutcome(
  operationalFailures: number,
): CollectionCompletionOutcome {
  return operationalFailures > 0
    ? {
        runStatus: "PARTIAL",
        httpStatus: 502,
        ok: false,
        errorCode: COLLECTION_PARTIAL_ERROR_CODE,
      }
    : {
        runStatus: "SUCCEEDED",
        httpStatus: 200,
        ok: true,
        errorCode: null,
      };
}

/**
 * Le URL sono ridondanti dentro la stessa fonte: i NO_CONTENT restano warning
 * puntuali, ma diventano guasto operativo solo quando nessuna pagina della
 * fonte ha prodotto contenuto valido.
 */
export function sourceScrapeOperationalFailures(
  failedUrls: number,
  validPages: number,
): number {
  const failures = nonNegativeSafeInteger(failedUrls) ?? 0;
  const valid = nonNegativeSafeInteger(validPages) ?? 0;
  return failures > 0 && valid === 0 ? failures : 0;
}

function timestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Fair rotation: the most-overdue source wins. A never-scanned source wins a
 * tie, then priority is only a deterministic tie-breaker. A pending regional
 * refresh may move one compatible source ahead only inside a 30-minute due
 * window, so an older incompatible source cannot starve. scan_interval_minutes
 * remains the mechanism that gives fast lanes their higher cadence.
 */
function normalizedRegion(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function rankDueSources<T extends DueSource>(
  sources: T[],
  preferredRegion?: string | null,
): T[] {
  const ranked = [...sources].sort((left, right) => {
    const due = timestamp(left.next_scan_at) - timestamp(right.next_scan_at);
    if (due !== 0) return due;
    const lastScan = timestamp(left.last_scanned_at) - timestamp(right.last_scanned_at);
    if (lastScan !== 0) return lastScan;
    const priority = Number(right.priority || 0) - Number(left.priority || 0);
    return priority !== 0 ? priority : left.id.localeCompare(right.id);
  });
  const preferred = normalizedRegion(preferredRegion);
  if (!preferred || ranked.length < 2) return ranked;

  const oldestDue = timestamp(ranked[0].next_scan_at);
  const latestPreferredDue = oldestDue + REFRESH_PREFERENCE_MAX_BYPASS_MINUTES * 60_000;
  const eligible = ranked.filter((source) => timestamp(source.next_scan_at) <= latestPreferredDue);
  const exactRegional = eligible.find((source) => normalizedRegion(source.region) === preferred);
  const compatible = exactRegional ?? eligible.find((source) => !normalizedRegion(source.region));
  if (!compatible || compatible.id === ranked[0].id) return ranked;
  return [compatible, ...ranked.filter((source) => source.id !== compatible.id)];
}

/**
 * A valid zero-result search is still a real scan. Novelty counters are
 * intentionally absent: both provider searches must have completed and the
 * bounded page telemetry must be structurally valid, including 0 attempted.
 */
export function isRealSuccessfulScan(run: SuccessfulRun): boolean {
  if (!run.source_id || !run.provider_usage || typeof run.provider_usage !== "object") return false;
  const usage = run.provider_usage as ProviderUsage;
  const attempted = usage.pages_attempted;
  const scraped = usage.pages_scraped;
  // "SKIPPED_CACHE" è uno scan reale completato senza guasti provider: la
  // ricerca a pagamento è stata evitata perché il pool cache era sufficiente.
  const okStatus = (value: unknown) =>
    value === "OK" || value === "SKIPPED_CACHE" || value === "SKIPPED_BUDGET";
  return (
    okStatus(usage.firecrawl_search_status) &&
    okStatus(usage.perplexity_search_status) &&
    typeof attempted === "number" &&
    Number.isInteger(attempted) &&
    attempted >= 0 &&
    typeof scraped === "number" &&
    Number.isInteger(scraped) &&
    scraped >= 0 &&
    scraped <= attempted
  );
}

export function evaluateReleaseGate(input: ReleaseGateInput) {
  const enabledIds = new Set(input.enabledSources.map((source) => source.id));
  const enabledKinds = new Set(
    input.enabledSources.map((source) => source.source_kind.trim()).filter(Boolean),
  );
  const realRuns = input.recentSuccessfulRuns.filter(isRealSuccessfulScan);
  const coveredIds = new Set(
    realRuns
      .map((run) => run.source_id)
      .filter((sourceId): sourceId is string => !!sourceId && enabledIds.has(sourceId)),
  );
  const coveredKinds = new Set(
    input.enabledSources
      .filter((source) => coveredIds.has(source.id))
      .map((source) => source.source_kind.trim())
      .filter(Boolean),
  );
  const coverageSince = timestamp(input.coverageSinceIso);
  const freshRegistrySources = input.enabledSources.filter(
    (source) => timestamp(source.last_scanned_at) >= coverageSince,
  ).length;

  // Dynamic, explainable floor: one current verified official opportunity for
  // every enabled discovery lane. It scales with configured kinds and does not
  // invent a fixed commercial catalogue size.
  const catalogueRequired = enabledKinds.size;
  const checks = {
    enabled_sources_present: enabledIds.size > 0 && enabledKinds.size > 0,
    source_registry_fresh_26h: enabledIds.size > 0 && freshRegistrySources === enabledIds.size,
    recent_source_coverage_26h: enabledIds.size > 0 && coveredIds.size === enabledIds.size,
    all_enabled_source_kinds_succeeded:
      enabledKinds.size > 0 && [...enabledKinds].every((kind) => coveredKinds.has(kind)),
    no_stale_running: input.staleRunningCount === 0,
    verified_official_catalogue_populated:
      catalogueRequired > 0 && input.verifiedActiveCount >= catalogueRequired,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    metrics: {
      coverage_window_hours: COVERAGE_WINDOW_HOURS,
      enabled_sources: enabledIds.size,
      enabled_source_kinds: enabledKinds.size,
      fresh_registry_sources: freshRegistrySources,
      recently_covered_sources: coveredIds.size,
      recently_covered_source_kinds: coveredKinds.size,
      real_successful_runs: realRuns.length,
      stale_running: input.staleRunningCount,
      verified_active: input.verifiedActiveCount,
      partial_active: input.partialActiveCount,
      catalogue_required_dynamic: catalogueRequired,
    },
  };
}

