// UEradar.com — regole di spesa TrovaBandi (modulo puro).
//
// Paid providers (Firecrawl / Apify / Perplexity) quando il fetch ufficiale
// fallisce, il documento non è leggibile, o (backfill_nulls) l'HTML è
// leggibile ma eligible_ateco_prefixes resta vuoto. Nessun recrawl di
// SCADUTO. Nessuna re-estrazione a pagamento di VERIFICATO già completi
// o di SPORTELLO (misura ufficiale senza data di chiusura).
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
  forms_url?: string | null;
  protocol_email?: string | null;
  raw_excerpt?: string | null;
  eligible_ateco_prefixes?: string[] | null;
  region?: string | null;
  province?: string | null;
  municipality?: string | null;
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

export function isSportelloStatus(status: unknown): boolean {
  return String(status ?? "").trim().toUpperCase() === "SPORTELLO";
}

/** Non pagare una re-estrazione su VERIFICATO già completi o su SPORTELLO. */
export function shouldSkipPaidExtract(
  row: CatalogueRow | null | undefined,
): boolean {
  return isCompleteVerified(row) || isSportelloStatus(row?.verification_status);
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

/** Cookie shell, missing page, or under 200 chars: not official evidence. */
export function officialPageNeedsPaidScrape(
  page: { markdown?: string } | null | undefined,
  isCookieShell: (markdown: string) => boolean,
): boolean {
  if (!page || typeof page.markdown !== "string") return true;
  if (page.markdown.length < 200) return true;
  return isCookieShell(page.markdown);
}

/** allow_paid_scrape defaults on; needs Firecrawl or Apify. */
export function allowBackfillPaidScrape(
  flag: unknown,
  hasFirecrawl: boolean,
  hasApify: boolean,
): boolean {
  return parseAllowPaid(flag, true) && (hasFirecrawl || hasApify);
}

/** After a failed/empty/cookie direct fetch, try loadPage (Firecrawl then Apify). */
export async function fallbackPaidOfficialPage<
  T extends { markdown: string },
>(
  page: T | null,
  opts: {
    isCookieShell: (markdown: string) => boolean;
    loadPage: () => Promise<T | null>;
  },
): Promise<T | null> {
  if (!officialPageNeedsPaidScrape(page, opts.isCookieShell)) return page;
  const paid = await opts.loadPage();
  if (!officialPageNeedsPaidScrape(paid, opts.isCookieShell)) return paid;
  return page;
}


/** Official ATECO prefixes still missing after local extract. Never invent. */
export function atecoPrefixesEmpty(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  return value.map((item) => String(item).trim()).filter(Boolean).length === 0;
}

/**
 * Never replace a filled eligible_ateco_prefixes array with [].
 * Empty extract is not a patch. Same set is not a patch.
 */
export function shouldPatchEligibleAteco(
  existing: string[],
  extracted: string[],
): boolean {
  const next = extracted.map((item) => String(item).trim()).filter(Boolean);
  if (next.length === 0) return false;
  const prev = existing.map((item) => String(item).trim()).filter(Boolean);
  if (
    prev.length === next.length &&
    prev.every((prefix) => next.includes(prefix)) &&
    next.every((prefix) => prev.includes(prefix))
  ) {
    return false;
  }
  return true;
}

/**
 * Queue rank for backfill_nulls: Veneto (region ilike) first, then
 * NAZIONALE/EU, then the rest. Does not invent geo.
 */
export function backfillQueueRank(row: {
  region?: string | null;
  authority_level?: string | null;
}): number {
  const region = String(row.region ?? "").toLowerCase();
  if (region.includes("veneto")) return 0;
  const level = String(row.authority_level ?? "").trim().toUpperCase();
  if (level === "NAZIONALE" || level === "EU") return 1;
  return 2;
}

/** Stable merge of already last_seen-sorted pages, Veneto then national/EU then rest. */
export function mergeBackfillPriorityPages<T extends { id?: unknown }>(
  pages: T[][],
  maxBatch: number,
): T[] {
  const cap = Number.isFinite(maxBatch) ? Math.max(1, Math.floor(maxBatch)) : 1;
  const out: T[] = [];
  const have = new Set<string>();
  for (const page of pages) {
    for (const row of page) {
      const id = typeof row.id === "string" ? row.id : "";
      if (id && have.has(id)) continue;
      if (id) have.add(id);
      out.push(row);
      if (out.length >= cap) return out;
    }
  }
  return out;
}


/**
 * Packet for backfill_nulls: rows missing max_grant_amount (PWA importo)
 * first, then other nulls. Pages inside each group are already
 * Veneto → NAZIONALE/EU → rest. Dedupes ids. Does not invent amounts.
 */
export function assembleBackfillPacket<T extends { id?: unknown }>(
  missingImportoPages: T[][],
  otherNullPages: T[][],
  maxBatch: number,
): T[] {
  const first = mergeBackfillPriorityPages(missingImportoPages, maxBatch);
  const cap = Number.isFinite(maxBatch) ? Math.max(1, Math.floor(maxBatch)) : 1;
  if (first.length >= cap) return first;
  return mergeBackfillPriorityPages([first, ...otherNullPages], maxBatch);
}

/** official_url first, then notice_url if distinct. Empty strings dropped. */
export function backfillPaidAtecoUrls(
  officialUrl: unknown,
  noticeUrl?: unknown,
): string[] {
  const urls: string[] = [];
  for (const value of [officialUrl, noticeUrl]) {
    if (typeof value !== "string") continue;
    const url = value.trim();
    if (!url || urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

/**
 * After local extract left ATECO empty: spend loadPage on official_url
 * and, if present, notice_url — even when HTTP HTML was already readable.
 * Fail-closed: never invent prefixes. Caller enforces maxPaidScrapes=1.
 */
export async function fallbackPaidWhenAtecoEmpty<
  T extends { markdown: string },
>(
  localAteco: string[],
  opts: {
    officialUrl: string;
    noticeUrl?: string | null;
    loadPage: (url: string) => Promise<T | null>;
    extractAteco: (markdown: string) => string[];
    isCookieShell?: (markdown: string) => boolean;
  },
): Promise<{ ateco: string[]; page: T | null }> {
  if (!atecoPrefixesEmpty(localAteco)) {
    return { ateco: [...localAteco], page: null };
  }
  let page: T | null = null;
  for (const url of backfillPaidAtecoUrls(opts.officialUrl, opts.noticeUrl)) {
    const next = await opts.loadPage(url);
    if (!next || typeof next.markdown !== "string") continue;
    if (opts.isCookieShell?.(next.markdown)) continue;
    page = next;
    const ateco = opts.extractAteco(next.markdown);
    if (!atecoPrefixesEmpty(ateco)) return { ateco, page };
  }
  return { ateco: [], page };
}
