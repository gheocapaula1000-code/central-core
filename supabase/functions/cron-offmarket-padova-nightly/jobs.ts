// Pure job table for the Padova off-market nightly wrapper.
// Timeouts must stay under log_cron_http_invocation (120s) and still
// cover the downstream Firecrawl timeBudget (90s on discover / scrape).

export type JobSlug =
  | "offmarket-padova"
  | "discover-early-offmarket-signals"
  | "build-offmarket-opportunity-scores"
  | "build-padova-early-warning";

export const JOB_NAMES: Record<JobSlug, string> = {
  "offmarket-padova": "central-core-offmarket-padova-nightly",
  "discover-early-offmarket-signals": "central-core-early-offmarket-nightly",
  "build-offmarket-opportunity-scores": "central-core-offmarket-scores-nightly",
  "build-padova-early-warning": "central-core-padova-early-warning-nightly",
};

export const LIVE_CORE_REF = "jpunnzgixcghuydstdlt";

/** Perimetro commerciale definitivo: solo Comune di Padova. */
export const COMUNI_PD = ["Padova"] as const;

export function isJobSlug(value: string | null | undefined): value is JobSlug {
  return !!value && Object.prototype.hasOwnProperty.call(JOB_NAMES, value);
}

export function targetTimeoutMs(slug: JobSlug): number {
  switch (slug) {
    case "offmarket-padova":
      return 95_000;
    case "discover-early-offmarket-signals":
      return 95_000;
    case "build-offmarket-opportunity-scores":
      return 50_000;
    case "build-padova-early-warning":
      return 50_000;
  }
}

export function buildBody(slug: JobSlug): Record<string, unknown> {
  switch (slug) {
    case "offmarket-padova":
      return {
        comuni: [...COMUNI_PD],
        province: ["PD"],
        dryRun: false,
        import: false,
        maxSources: 20,
        maxPagesPerSource: 5,
        triggered_by: "cron-nightly",
      };
    case "discover-early-offmarket-signals":
      return {
        comuni: [...COMUNI_PD],
        province: ["PD"],
        dryRun: false,
        saveCandidates: true,
        usePerplexityDiscovery: true,
        useFirecrawl: true,
        maxSources: 20,
        maxPagesPerSource: 5,
        triggered_by: "cron-nightly",
      };
    case "build-offmarket-opportunity-scores":
      return {
        comuni: [...COMUNI_PD],
        province: ["PD"],
        dryRun: false,
        triggered_by: "cron-nightly",
      };
    case "build-padova-early-warning":
      return {
        comuni: [...COMUNI_PD],
        province: ["PD"],
        dryRun: false,
        triggered_by: "cron-nightly",
      };
  }
}

export function radarJobPath(slug: JobSlug): string {
  return `/functions/v1/civiko-radar-veneto/jobs/${slug}`;
}
