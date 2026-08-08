// Pure cost-cap logic for the capped Civiko launch batch.
//
// Deliberately free of Deno APIs and of any network call so the same module is
// unit-testable from the repo test suite. Nothing here is shared with the
// existing (uncapped) batch: pipeline_0510 keeps its contract byte-identical.

/** Hard total Apify cap for a single pipeline_0510_capped execution. */
export const RUN_COST_CAP_USD = 2.0;
/** Maximum items requested to each of the three Apify portals. */
export const MAX_ITEMS_PER_PORTAL = 25;
/** Where a search URL applies, exactly one is allowed. */
export const MAX_SEARCH_URLS = 1;

export type CappedPortal = "immobiliare" | "idealista" | "subito" | "private_leads";

export interface CappedPortalSpec {
  portal: CappedPortal;
  fn: string;
  /** Conservative pre-flight estimate in USD for this launch. */
  estimated_cost_usd: number;
  /** Caps echoed back to the caller and asserted by tests. */
  caps: Record<string, unknown>;
  body: Record<string, unknown>;
}

const IMMOBILIARE_SEARCH_URL =
  "https://www.immobiliare.it/vendita-case/padova/?prezzoMassimo=150000";
const SUBITO_SEARCH_URL =
  "https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/";

/**
 * Capped launch plan. Item caps are hardcoded here and never taken from the
 * request body: the capped batch must not be widenable by its caller.
 */
export const CAPPED_PORTAL_SPECS: readonly CappedPortalSpec[] = [
  {
    portal: "immobiliare",
    fn: "padova-apify-immobiliare-collect",
    // Single discover run: 0.20 USD upper bound in the collector.
    estimated_cost_usd: 0.2,
    caps: { max_items: MAX_ITEMS_PER_PORTAL, desired_results: MAX_ITEMS_PER_PORTAL, search_urls: MAX_SEARCH_URLS },
    body: {
      mode: "discovery",
      async_start: true,
      dry_run: false,
      desired_results: MAX_ITEMS_PER_PORTAL,
      max_items: MAX_ITEMS_PER_PORTAL,
      search_urls: [IMMOBILIARE_SEARCH_URL],
      refresh_urls: [],
    },
  },
  {
    portal: "idealista",
    fn: "padova-apify-idealista-collect",
    // Single actor run: 0.50 USD upper bound in the collector.
    estimated_cost_usd: 0.5,
    caps: { max_items: MAX_ITEMS_PER_PORTAL, desired_results: MAX_ITEMS_PER_PORTAL, max_urls_from_db: MAX_ITEMS_PER_PORTAL },
    body: {
      mode: "refresh",
      async_start: true,
      dry_run: false,
      desired_results: MAX_ITEMS_PER_PORTAL,
      max_urls_from_db: MAX_ITEMS_PER_PORTAL,
      max_items: MAX_ITEMS_PER_PORTAL,
    },
  },
  {
    portal: "subito",
    fn: "padova-apify-subito-collect",
    // Pay-per-result actor: 5 USD / 1000 items.
    estimated_cost_usd: Number(((MAX_ITEMS_PER_PORTAL * 5) / 1000).toFixed(3)),
    caps: { max_items: MAX_ITEMS_PER_PORTAL, search_urls: MAX_SEARCH_URLS },
    body: {
      async_start: true,
      dry_run: false,
      max_items: MAX_ITEMS_PER_PORTAL,
      search_urls: [SUBITO_SEARCH_URL],
    },
  },
  {
    portal: "private_leads",
    fn: "civiko-private-leads-nightly",
    // Sampling wrapper with its own internal spend guard; budgeted anyway so
    // the declared cap is never optimistic.
    estimated_cost_usd: 0.3,
    caps: { delegated_internal_guard: true },
    body: { trigger: "orchestrator" },
  },
] as const;

export function totalEstimatedCostUsd(
  specs: readonly CappedPortalSpec[] = CAPPED_PORTAL_SPECS,
): number {
  return Number(specs.reduce((acc, spec) => acc + spec.estimated_cost_usd, 0).toFixed(3));
}

export interface PreflightDecision {
  allowed: boolean;
  reason: string | null;
  cost_cap_usd: number;
  estimated_cost_usd: number;
  per_portal_estimates: Array<{ portal: CappedPortal; estimated_cost_usd: number }>;
}

/** Fail-closed pre-flight: refuse to launch anything if the plan exceeds the cap. */
export function evaluatePreflight(
  specs: readonly CappedPortalSpec[] = CAPPED_PORTAL_SPECS,
  cap = RUN_COST_CAP_USD,
): PreflightDecision {
  const estimated = totalEstimatedCostUsd(specs);
  return {
    allowed: estimated <= cap,
    reason: estimated <= cap ? null : "cost_cap_would_exceed",
    cost_cap_usd: cap,
    estimated_cost_usd: estimated,
    per_portal_estimates: specs.map((spec) => ({
      portal: spec.portal,
      estimated_cost_usd: spec.estimated_cost_usd,
    })),
  };
}

/**
 * Extracts the provider-side charged amount of an Apify run object.
 * Returns null when the provider does not expose any usage figure: in that case
 * the cap cannot be verified and the caller must abort the run (fail-closed).
 */
export function providerUsageUsd(run: unknown): number | null {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const row = run as Record<string, unknown>;
  const candidates = [
    row.usageTotalUsd,
    row.chargedTotalUsd,
    (row.stats as Record<string, unknown> | undefined)?.computeUnits === undefined
      ? undefined
      : row.usageTotalUsd,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (typeof value === "number" && Number.isFinite(num) && num >= 0) return num;
  }
  return null;
}

export const TERMINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"];

export function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.includes(status);
}

export interface CapVerdict {
  /** true only when every run reported a readable usage figure. */
  verified: boolean;
  /** true when cumulative provider-side usage is still within the cap. */
  within_cap: boolean;
  observed_total_usd: number;
  unverifiable_run_ids: string[];
  reason: string | null;
}

/**
 * Provider-side verification of the hard cap over all launched runs.
 * Any run whose spend is unreadable makes the whole verdict unverified, so the
 * caller aborts and fails closed instead of trusting an unbounded run.
 */
export function evaluateProviderCap(
  runs: Array<{ run_id: string; usage_usd: number | null }>,
  cap = RUN_COST_CAP_USD,
): CapVerdict {
  const unverifiable = runs.filter((run) => run.usage_usd === null).map((run) => run.run_id);
  const total = Number(
    runs.reduce((acc, run) => acc + (run.usage_usd ?? 0), 0).toFixed(4),
  );
  if (unverifiable.length > 0) {
    return {
      verified: false,
      within_cap: false,
      observed_total_usd: total,
      unverifiable_run_ids: unverifiable,
      reason: "provider_cap_unverifiable",
    };
  }
  if (total > cap) {
    return {
      verified: true,
      within_cap: false,
      observed_total_usd: total,
      unverifiable_run_ids: [],
      reason: "cost_cap_exceeded_aborted",
    };
  }
  return {
    verified: true,
    within_cap: true,
    observed_total_usd: total,
    unverifiable_run_ids: [],
    reason: null,
  };
}
