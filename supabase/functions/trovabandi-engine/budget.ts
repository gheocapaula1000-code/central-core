// UEradar.com — regole di spesa TrovaBandi (modulo puro).
//
// Paid providers (Firecrawl / Apify / Perplexity) solo quando il fetch
// ufficiale fallisce o il documento non è leggibile. Nessun recrawl di
// SCADUTO. Nessuna re-estrazione a pagamento di VERIFICATO già completi.
// Dominio esclusivo: trovabandi-engine.

export const SOURCE_LANES = [
  "locale",
  "camerale",
  "regionale",
  "nazionale",
  "pnrr",
  "ue",
  "femminile",
  "giovanile",
] as const;

export type SourceLane = (typeof SOURCE_LANES)[number];

export type PaidKind = "search" | "scrape" | "extract";

export type CatalogueRow = {
  official_url?: string | null;
  verification_status?: string | null;
  deadline_at?: string | null;
  min_grant_amount?: number | null;
  max_grant_amount?: number | null;
  total_budget?: number | null;
  application_url?: string | null;
  protocol_email?: string | null;
  raw_excerpt?: string | null;
  eligible_ateco_prefixes?: string[] | null;
};

export type LaneSource = {
  name?: string | null;
  authority_level?: string | null;
  source_kind?: string | null;
  official_domain?: string | null;
  search_query?: string | null;
};

export type PaidBudget = {
  allowPaid: boolean;
  maxPaidSearches: number;
  maxPaidScrapes: number;
  maxPaidExtracts: number;
  paidSearches: number;
  paidScrapes: number;
  paidExtracts: number;
};

const PNRR_HINT =
  /\bpnrr\b|italiadomani|padigitale2026|missione\s*m\d|italia\s+domani/i;
const FEMMINILE_HINT = /femminil|pariopportunita|pari\s+opportunit/i;
const GIOVANILE_HINT = /giovanil|politichegiovanili|young\s+entrepreneur/i;

export function normalizeLane(value: unknown): SourceLane | null {
  if (typeof value !== "string") return null;
  const lane = value.trim().toLowerCase();
  return (SOURCE_LANES as readonly string[]).includes(lane)
    ? (lane as SourceLane)
    : null;
}

function haystack(source: LaneSource): string {
  return [
    source.name,
    source.official_domain,
    source.search_query,
    source.source_kind,
  ]
    .map((part) => (typeof part === "string" ? part : ""))
    .join(" ")
    .toLowerCase();
}

/**
 * Corsia più specifica vince: femminile/giovanile/PNRR/UE prima dei
 * livelli territoriali generici. Usata dai cron notturni per coprire
 * tutti i tier ufficiali senza un full-scan diurno a pagamento.
 */
export function sourceLane(source: LaneSource): SourceLane {
  const text = haystack(source);
  const level = (source.authority_level ?? "").trim().toUpperCase();
  const kind = (source.source_kind ?? "").trim().toUpperCase();
  if (FEMMINILE_HINT.test(text)) return "femminile";
  if (GIOVANILE_HINT.test(text)) return "giovanile";
  if (PNRR_HINT.test(text)) return "pnrr";
  if (level === "EU" || kind === "EU_PORTAL") return "ue";
  if (level === "COMUNALE" || kind === "ALBO_PRETORIO" || kind === "GAL") {
    return "locale";
  }
  if (level === "CAMERALE" || kind === "CAMERALE") return "camerale";
  if (level === "REGIONALE" || kind === "BUR") return "regionale";
  return "nazionale";
}

export function filterSourcesByLane<T extends LaneSource>(
  sources: T[],
  lane?: SourceLane | null,
): T[] {
  if (!lane) return sources;
  return sources.filter((source) => sourceLane(source) === lane);
}

export function isExpiredStatus(status: unknown): boolean {
  return String(status ?? "").trim().toUpperCase() === "SCADUTO";
}

export function hasDeadline(row: CatalogueRow | null | undefined): boolean {
  return typeof row?.deadline_at === "string" && row.deadline_at.length > 0;
}

export function hasAmount(row: CatalogueRow | null | undefined): boolean {
  const values = [
    row?.min_grant_amount,
    row?.max_grant_amount,
    row?.total_budget,
  ];
  return values.some((value) => typeof value === "number" && value > 0);
}

export function isCompleteVerified(row: CatalogueRow | null | undefined): boolean {
  return (
    String(row?.verification_status ?? "").trim().toUpperCase() ===
      "VERIFICATO" &&
    hasDeadline(row) &&
    hasAmount(row)
  );
}

/** Non ricrawlare bandi già scaduti: costo zero e rumore zero. */
export function shouldSkipExpiredRecrawl(
  row: CatalogueRow | null | undefined,
): boolean {
  return isExpiredStatus(row?.verification_status);
}

/** Non pagare una re-estrazione su VERIFICATO già completi di scadenza+importo. */
export function shouldSkipPaidExtract(
  row: CatalogueRow | null | undefined,
): boolean {
  return isCompleteVerified(row);
}

/**
 * Testo già persistito (raw_excerpt / evidence) evita un nuovo crawl.
 * Soglia allineata al fetch ufficiale: sotto 200 caratteri non è prova.
 */
export function usableStoredEvidence(excerpt: unknown): string | null {
  if (typeof excerpt !== "string") return null;
  const text = excerpt.trim();
  return text.length >= 200 ? text : null;
}

export function documentIsReadable(markdown: unknown): boolean {
  return typeof markdown === "string" && markdown.trim().length >= 200;
}

/**
 * Paid solo se il fetch ufficiale è fallito oppure il documento non è
 * leggibile (PDF scansionato/cifrato, HTML vuoto). Un testo ufficiale
 * lungo >= 200 caratteri non autorizza Perplexity/Firecrawl/Apify.
 */
export function shouldUsePaidProvider(
  officialFetchOk: boolean,
  readable: boolean,
): boolean {
  return !officialFetchOk || !readable;
}

export function createPaidBudget(
  allowPaid: boolean,
  concurrentPaidBlocked = false,
): PaidBudget {
  const enabled = allowPaid && !concurrentPaidBlocked;
  return {
    allowPaid: enabled,
    maxPaidSearches: enabled ? 1 : 0,
    maxPaidScrapes: enabled ? 1 : 0,
    maxPaidExtracts: enabled ? 1 : 0,
    paidSearches: 0,
    paidScrapes: 0,
    paidExtracts: 0,
  };
}

export function canSpendPaid(budget: PaidBudget, kind: PaidKind): boolean {
  if (!budget.allowPaid) return false;
  if (kind === "search") return budget.paidSearches < budget.maxPaidSearches;
  if (kind === "scrape") return budget.paidScrapes < budget.maxPaidScrapes;
  return budget.paidExtracts < budget.maxPaidExtracts;
}

export function spendPaid(budget: PaidBudget, kind: PaidKind): boolean {
  if (!canSpendPaid(budget, kind)) return false;
  if (kind === "search") budget.paidSearches += 1;
  else if (kind === "scrape") budget.paidScrapes += 1;
  else budget.paidExtracts += 1;
  return true;
}

export function readIncomingEngineSecret(headers: {
  get(name: string): string | null;
}): string {
  return (
    headers.get("x-internal-secret")?.trim() ||
    headers.get("x-job-secret")?.trim() ||
    ""
  );
}

export function parseAllowPaid(value: unknown, fallback = true): boolean {
  if (value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  return fallback;
}
