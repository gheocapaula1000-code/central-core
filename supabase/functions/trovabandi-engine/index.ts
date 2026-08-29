import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  aggregateDiagnostics,
  boundedInteger,
  boundedNumeric,
  extractSearchRows,
  httpFailureCode,
  isOperationalFailure,
  normalizeAuthorityLevel,
  normalizeCategoryCode,
  parseExtractionContent,
  safeTextArray,
  safeTimestamp,
  searchDiagnostics,
  searchFailureFromError,
  shouldTryPlainJsonFallback,
  validateExtraction,
  type ExtractionFailureCode,
  type ExtractionOutcome,
  type SearchOutcome,
} from "./extraction.ts";
import {
  persistOpportunityFailClosed,
  type PersistRow,
  type PersistVerification,
} from "./persist.ts";
import {
  collectDetailTargets,
  extractDetailLinks,
  mergeDetailIntoExtraction,
  needsDetailEnrichment,
  parseAmounts,
  parseDeadline,
} from "./detail.ts";
import {
  csvToEvidenceText,
  htmlToEvidenceText,
  isAllowedOfficialUrl,
  isHtmlContentType,
  isCsvContentType,
  isPdfContentType,
  officialUrlVariants,
  pdfToEvidenceText,
  readLimitedBytes,
  readLimitedText,
  releaseLoadedPageBodies,
} from "./scrape.ts";
import {
  collectionCompletionOutcome,
  COVERAGE_WINDOW_HOURS,
  RUN_STALE_AFTER_MINUTES,
  boundedMaxPages,
  evaluateReleaseGate,
  nonNegativeSafeInteger,
  rankDueSources,
  sourceScrapeOperationalFailures,
  type DueSource,
  type SuccessfulRun,
} from "./hardening.ts";
import {
  CANDIDATE_MAX_POOL,
  canonicalCandidateUrl,
  dedupeCandidates,
  freshCandidates,
  rotateCandidates,
  sanitizeProviderQuery,
  shouldSkipPaidSearch,
  type CachedCandidate,
} from "./candidates.ts";
import {
  SEED_PROVIDER,
  extractSameDomainLinks,
  seedListingUrls,
} from "./seed.ts";
import {
  canSpendPaid,
  createPaidBudget,
  documentIsReadable,
  filterSourcesByLane,
  isCompleteVerified,
  normalizeLane,
  parseAllowPaid,
  readIncomingEngineSecret,
  shouldSkipExpiredRecrawl,
  shouldSkipPaidExtract,
  shouldUsePaidProvider,
  sourceLane,
  spendPaid,
  usableStoredEvidence,
  officialPageNeedsPaidScrape,
  allowBackfillPaidScrape,
  fallbackPaidOfficialPage,
  atecoPrefixesEmpty,
  fallbackPaidWhenAtecoEmpty,
  mergeBackfillPriorityPages,
  type CatalogueRow,
  type PaidBudget,
} from "./budget.ts";
import {
  extractApplyLinks,
  isFillablePdfUrl,
  resolveOfficialApplyUrls,
  shouldSkipApplyFetch,
} from "./apply-links.ts";
import {
  classifyOfficialListingUrl,
  isEligibleOfficialOpportunity,
  isIndexOrLandingUrl,
} from "./opportunity-gate.ts";
import {
  localExtractAteco,
  localExtractEligibleExpenses,
  localExtractProtocolEmail,
  localExtractRequirements,
  localOpportunityDraft,
} from "./local-fields.ts";
import {
  matchTerritorialSource,
  resolveOpportunityGeo,
} from "./geo.ts";
import {
  EXPIRE_VERIFICATION_STATUSES,
  OPEN_VERIFICATION_STATUSES,
  isProvenSportelloSenzaScadenza,
  officialVerificationStatus,
} from "./verification.ts";
import { computeVisibility } from "./rarity.ts";
import {
  CATALOG_MAX_LIMIT,
  CATALOG_SAFE_CAP,
  CATALOG_SELECT_COLUMNS,
  isCatalogRequest,
  isOfficialOpenCatalogRow,
  mapCatalogBando,
  parseCatalogPaging,
} from "./catalog.ts";

/** PostgREST rows-per-request hard ceiling; used for internal chunking. */
const CATALOG_POSTGREST_CHUNK = 1000;




type JsonObject = Record<string, unknown>;

type CompanyProfile = {
  forma_giuridica?: string;
  codice_ateco?: string;
  ateco_secondari?: string[];
  regione?: string;
  provincia?: string;
  comune?: string;
  numero_dipendenti?: number;
  fatturato_annuo?: number;
  anno_costituzione?: number;
  imprenditoria_femminile?: boolean;
  impresa_giovanile?: boolean;
  startup_innovativa?: boolean;
  pmi_innovativa?: boolean;
  dimensione_impresa?: string;
  investimenti_previsti?: string[];
  spesa_prevista?: number;
  de_minimis_ultimi_3_anni?: number;
  impresa_in_difficolta?: boolean;
  paese_sede?: string;
  disponibile_consorzio_europeo?: boolean;
};

type Source = {
  id: string;
  name: string;
  authority_level: string;
  region: string | null;
  province: string | null;
  official_domain: string;
  search_query: string;
  source_kind: string;
  rarity_base: number;
  fast_lane: boolean;
  scan_interval_minutes: number;
  priority: number;
  last_scanned_at: string | null;
  next_scan_at: string;
};

type RefreshSignal = {
  id: string;
  region: string | null;
  province: string | null;
  municipality: string | null;
  ateco_prefix: string | null;
  company_size: string | null;
  interest_categories: string[];
  female_business: boolean;
  youth_business: boolean;
  innovative_business: boolean;
};

type SearchHit = {
  url: string;
  title: string;
  description: string;
  provider: string;
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const ALLOWED_ACTIONS = new Set([
  "feed",
  "catalog",
  "request_refresh",
  "collect",
  "maintenance",
  "release_gate",
  "status",
  "backfill_nulls",
  "enrich_apply_urls",
]);

// Lovable edge idle timeout is 150s. Stop starting scrapes before that.
const BACKFILL_BUDGET_MS = 110_000;

const extractionSchema = {
  type: "json_schema",
  json_schema: {
    name: "trovabandi_opportunity",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "is_opportunity",
        "title",
        "authority_name",
        "category",
        "summary",
        "official_url",
        "requirements",
      ],
      properties: {
        is_opportunity: { type: "boolean" },
        title: { type: "string" },
        authority_name: { type: "string" },
        category: {
          type: "string",
          enum: [
            "FONDO_PERDUTO",
            "FINANZIAMENTO_AGEVOLATO",
            "TASSO_ZERO",
            "CREDITO_IMPOSTA",
            "GARANZIA",
            "VOUCHER",
            "IMPRENDITORIA_FEMMINILE",
            "IMPRENDITORIA_GIOVANILE",
            "DIGITALIZZAZIONE",
            "TRANSIZIONE_ENERGETICA",
            "RICERCA_SVILUPPO",
            "INTERNAZIONALIZZAZIONE",
            "STARTUP_INNOVAZIONE",
            "FORMAZIONE_OCCUPAZIONE",
            "AGRICOLTURA_RURALE",
            "TURISMO_CULTURA",
            "ECONOMIA_CIRCOLARE",
            "ALTRO",
          ],
        },
        summary: { type: "string" },
        official_url: { type: "string" },
        notice_url: { type: ["string", "null"] },
        application_url: { type: ["string", "null"] },
        forms_url: { type: ["string", "null"] },
        protocol_email: { type: ["string", "null"] },
        region: { type: ["string", "null"] },
        province: { type: ["string", "null"] },
        municipality: { type: ["string", "null"] },
        eligible_ateco_prefixes: { type: "array", items: { type: "string" } },
        excluded_ateco_prefixes: { type: "array", items: { type: "string" } },
        eligible_legal_forms: { type: "array", items: { type: "string" } },
        eligible_company_sizes: { type: "array", items: { type: "string" } },
        female_only: { type: "boolean" },
        youth_only: { type: "boolean" },
        startup_only: { type: "boolean" },
        innovative_only: { type: "boolean" },
        de_minimis: { type: ["boolean", "null"] },
        aid_intensity_percent: { type: ["number", "null"] },
        min_grant_amount: { type: ["number", "null"] },
        max_grant_amount: { type: ["number", "null"] },
        total_budget: { type: ["number", "null"] },
        opens_at: { type: ["string", "null"] },
        deadline_at: { type: ["string", "null"] },
        click_day: { type: "boolean" },
        requirements: { type: "array", items: { type: "string" } },
        eligible_expenses: { type: "array", items: { type: "string" } },
        publication_reference: { type: ["string", "null"] },
        programme_name: { type: ["string", "null"] },
        programme_code: { type: ["string", "null"] },
        pnrr_mission: { type: ["string", "null"] },
        pnrr_component: { type: ["string", "null"] },
        implementing_body: { type: ["string", "null"] },
        eligible_countries: { type: "array", items: { type: "string" } },
        consortium_required: { type: ["boolean", "null"] },
        min_partners: { type: ["integer", "null"] },
        direct_applicant_allowed: { type: ["boolean", "null"] },
      },
    },
  },
};

// Keep the service client type anchored to one factory. Deno's ungenerated
// Supabase schema otherwise resolves different generic overloads at call sites.
function createDb() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}
type Db = ReturnType<typeof createDb>;

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function env(name: string) {
  return Deno.env.get(name)?.trim() ?? "";
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCode(value: unknown): string {
  return normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeUrl(value: unknown): string | null {
  try {
    const u = new URL(normalizeText(value));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function hostMatches(url: string, domain: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const allowed = domain.toLowerCase().replace(/^www\./, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  } catch {
    return false;
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function safeSecretEqual(left: string, right: string) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isoOrNull(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const ITALIAN_MONTH_NAMES = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

// Mesi UE in inglese: nome completo + abbreviazioni ufficiali ammesse.
// Fail-closed: nessuna abbreviazione ambigua (es. "ma") e nessun match
// mese/anno senza giorno.
const ENGLISH_MONTH_FORMS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
];

function dateIsPresentInEvidence(markdown: string, iso: string | null) {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getUTCDate();
  const dd = String(day).padStart(2, "0");
  const month = date.getUTCMonth() + 1;
  const mm = String(month).padStart(2, "0");
  const year = date.getUTCFullYear();
  const normalized = markdown.toLowerCase();

  const literal = [
    `${year}-${mm}-${dd}`,
    `${dd}/${mm}/${year}`,
    `${day}/${month}/${year}`,
    `${dd}-${mm}-${year}`,
    `${day} ${ITALIAN_MONTH_NAMES[month - 1]} ${year}`,
  ];
  if (literal.some((candidate) => normalized.includes(candidate))) return true;

  // Date ufficiali UE in inglese: "15 September 2026", "September 15, 2026",
  // "15th Sept. 2026", con ordinali, virgola e spaziatura variabile.
  const monthPattern = ENGLISH_MONTH_FORMS[month - 1].join("|");
  const dayPattern = `0?${day}(?:st|nd|rd|th)?`;
  const sep = "[\\s\\u00a0]+";
  const dayFirst = new RegExp(
    `(?<![0-9])${dayPattern}(?:\\s*,)?${sep}(?:${monthPattern})\\.?(?:\\s*,)?${sep}${year}(?![0-9])`,
    "i",
  );
  const monthFirst = new RegExp(
    `(?<![a-z])(?:${monthPattern})\\.?${sep}${dayPattern}(?:\\s*,)?${sep}${year}(?![0-9])`,
    "i",
  );
  return dayFirst.test(normalized) || monthFirst.test(normalized);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))].slice(0, 100);
}

// BACKFILL_HELPERS_START
// Estrattori locali high-confidence usati SOLO dall'azione "backfill_nulls".
// Nessun provider a pagamento: lavorano sul markdown scaricato via HTTP
// ufficiale diretto (costo zero) e restano fail-closed: se il contesto non
// qualifica esplicitamente la data o l'importo, restituiscono null / {}.
const IT_MONTHS: Record<string, number> = {
  gennaio: 1,
  gen: 1,
  febbraio: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  aprile: 4,
  apr: 4,
  maggio: 5,
  mag: 5,
  giugno: 6,
  giu: 6,
  luglio: 7,
  lug: 7,
  agosto: 8,
  ago: 8,
  settembre: 9,
  sett: 9,
  set: 9,
  ottobre: 10,
  ott: 10,
  novembre: 11,
  nov: 11,
  dicembre: 12,
  dic: 12,
};

const EN_MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const IT_MONTH_ALT =
  "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|gen|feb|mar|apr|mag|giu|lug|ago|sett|set|ott|nov|dic";
const EN_MONTH_ALT =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

// Contesto che qualifica una data come termine di presentazione.
const DEADLINE_POSITIVE =
  /(scadenz\w*|scade\b|scadr\w*|entro\s+(?:e\s+non\s+oltre\s+)?(?:le\s+ore\s+[\d.:]+\s+)?(?:del\s+|il\s+|la\s+)?|termin[ei]\b(?:\s+(?:ultimo|finale|perentorio|di\s+scadenza|di\s+presentazione|per\s+la\s+presentazione))?|chiusura\s+(?:dello\s+)?sportello|sportello\s+chiude|presentazione\s+(?:delle\s+)?domande\s+(?:fino\s+al|entro)?|domande\s+entro|invio\s+entro|deadline|closing\s+date|closes?\b|submission\s+deadline|applications?\s+close|last\s+day)/g;

// Contesto che squalifica la data (apertura, pubblicazione, protocollo).
const DEADLINE_NEGATIVE =
  /(pubblicat\w*|pubblicazione|apertur\w*|si\s+apre|a\s+partire\s+dal|a\s+decorrere\s+dal|decorrenz\w*|dal\s+giorno|opens?\s+on|published|approvat\w*|deliberazione\s+del|decreto\s+del|aggiornat\w*)/g;

function lastIndexOfPattern(slice: string, re: RegExp): number {
  re.lastIndex = 0;
  let idx = -1;
  for (const m of slice.matchAll(re)) idx = Math.max(idx, m.index ?? -1);
  return idx;
}

/**
 * Punteggio di contesto per una data trovata a `idx`.
 * Ritorna null quando il contesto non qualifica la data come scadenza,
 * oppure quando una keyword di apertura/pubblicazione è più vicina.
 */
function deadlineContextScore(text: string, idx: number): number | null {
  const start = Math.max(0, idx - 140);
  const before = text.slice(start, idx);
  const after = text.slice(idx, Math.min(text.length, idx + 40));
  const pos = lastIndexOfPattern(before, DEADLINE_POSITIVE);
  const neg = lastIndexOfPattern(before, DEADLINE_NEGATIVE);
  if (pos < 0) {
    // Casi tipo "15 settembre 2026 (termine di presentazione)".
    if (
      lastIndexOfPattern(after, DEADLINE_POSITIVE) >= 0 &&
      lastIndexOfPattern(after, DEADLINE_NEGATIVE) < 0
    ) {
      return 4;
    }
    return null;
  }
  if (neg > pos) return null;
  const distance = before.length - pos;
  if (distance > 120) return null;
  return distance <= 30 ? 10 : distance <= 70 ? 7 : 4;
}

function isoFromParts(y: number, mo: number, d: number): string | null {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  if (y < 2025 || y > 2032) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString();
}

function normalizeForExtraction(markdown: string): string {
  return markdown
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[*_`>#]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Cookie/consent CMP shells are not official evidence. Typical Italian
 * banners: Accetta, Rifiuta, cookie tecnici, banner. Fail-closed: never
 * treat that markdown as a source of deadline / importo / geo.
 */
function isCookieConsentShell(markdown: string): boolean {
  const t = normalizeForExtraction(markdown);
  if (!t) return false;
  const signals = [
    /\bbanner\b/.test(t),
    /\baccetta\b/.test(t),
    /\brifiuta\b/.test(t),
    /\bcookie\s+tecnici\b/.test(t),
  ].filter(Boolean).length;
  if (signals < 2 || !/\bcookie/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const cookieWords = (t.match(
    /\b(?:cookie(?:s)?|accetta|rifiuta|banner|consenso|preferenze)\b/g,
  ) || []).length;
  // Shell vs footer: a real avviso is long and cookie tokens are sparse.
  return cookieWords / words.length >= 0.12;
}

function localExtractDeadline(markdown: string): string | null {
  if (isCookieConsentShell(markdown)) return null;
  const t = normalizeForExtraction(markdown);
  const candidates: { iso: string; score: number }[] = [];

  function add(iso: string | null, idx: number, bonus: number) {
    if (!iso) return;
    const ctx = deadlineContextScore(t, idx);
    if (ctx == null) return;
    candidates.push({ iso, score: ctx + bonus });
  }

  // 1) Numeriche: 30/09/2026, 30-09-2026, 30.09.2026
  for (
    const m of t.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})\b/g)
  ) {
    add(isoFromParts(+m[3], +m[2], +m[1]), m.index ?? 0, 2);
  }

  // 2) ISO: 2026-09-30
  for (const m of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    add(isoFromParts(+m[1], +m[2], +m[3]), m.index ?? 0, 2);
  }

  // 3) Italiane a lettere: 30 settembre 2026 / 30 sett. 2026
  for (
    const m of t.matchAll(
      new RegExp(`\\b(\\d{1,2})\\s*(?:°|º)?\\s+(${IT_MONTH_ALT})\\.?\\s+(20\\d{2})\\b`, "g"),
    )
  ) {
    add(isoFromParts(+m[3], IT_MONTHS[m[2]], +m[1]), m.index ?? 0, 3);
  }

  // 4) Inglesi: 15th September 2026 e September 15, 2026
  for (
    const m of t.matchAll(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${EN_MONTH_ALT})\\.?,?\\s+(20\\d{2})\\b`,
        "g",
      ),
    )
  ) {
    add(isoFromParts(+m[3], EN_MONTHS[m[2]], +m[1]), m.index ?? 0, 3);
  }
  for (
    const m of t.matchAll(
      new RegExp(
        `\\b(${EN_MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`,
        "g",
      ),
    )
  ) {
    add(isoFromParts(+m[3], EN_MONTHS[m[1]], +m[2]), m.index ?? 0, 3);
  }

  if (candidates.length === 0) return null;
  // Score più alto; a parità la data più vicina (conservativa).
  candidates.sort((a, b) =>
    b.score - a.score || a.iso.localeCompare(b.iso)
  );
  return candidates[0].iso;
}

/** Numeri italiani/europei: "250.000,00" → 250000, "356,4" → 356.4. */
function parseItalianNumber(raw: string): number | null {
  const s = raw.replace(/\s/g, "");
  let cleaned: string;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    cleaned = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+(,\d+)?$/.test(s)) {
    cleaned = s.replace(",", ".");
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    cleaned = s;
  } else {
    cleaned = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const WORD_NUMBERS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
  quindici: 15,
  venti: 20,
  venticinque: 25,
  trenta: 30,
  quaranta: 40,
  cinquanta: 50,
  sessanta: 60,
  settanta: 70,
  ottanta: 80,
  novanta: 90,
  cento: 100,
  duecento: 200,
  trecento: 300,
  cinquecento: 500,
};

const SCALE_FACTORS: Record<string, number> = {
  mila: 1_000,
  mln: 1_000_000,
  milione: 1_000_000,
  milioni: 1_000_000,
  mld: 1_000_000_000,
  miliardo: 1_000_000_000,
  miliardi: 1_000_000_000,
};

const MAX_KEYWORDS =
  /(fino\s+a|sino\s+a|massimo|massima|massimi|max\b|non\s+superiore\s+a|nel\s+limite\s+di|entro\s+il\s+limite\s+di|contributo\s+massimo(?:\s+concedibile)?|importo\s+massimo(?:\s+concedibile|\s+finanziabile)?|agevolazione\s+massima|up\s+to)/g;
const MIN_KEYWORDS =
  /(importo\s+minimo|contributo\s+minimo|minimo\s+di|almeno\s+pari\s+a|non\s+inferiore\s+a|soglia\s+minima|at\s+least)/g;
const BUDGET_KEYWORDS =
  /(dotazione(?:\s+finanziaria)?(?:\s+complessiva|\s+totale)?|budget(?:\s+complessivo|\s+totale)?|stanziament\w*|risorse(?:\s+disponibili|\s+complessive|\s+stanziate)?|plafond|fondo\s+(?:complessivo|disponibile)|total\s+budget|overall\s+budget)/g;

type AmountBucket = "min_grant_amount" | "max_grant_amount" | "total_budget";

// Contesti che NON sono contributo a fondo perduto: prestiti, spese
// ammissibili, investimenti, fatturato. Squalificano il bucket "massimo".
const NON_GRANT_CONTEXT =
  /(finanziament\w*|mutu\w*|prestit\w*|garanzi\w*|spesa\s+ammissibil\w*|spese\s+ammissibil\w*|costo\s+del\s+progetto|investiment\w*|fatturat\w*|ricav\w*|durata|ore\b|giornate)/g;

/** Classifica un importo in base alla keyword più vicina che lo precede. */
function amountBucket(text: string, idx: number): AmountBucket | null {
  const before = text.slice(Math.max(0, idx - 110), idx);
  const candidates: Array<{ bucket: AmountBucket; at: number }> = (
    [
      { bucket: "max_grant_amount", at: lastIndexOfPattern(before, MAX_KEYWORDS) },
      { bucket: "min_grant_amount", at: lastIndexOfPattern(before, MIN_KEYWORDS) },
      { bucket: "total_budget", at: lastIndexOfPattern(before, BUDGET_KEYWORDS) },
    ] as Array<{ bucket: AmountBucket; at: number }>
  ).filter((c) => c.at >= 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at - a.at);
  const winner = candidates[0];
  if (winner.bucket === "max_grant_amount") {
    // Se tra la keyword di massimo e la cifra compare un contesto di
    // prestito/spesa, la cifra non è un contributo massimo: fail-closed.
    const between = before.slice(winner.at);
    if (lastIndexOfPattern(between, NON_GRANT_CONTEXT) >= 0) return null;
  }
  return winner.bucket;
}

function plausibleAmount(n: number): boolean {
  return n >= 100 && n <= 100_000_000_000;
}


function localExtractAmounts(
  markdown: string,
): { min_grant_amount?: number; max_grant_amount?: number; total_budget?: number } {
  if (isCookieConsentShell(markdown)) return {};
  const t = normalizeForExtraction(markdown);
  const out: {
    min_grant_amount?: number;
    max_grant_amount?: number;
    total_budget?: number;
  } = {};

  function assign(bucket: AmountBucket | null, value: number) {
    if (!bucket || !plausibleAmount(value)) return;
    if (out[bucket] == null) out[bucket] = value;
  }

  // A) Cifre con eventuale scala: "€ 250.000,00", "356,4 milioni di euro",
  //    "1,5 mln", "500 mila euro".
  const numeric =
    /(€|eur\b|euro\b)?\s*(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(mila|milioni|milione|mln|miliardi|miliardo|mld)?\s*(?:di\s+)?(€|eur\b|euro\b)?/g;
  for (const m of t.matchAll(numeric)) {
    const prefixCur = !!m[1];
    const scale = m[3] ? SCALE_FACTORS[m[3]] : 1;
    const suffixCur = !!m[4];
    if (!prefixCur && !suffixCur) continue; // fail-closed: serve la valuta
    const base = parseItalianNumber(m[2]);
    if (!base) continue;
    assign(amountBucket(t, m.index ?? 0), base * scale);
  }

  // B) Importi a parole: "cinque milioni di euro", "un milione di euro".
  const words = new RegExp(
    `\\b(${Object.keys(WORD_NUMBERS).join("|")})\\s+(mila|milioni|milione|miliardi|miliardo)\\s*(?:di\\s+)?(?:€|eur|euro)\\b`,
    "g",
  );
  for (const m of t.matchAll(words)) {
    const base = WORD_NUMBERS[m[1]];
    const scale = SCALE_FACTORS[m[2]];
    if (!base || !scale) continue;
    assign(amountBucket(t, m.index ?? 0), base * scale);
  }

  // Coerenza minima: un minimo non può superare il massimo.
  if (
    out.min_grant_amount != null &&
    out.max_grant_amount != null &&
    out.min_grant_amount > out.max_grant_amount
  ) {
    delete out.min_grant_amount;
  }

  return out;
}
// BACKFILL_HELPERS_END

/**
 * Pagina indice/elenco: non è un avviso, è una lista di avvisi.
 * Riconoscimento deterministico sul path, nessuna inferenza sul contenuto.
 */
const LISTING_PATH =
  /(^\/?$|\/(index|home|homepage)(\.(html?|php|aspx))?$|\/(bandi|avvisi|bandi-e-avvisi|bandi_e_avvisi|contributi|opportunita|opportunit%c3%a0|finanziamenti|agevolazioni|elenco|elenchi|archivio|news|notizie|albo|amministrazione)(-[a-z0-9-]+)?\/?$)/i;

function isListingUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    if (/\.(pdf|docx?|xlsx?)$/i.test(path)) return false;
    if (LISTING_PATH.test(path)) return true;
    // Paginazioni tipiche degli elenchi.
    return /[?&](page|pagina|start|offset)=/i.test(parsed.search);
  } catch {
    return false;
  }
}

/** Link che sembra un avviso reale (bando/avviso/decreto/misura/sportello). */
const NOTICE_LINK_TOKENS =
  /(bando|bandi\/|avviso|avvisi\/|decreto|determina|misura|sportello|contributo|agevolazione)/i;

function looksLikeNoticeLink(link: { url: string; label: string }): boolean {
  const haystack = `${link.label} ${link.url}`;
  if (!NOTICE_LINK_TOKENS.test(haystack)) return false;
  return !isListingUrl(link.url);
}




/**
 * Ridondanza dei provider di ricerca (fail-closed conservativo).
 * Firecrawl e Perplexity sono fallback reciproci: se almeno uno è OK e ha
 * restituito almeno una hit ufficiale valida, il guasto dell'altro resta
 * diagnosticato e produce un warning informativo, ma non è un guasto
 * operativo. Se entrambi falliscono, oppure il superstite è OK senza hit,
 * ogni guasto resta operativo e il run degrada come oggi.
 */
type SearchRedundancyEntry = {
  phase: string;
  code: string;
  operational: boolean;
  hits: number;
};

type SearchRedundancyResult = {
  phase: string;
  code: string;
  operational: boolean;
  degraded: boolean;
};

function searchRedundancyOutcome(
  entries: SearchRedundancyEntry[],
): SearchRedundancyResult[] {
  const covered = entries.some((entry) => !entry.operational && entry.hits > 0);
  return entries.map((entry) => ({
    phase: entry.phase,
    code: entry.code,
    degraded: entry.operational,
    operational: entry.operational && !covered,
  }));
}


function inferCompanySize(profile: CompanyProfile) {
  if (profile.dimensione_impresa)
    return normalizeCode(profile.dimensione_impresa);
  const employees = Number(profile.numero_dipendenti ?? 0);
  const revenue = Number(profile.fatturato_annuo ?? 0);
  if (employees < 10 && revenue <= 2_000_000) return "MICRO";
  if (employees < 50 && revenue <= 10_000_000) return "PICCOLA";
  if (employees < 250 && revenue <= 50_000_000) return "MEDIA";
  return "GRANDE";
}

// Forme del profilo trattate come ditta individuale / persona fisica.
const SOLE_PROPRIETOR_FORMS = new Set([
  "DITTAINDIVIDUALE",
  "DI",
  "IMPRESAINDIVIDUALE",
  "PERSONAFISICA",
  "LAVORATOREAUTONOMO",
  "LIBEROPROFESSIONISTA",
]);

// Voci ufficiali che, se presenti, ammettono la ditta individuale.
const SOLE_PROPRIETOR_COMPATIBLE_FORMS = new Set([
  "MICRO",
  "MICROIMPRESA",
  "MICROIMPRESE",
  "PICCOLA",
  "PICCOLAIMPRESA",
  "PICCOLEIMPRESE",
  "PMI",
  "IMPRESE",
  "IMPRESA",
  "DI",
  "DITTAINDIVIDUALE",
  "IMPRESAINDIVIDUALE",
  "PERSONAFISICA",
  "LAVORATOREAUTONOMO",
]);

// Elenchi composti solo da società: blocco legittimo.
const COMPANY_ONLY_FORMS = new Set([
  "SRL",
  "SRLS",
  "SPA",
  "SNC",
  "SAS",
  "SAPA",
  "SOCIETA",
  "SOCIETADICAPITALI",
  "SOCIETADIPERSONE",
  "SOCIETACOOPERATIVA",
  "COOPERATIVA",
]);

function matchOpportunity(opportunity: JsonObject, profile: CompanyProfile) {
  const confirmed: string[] = [];
  const missing: string[] = [];
  const blockers: string[] = [];
  const level = normalizeCode(opportunity.authority_level);
  const region = normalizeCode(opportunity.region);
  const province = normalizeCode(opportunity.province);
  const profileRegion = normalizeCode(profile.regione);
  const profileProvince = normalizeCode(profile.provincia);

  if (level === "REGIONALE" && region) {
    if (region === profileRegion) confirmed.push("Sede nella regione ammessa");
    else blockers.push("Regione non ammessa");
  } else if ((level === "CAMERALE" || level === "COMUNALE") && province) {
    if (province === profileProvince)
      confirmed.push("Sede nella provincia ammessa");
    else blockers.push("Provincia non ammessa");
  } else {
    confirmed.push("Ambito territoriale compatibile");
  }

  if (level === "EU") {
    const countries = stringArray(opportunity.eligible_countries).map(
      normalizeCode,
    );
    const country = normalizeCode(profile.paese_sede || "IT");
    const italyAliases = new Set(["IT", "ITA", "ITALIA", "ITALY"]);
    const admitsItaly = countries.some(
      (item) =>
        italyAliases.has(item) ||
        item === "EU" ||
        item === "UE" ||
        item === "ALLEUMEMBERSTATES",
    );
    if (countries.length === 0)
      missing.push("Ammissibilità dell'Italia da verificare");
    else if (admitsItaly || countries.includes(country))
      confirmed.push("Italia tra i Paesi ammissibili");
    else blockers.push("Italia non indicata tra i Paesi ammissibili");
    if (opportunity.consortium_required === true) {
      if (profile.disponibile_consorzio_europeo)
        confirmed.push("Disponibilità al partenariato UE");
      else missing.push("Partenariato o consorzio europeo richiesto");
    }
  }

  const verified =
    normalizeCode(opportunity.verification_status) === "VERIFICATO";

  const atecos = [profile.codice_ateco, ...(profile.ateco_secondari ?? [])]
    .map(normalizeCode)
    .filter(Boolean);
  const included = stringArray(opportunity.eligible_ateco_prefixes).map(
    normalizeCode,
  );
  const excluded = stringArray(opportunity.excluded_ateco_prefixes).map(
    normalizeCode,
  );
  if (
    excluded.some((prefix) => atecos.some((ateco) => ateco.startsWith(prefix)))
  )
    blockers.push("Codice ATECO escluso");
  else if (included.length === 0)
    missing.push("ATECO da verificare nel testo ufficiale");
  else if (
    included.some((prefix) => atecos.some((ateco) => ateco.startsWith(prefix)))
  )
    confirmed.push("Codice ATECO ammesso");
  else if (verified) blockers.push("Codice ATECO non compreso");
  else missing.push("ATECO da verificare nel testo ufficiale");

  const forms = stringArray(opportunity.eligible_legal_forms).map(
    normalizeCode,
  );
  const profileForm = normalizeCode(profile.forma_giuridica);
  if (forms.length === 0) missing.push("Forma giuridica da verificare");
  else if (forms.includes(profileForm))
    confirmed.push("Forma giuridica ammessa");
  else if (SOLE_PROPRIETOR_FORMS.has(profileForm)) {
    if (forms.some((form) => SOLE_PROPRIETOR_COMPATIBLE_FORMS.has(form)))
      confirmed.push("Forma giuridica ammessa (ditta individuale)");
    else if (forms.every((form) => COMPANY_ONLY_FORMS.has(form)))
      blockers.push("Forma giuridica non ammessa: solo società");
    else missing.push("Forma giuridica da verificare");
  } else blockers.push("Forma giuridica non ammessa");

  const sizes = stringArray(opportunity.eligible_company_sizes).map(
    normalizeCode,
  );
  if (sizes.length === 0) missing.push("Dimensione impresa da verificare");
  else if (sizes.includes(inferCompanySize(profile)))
    confirmed.push("Dimensione impresa ammessa");
  else blockers.push("Dimensione impresa non ammessa");

  const category = normalizeCode(opportunity.category);
  if (
    profile.imprenditoria_femminile &&
    (opportunity.female_only === true || category === "IMPRENDITORIAFEMMINILE")
  )
    confirmed.push("Requisito imprenditoria femminile soddisfatto");
  if (
    category === "DIGITALIZZAZIONE" &&
    atecos.some((ateco) => ateco.startsWith("62") || ateco.startsWith("63"))
  )
    confirmed.push("Attività digitale allineata al bando");


  if (opportunity.female_only === true && !profile.imprenditoria_femminile)
    blockers.push("Riservato a imprese femminili");
  if (opportunity.youth_only === true && !profile.impresa_giovanile)
    blockers.push("Riservato a imprese giovanili");
  if (opportunity.startup_only === true && !profile.startup_innovativa)
    blockers.push("Riservato a startup innovative");
  if (
    opportunity.innovative_only === true &&
    !profile.startup_innovativa &&
    !profile.pmi_innovativa
  )
    blockers.push("Requisito impresa innovativa non presente");
  if (
    opportunity.de_minimis === true &&
    profile.de_minimis_ultimi_3_anni == null
  )
    missing.push("Plafond de minimis da verificare");
  if (profile.impresa_in_difficolta)
    missing.push("Verificare esclusione impresa in difficoltà");

  const status =
    blockers.length > 0
      ? "NON_COMPATIBILE"
      : missing.length === 0 && verified
        ? "COMPATIBILE"
        : "DA_VERIFICARE";
  const score =
    blockers.length > 0
      ? 0
      : Math.max(
          35,
          Math.min(
            100,
            45 +
              confirmed.length * 11 -
              missing.length * 5 +
              (verified ? 10 : 0),
          ),
        );
  return { status, score, confirmed, missing, blockers };
}

async function firecrawlSearch(
  source: Source,
): Promise<SearchOutcome<SearchHit>> {
  const key = env("FIRECRAWL_API_KEY");
  if (!key) return { ok: false, code: "NO_KEY" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: sanitizeProviderQuery(source.search_query),
        includeDomains: [source.official_domain],
        limit: 8,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, code: httpFailureCode(res.status) };
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, code: "PARSE_FAILED" };
    }
    const rows = extractSearchRows(payload, "firecrawl");
    if (!rows.ok) return { ok: false, code: rows.code };
    return {
      ok: true,
      hits: rows.rows.flatMap((row): SearchHit[] => {
        const item = row as JsonObject;
        const url = normalizeUrl(item.url);
        return url && hostMatches(url, source.official_domain)
          ? [
              {
                url,
                title: normalizeText(item.title),
                description: normalizeText(item.description),
                provider: "firecrawl",
              },
            ]
          : [];
      }),
    };
  } catch (error) {
    return { ok: false, code: searchFailureFromError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function perplexitySearch(
  source: Source,
): Promise<SearchOutcome<SearchHit>> {
  const key = env("PERPLEXITY_API_KEY");
  if (!key) return { ok: false, code: "NO_KEY" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: sanitizeProviderQuery(source.search_query),
        search_domain_filter: [source.official_domain],
        max_results: 8,
        max_tokens_per_page: 512,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, code: httpFailureCode(res.status) };
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, code: "PARSE_FAILED" };
    }
    const rows = extractSearchRows(payload, "perplexity");
    if (!rows.ok) return { ok: false, code: rows.code };
    return {
      ok: true,
      hits: rows.rows.flatMap((row): SearchHit[] => {
        const item = row as JsonObject;
        const url = normalizeUrl(item.url);
        return url && hostMatches(url, source.official_domain)
          ? [
              {
                url,
                title: normalizeText(item.title),
                description: normalizeText(item.snippet),
                provider: "perplexity",
              },
            ]
          : [];
      }),
    };
  } catch (error) {
    return { ok: false, code: searchFailureFromError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function scrapePage(
  url: string,
): Promise<{ markdown: string; title: string; provider: string } | null> {
  const key = env("FIRECRAWL_API_KEY");
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 21_600_000,
        timeout: 20_000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as JsonObject;
    const data = (payload.data ?? payload) as JsonObject;
    const markdown = normalizeText(data.markdown).slice(0, 60_000);
    const metadata = (data.metadata ?? {}) as JsonObject;
    return markdown.length > 200
      ? {
          markdown,
          title: normalizeText(metadata.title),
          provider: "firecrawl",
        }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apifyScrape(
  url: string,
): Promise<{ markdown: string; title: string; provider: string } | null> {
  const token = env("APIFY_TOKEN");
  if (!token) return null;
  const actor =
    env("TROVABANDI_APIFY_ACTOR_ID") || "apify~website-content-crawler";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=50&memory=512`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url }],
        maxCrawlPages: 1,
        crawlerType: "playwright:adaptive",
        saveMarkdown: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as JsonObject[];
    const item = rows[0] ?? {};
    const markdown = normalizeText(
      item.markdown || item.text || item.content,
    ).slice(0, 60_000);
    return markdown.length > 200
      ? { markdown, title: normalizeText(item.title), provider: "apify" }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const OFFICIAL_FETCH_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 UEradar/1.0 (+https://ueradar.com; official-grant-indexer)",
} as const;

const MAX_HTML_BYTES = 2_000_000;
const MAX_PDF_BYTES = 12_000_000;
const MAX_CSV_BYTES = 8_000_000;

/**
 * Pagina ufficiale scaricata. `html` è conservato soltanto per le risposte
 * HTML dirette: serve a individuare i link di dettaglio dello stesso dominio
 * senza un secondo download della pagina principale.
 */
type LoadedPage = {
  markdown: string;
  title: string;
  provider: string;
  html?: string;
  finalUrl?: string;
};

async function fetchOfficialVariant(
  url: string,
  officialDomain: string,
): Promise<LoadedPage | null> {
  if (!isAllowedOfficialUrl(url, officialDomain)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= 4; redirectCount++) {
      // SSRF guard: ogni hop deve restare nel dominio ufficiale.
      if (!isAllowedOfficialUrl(currentUrl, officialDomain)) return null;
      const res = await fetch(currentUrl, {
        redirect: "manual",
        headers: OFFICIAL_FETCH_HEADERS,
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location || redirectCount === 4) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const pdf = isPdfContentType(contentType);
      const csv = !pdf && isCsvContentType(contentType);
      if (!pdf && !csv && !isHtmlContentType(contentType)) {
        await res.body?.cancel();
        return null;
      }
      const declaredLength = Number(res.headers.get("content-length") ?? 0);
      const maxBytes = pdf
        ? MAX_PDF_BYTES
        : csv
          ? MAX_CSV_BYTES
          : MAX_HTML_BYTES;
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await res.body?.cancel();
        return null;
      }
      if (pdf) {
        const bytes = await readLimitedBytes(res, maxBytes);
        if (!bytes) return null;
        const parsed = await pdfToEvidenceText(bytes);
        const markdown = parsed.text.slice(0, 60_000);
        return markdown.length > 200
          ? { markdown, title: parsed.title, provider: "official-pdf" }
          : null;
      }
      if (csv) {
        const bytes = await readLimitedBytes(res, maxBytes);
        if (!bytes || bytes.byteLength === 0) return null;
        const parsed = csvToEvidenceText(bytes);
        const markdown = parsed.text.slice(0, 60_000);
        return markdown.length > 200
          ? { markdown, title: parsed.title, provider: "official-csv" }
          : null;
      }
      const raw = await readLimitedText(res, maxBytes);
      if (raw == null) return null;
      const isPlain = contentType.includes("text/plain");
      const parsed = isPlain
        ? { title: "", text: raw.trim() }
        : htmlToEvidenceText(raw);
      const markdown = parsed.text.slice(0, 60_000);
      return markdown.length > 200
        ? {
            markdown,
            title: parsed.title,
            provider: "official-http",
            html: isPlain ? undefined : raw,
            finalUrl: currentUrl,
          }
        : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Le fonti ufficiali italiane rispondono spesso soltanto su `www.`: si prova
 * ogni variante consentita dallo stesso dominio ufficiale, senza allargare la
 * whitelist. Nessuna variante fuori dominio viene mai richiesta.
 */
async function directOfficialScrape(
  url: string,
  officialDomain: string,
): Promise<LoadedPage | null> {
  for (const variant of officialUrlVariants(url)) {
    const result = await fetchOfficialVariant(variant, officialDomain);
    if (result) return result;
  }
  return null;
}

/**
 * Cache-first / direct-fetch-first: si tenta sempre prima l'HTTP ufficiale
 * diretto (costo provider zero) e solo dopo Firecrawl scrape e Apify.
 */
async function paidProviderScrape(url: string): Promise<LoadedPage | null> {
  // Un solo slot a pagamento per run: Firecrawl, poi Apify se il primo
  // non legge il documento. Nessuna seconda coppia di chiamate.
  const variants = officialUrlVariants(url).slice(0, 2);
  for (const variant of variants) {
    const scraped = await scrapePage(variant);
    if (!officialPageNeedsPaidScrape(scraped, isCookieConsentShell)) {
      return scraped;
    }
  }
  const apify = await apifyScrape(variants[variants.length - 1] ?? url);
  if (!officialPageNeedsPaidScrape(apify, isCookieConsentShell)) return apify;
  return null;
}

async function loadPage(
  url: string,
  officialDomain: string,
  budget?: PaidBudget,
) {
  const direct = await directOfficialScrape(url, officialDomain);
  if (!officialPageNeedsPaidScrape(direct, isCookieConsentShell)) {
    return direct;
  }
  if (!budget || !canSpendPaid(budget, "scrape")) return null;
  spendPaid(budget, "scrape");
  return paidProviderScrape(url);
}

/** Budget per run: nessuna esplosione del tempo di collect. */
const DETAIL_MAX_FETCH_PER_RUN = 60;
const DETAIL_MAX_FETCH_PER_HIT = 20;
const DETAIL_MAX_HOPS = 6;

export interface DetailEvidenceRow {
  source_url: string;
  source_title: string;
  evidence_type: "NOTICE" | "PDF";
  excerpt: string;
  fetched_at: string;
  content_hash: string;
}

function canonicalDetailUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * BFS fail-closed sulle pagine/PDF di dettaglio dello stesso dominio.
 * Al massimo DETAIL_MAX_FETCH_PER_HIT fetch per hit e DETAIL_MAX_HOPS hop.
 * Nessun provider a pagamento. Restituisce il numero di fetch tentati.
 */
async function walkDetailTargets(opts: {
  html: string;
  markdown?: string;
  baseUrl: string;
  officialDomain: string;
  declared?: string[];
  exclude: Iterable<string>;
  budget?: { remaining: number };
  stillNeeded: () => boolean;
  onPage: (target: string, detail: LoadedPage) => Promise<void> | void;
}): Promise<number> {
  if (!opts.stillNeeded()) return 0;
  if (opts.budget && opts.budget.remaining <= 0) return 0;

  const seen = new Set(
    [...opts.exclude].map((value) => canonicalDetailUrl(value)).filter(Boolean),
  );
  const queue: Array<{ url: string; hop: number }> = [];

  const enqueue = (urls: string[], hop: number) => {
    if (hop > DETAIL_MAX_HOPS) return;
    for (const url of urls) {
      const canonicalUrl = canonicalDetailUrl(url);
      if (!canonicalUrl || seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      queue.push({ url: canonicalUrl, hop });
    }
  };

  enqueue(
    collectDetailTargets({
      html: opts.html,
      markdown: opts.markdown,
      baseUrl: opts.baseUrl,
      officialDomain: opts.officialDomain,
      exclude: seen,
      declared: opts.declared,
      limit: DETAIL_MAX_FETCH_PER_HIT,
    }),
    1,
  );

  let attempted = 0;
  while (queue.length > 0) {
    if (opts.budget && opts.budget.remaining <= 0) break;
    if (attempted >= DETAIL_MAX_FETCH_PER_HIT) break;
    if (!opts.stillNeeded()) break;
    const item = queue.shift()!;
    if (opts.budget) opts.budget.remaining--;
    attempted++;
    const detail = await directOfficialScrape(item.url, opts.officialDomain);
    if (!detail) continue;
    await opts.onPage(item.url, detail);
    if (opts.stillNeeded() && item.hop < DETAIL_MAX_HOPS) {
      enqueue(
        collectDetailTargets({
          html: detail.html ?? "",
          markdown: detail.markdown,
          baseUrl: detail.finalUrl ?? item.url,
          officialDomain: opts.officialDomain,
          exclude: seen,
          limit: DETAIL_MAX_FETCH_PER_HIT,
        }),
        item.hop + 1,
      );
    }
    // Drop 2MB HTML / 60k markdown so the next hop does not retain this page.
    releaseLoadedPageBodies(detail, { markdown: true });
  }
  return attempted;
}

/**
 * Arricchimento a costo provider zero: BFS fino a 20 pagine o PDF di
 * dettaglio (max 6 hop, 60 fetch per run) già linkati sullo stesso dominio
 * ufficiale. Si riempiono soltanto scadenza e importi ancora nulli. Nessuna
 * chiamata a Firecrawl, Apify o all'estrattore AI. Fail-closed: qualunque
 * dubbio non scrive nulla.
 */
async function enrichFromDetailPages(
  source: Source,
  hit: SearchHit,
  page: LoadedPage,
  extracted: JsonObject,
  budget: { remaining: number },
): Promise<{
  patch: JsonObject;
  filled: string[];
  evidence: DetailEvidenceRow[];
  attempted: number;
}> {
  const result = {
    patch: {} as JsonObject,
    filled: [] as string[],
    evidence: [] as DetailEvidenceRow[],
    attempted: 0,
  };
  if (!needsDetailEnrichment(extracted)) return result;

  const state: JsonObject = { ...extracted };
  const now = new Date();

  // Passo 0 — la pagina ufficiale già scaricata: scadenza e importi si leggono
  // prima di tutto dal suo testo, senza alcun fetch aggiuntivo.
  const self = mergeDetailIntoExtraction(state, {
    deadline: parseDeadline(page.markdown, now),
    amounts: parseAmounts(page.markdown),
  });
  if (self.filled.length > 0) {
    Object.assign(state, self.patch);
    Object.assign(result.patch, self.patch);
    result.filled.push(...self.filled);
  }
  if (!needsDetailEnrichment(state)) return result;
  if (budget.remaining <= 0) return result;

  const exclude = [hit.url, page.finalUrl ?? hit.url];
  // I link dichiarati dall'estrazione hanno precedenza sui link della pagina.
  const declared = ["notice_url", "application_url", "forms_url"]
    .map((key) => normalizeUrl(extracted[key]))
    .filter(
      (url): url is string =>
        !!url &&
        isAllowedOfficialUrl(url, source.official_domain) &&
        !exclude.includes(url),
    );

  result.attempted = await walkDetailTargets({
    html: page.html ?? "",
    markdown: page.markdown,
    baseUrl: page.finalUrl ?? hit.url,
    officialDomain: source.official_domain,
    declared,
    exclude,
    budget,
    stillNeeded: () => needsDetailEnrichment(state),
    onPage: async (target, detail) => {
      const merged = mergeDetailIntoExtraction(state, {
        deadline: parseDeadline(detail.markdown, now),
        amounts: parseAmounts(detail.markdown),
      });
      if (merged.filled.length === 0) return;
      Object.assign(state, merged.patch);
      Object.assign(result.patch, merged.patch);
      result.filled.push(...merged.filled);
      result.evidence.push({
        source_url: target,
        source_title: `Dettaglio ufficiale — ${(detail.title || hit.title || "documento").slice(0, 400)}`,
        evidence_type: detail.provider === "official-pdf" ? "PDF" : "NOTICE",
        excerpt: detail.markdown.slice(0, 3000),
        fetched_at: now.toISOString(),
        content_hash: await sha256(detail.markdown),
      });
    },
  });
  return result;
}



// Client minimale: evita il mismatch dei generici Supabase nei checker Deno.
type CandidateClient = {
  from: (table: string) => any;
};

async function loadCachedCandidates(
  sb: CandidateClient,
  source: Source,
): Promise<CachedCandidate[]> {
  const cached = await sb
    .from("trovabandi_source_candidates")
    .select(
      "url,title,snippet,provider,discovered_at,last_seen_at,last_attempted_at,attempt_count,content_hash",
    )
    .eq("source_id", source.id)
    .order("last_attempted_at", { ascending: true, nullsFirst: true })
    .limit(CANDIDATE_MAX_POOL);
  const rows = (cached.data ?? []) as CachedCandidate[];
  const persisted = await sb
    .from("trovabandi_opportunities")
    .select("official_url,notice_url,updated_at,verification_status")
    .ilike("official_url", `%${source.official_domain}%`)
    .neq("verification_status", "SCADUTO")
    .order("updated_at", { ascending: false })
    .limit(100);
  const persistedRows: CachedCandidate[] = [];
  for (const row of (persisted.data ?? []) as JsonObject[]) {
    for (const key of ["official_url", "notice_url"]) {
      const url = canonicalCandidateUrl(row[key]);
      if (!url || !hostMatches(url, source.official_domain)) continue;
      persistedRows.push({
        url,
        provider: "persisted",
        discovered_at: normalizeText(row.updated_at) || null,
        last_seen_at: normalizeText(row.updated_at) || null,
      });
    }
  }
  return dedupeCandidates([...rows, ...persistedRows]);
}

async function upsertCandidates(
  sb: CandidateClient,
  source: Source,
  hits: SearchHit[],
): Promise<void> {
  if (hits.length === 0) return;
  const nowIso = new Date().toISOString();
  const rows = [];
  for (const hit of hits) {
    const url = canonicalCandidateUrl(hit.url);
    if (!url || !hostMatches(url, source.official_domain)) continue;
    rows.push({
      source_id: source.id,
      url,
      url_hash: await sha256(url.toLowerCase()),
      title: hit.title?.slice(0, 500) || null,
      snippet: hit.description?.slice(0, 1000) || null,
      provider: hit.provider?.slice(0, 120) || null,
      last_seen_at: nowIso,
      // Una nuova hit ufficial-domain riabilita esplicitamente l'URL: la sua
      // salute riparte da zero, mentre un eventuale content_hash valido resta.
      last_attempted_at: null,
      attempt_count: 0,
      updated_at: nowIso,
    });
  }
  if (rows.length === 0) return;
  // Replay-safe: la stessa hit ripetuta aggiorna soltanto last_seen_at.
  await sb
    .from("trovabandi_source_candidates")
    .upsert(rows as never, { onConflict: "source_id,url_hash" });
}

/**
 * Pagine di partenza ufficiali: quando il pool candidati è vuoto si parte
 * dalle sole listing già verificate del dominio ufficiale. HTTP diretto
 * (costo zero) e, se l'HTML è troppo corto, un solo scrape Firecrawl.
 * Dai link raccolti restano soltanto URL https dello stesso dominio.
 * Zero link è un esito onesto: nessuna scheda viene inventata.
 */
async function harvestSeedListings(
  sb: CandidateClient,
  source: Source,
  budget?: PaidBudget,
): Promise<SearchHit[]> {
  const seeds = seedListingUrls(source.official_domain);
  if (seeds.length === 0) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const seedUrl of seeds) {
    if (!hostMatches(seedUrl, source.official_domain)) continue;
    if (!seen.has(seedUrl)) {
      seen.add(seedUrl);
      hits.push({
        url: seedUrl,
        title: "",
        description: "",
        provider: SEED_PROVIDER,
      });
    }
    let page = await directOfficialScrape(seedUrl, source.official_domain);
    if (
      (!page || (page.html ?? page.markdown).length < 2_000) &&
      budget &&
      canSpendPaid(budget, "scrape")
    ) {
      spendPaid(budget, "scrape");
      const scraped = await scrapePage(seedUrl);
      if (scraped && scraped.markdown.length > (page?.markdown.length ?? 0)) {
        page = scraped;
      }
    }
    if (!page) continue;
    const links = extractSameDomainLinks(
      page.html ?? page.markdown,
      page.finalUrl ?? seedUrl,
      source.official_domain,
    );
    for (const link of links) {
      const canonical = canonicalCandidateUrl(link);
      if (!canonical || seen.has(canonical)) continue;
      if (!hostMatches(canonical, source.official_domain)) continue;
      seen.add(canonical);
      hits.push({
        url: canonical,
        title: "",
        description: "",
        provider: SEED_PROVIDER,
      });
    }
  }
  if (hits.length > 0) await upsertCandidates(sb, source, hits);
  return hits;
}



async function markCandidateAttempt(
  sb: CandidateClient,
  source: Source,
  url: string,
  previousAttempts: number,
  contentHash: string | null,
): Promise<void> {
  const canonical = canonicalCandidateUrl(url);
  if (!canonical) return;
  const nowIso = new Date().toISOString();
  await sb.from("trovabandi_source_candidates").upsert(
    {
      source_id: source.id,
      url: canonical,
      url_hash: await sha256(canonical.toLowerCase()),
      last_attempted_at: nowIso,
      // Il contatore misura i NO_CONTENT consecutivi: una pagina valida
      // ripristina la salute senza cancellare la sua evidenza/hash.
      attempt_count: contentHash ? 0 : previousAttempts + 1,
      content_hash: contentHash,
      updated_at: nowIso,
    } as never,
    { onConflict: "source_id,url_hash" },
  );
}

async function callExtraction(
  key: string,
  model: string,
  prompt: string,
  useSchema: boolean,
): Promise<
  { ok: true; content: string } | { ok: false; code: ExtractionFailureCode }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: useSchema
              ? "Sei un estrattore documentale prudente per bandi pubblici italiani, PNRR e programmi UE. Il testo fornito è l'unica autorità."
              : "Sei un estrattore documentale prudente per bandi pubblici italiani, PNRR e programmi UE. Il testo fornito è l'unica autorità. Rispondi esclusivamente con un singolo oggetto JSON valido, senza testo aggiuntivo e senza blocchi di codice.",
          },
          { role: "user", content: prompt },
        ],
        ...(useSchema ? { response_format: extractionSchema } : {}),
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Il corpo non viene letto né registrato: solo la classe HTTP sanificata.
      await res.body?.cancel();
      return { ok: false, code: httpFailureCode(res.status) };
    }
    const payload = (await res.json()) as JsonObject;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = ((choices[0] as JsonObject | undefined)?.message ??
      {}) as JsonObject;
    return { ok: true, content: normalizeText(message.content) };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error && error.name === "AbortError"
          ? "TIMEOUT"
          : "HTTP_ERROR",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function extractOpportunity(
  source: Source,
  hit: SearchHit,
  markdown: string,
): Promise<ExtractionOutcome> {
  const key = env("PERPLEXITY_API_KEY");
  if (!key) return { ok: false, code: "NO_KEY" };
  const model = env("TROVABANDI_PERPLEXITY_MODEL") || "sonar-pro";
  const schemaHint = `Campi ammessi: is_opportunity (boolean), title, authority_name, category (uno tra FONDO_PERDUTO, FINANZIAMENTO_AGEVOLATO, TASSO_ZERO, CREDITO_IMPOSTA, GARANZIA, VOUCHER, IMPRENDITORIA_FEMMINILE, IMPRENDITORIA_GIOVANILE, DIGITALIZZAZIONE, TRANSIZIONE_ENERGETICA, RICERCA_SVILUPPO, INTERNAZIONALIZZAZIONE, STARTUP_INNOVAZIONE, FORMAZIONE_OCCUPAZIONE, AGRICOLTURA_RURALE, TURISMO_CULTURA, ECONOMIA_CIRCOLARE, ALTRO), summary, official_url, notice_url, application_url, forms_url, protocol_email, region, province, municipality, eligible_ateco_prefixes[], excluded_ateco_prefixes[], eligible_legal_forms[], eligible_company_sizes[], female_only, youth_only, startup_only, innovative_only, de_minimis, aid_intensity_percent, min_grant_amount, max_grant_amount, total_budget, opens_at, deadline_at, click_day, requirements[], eligible_expenses[], publication_reference, programme_name, programme_code, pnrr_mission, pnrr_component, implementing_body, eligible_countries[], consortium_required, min_partners, direct_applicant_allowed.`;
  const prompt = `Estrai esclusivamente dati presenti nel testo ufficiale seguente. Non dedurre requisiti, date, importi, percentuali o ATECO mancanti. Non inventare 62 / 62.10.00 da "digitale/software/innovazione". Un prefisso ATECO solo se il testo stampa il codice. Se l'avviso è a sportello senza data di chiusura (a sportello, fino a esaurimento, senza scadenza, non ha scadenza), lascia deadline_at null: non inventare una scadenza. Se la pagina non descrive un bando, incentivo o finanziamento per imprese aperto, in apertura o con documentazione ancora rilevante, imposta is_opportunity=false. official_url deve essere ${hit.url}. Date ISO 8601. Prefissi ATECO senza punteggiatura superflua. Per opportunità UE estrai programma, codice call/topic, Paesi ammessi e obbligo/minimo partner. Per PNRR estrai Missione, Componente e soggetto attuatore soltanto se espliciti.\n${schemaHint}\n\n${markdown}`;

  // Massimo due tentativi: schema JSON, poi eventuale fallback plain JSON.
  const modes: Array<"json_schema" | "json_fallback"> = [
    "json_schema",
    "json_fallback",
  ];
  let lastFailure: ExtractionOutcome = { ok: false, code: "UNKNOWN" };
  for (const mode of modes) {
    const call = await callExtraction(
      key,
      model,
      prompt,
      mode === "json_schema",
    );
    if (!call.ok) {
      lastFailure = { ok: false, code: call.code, mode };
      // Nessun retry su 401/402/403/429/5xx/timeout: sono errori operativi.
      if (!shouldTryPlainJsonFallback(call.code)) return lastFailure;
      continue;
    }
    const parsed = parseExtractionContent(call.content);
    if (!parsed.ok) {
      lastFailure = { ok: false, code: parsed.code, mode };
      if (!shouldTryPlainJsonFallback(parsed.code)) return lastFailure;
      continue;
    }
    const validated = validateExtraction(
      parsed.value,
      source.official_domain,
      hit.url,
    );
    if (!validated.ok) {
      // Contenuto leggibile ma non ammissibile: fail-closed, nessun retry.
      return { ok: false, code: validated.code, mode };
    }
    return { ok: true, data: validated.data, mode };
  }
  return lastFailure;
}

async function storeOpportunity(
  sb: Db,
  source: Source,
  hit: SearchHit,
  extracted: JsonObject,
  markdown: string,
  extractionProvider: string,
  extraEvidence: DetailEvidenceRow[] = [],
  page?: LoadedPage | null,
  existing?: CatalogueRow | null,
): Promise<{ stored: boolean; verified: boolean; code: string }> {
  const officialUrl = normalizeUrl(hit.url);
  if (!officialUrl || !hostMatches(officialUrl, source.official_domain))
    return { stored: false, verified: false, code: "OFF_DOMAIN" };
  const applyUrls = resolveOfficialApplyUrls({
    html: page?.html,
    markdown,
    officialUrl,
    officialDomain: source.official_domain,
    extractedForms: extracted.forms_url,
    extractedApplication: extracted.application_url,
    existingForms: existing?.forms_url,
    existingApplication: existing?.application_url,
  });

  const now = new Date();
  const hasEvidence =
    markdown.length > 200 && source.official_domain.length > 3;
  // La prova può stare nella pagina principale oppure nel documento di
  // dettaglio ufficiale letto nello stesso run: entrambi sono evidenza salvata.
  const proofText = [markdown, ...extraEvidence.map((row) => row.excerpt)].join(
    "\n",
  );
  // Fail-closed: scadenza solo se il testo ufficiale la stampa. Il modello
  // non inventa date. Sportello senza chiusura ⇒ deadline_at resta NULL.
  const localDeadline = localExtractDeadline(proofText);
  const extractedDeadline = safeTimestamp(extracted.deadline_at);
  const sportelloSenzaScadenza =
    isProvenSportelloSenzaScadenza(proofText) && !localDeadline;
  const deadline = sportelloSenzaScadenza
    ? null
    : localDeadline ??
      (dateIsPresentInEvidence(proofText, extractedDeadline)
        ? extractedDeadline
        : null);
  const deadlineProven = dateIsPresentInEvidence(proofText, deadline);
  const maxGrant = boundedNumeric(extracted.max_grant_amount, 15, 2);
  const verification: PersistVerification = officialVerificationStatus({
    hasEvidence,
    deadline,
    deadlineProven,
    maxGrantAmount: maxGrant,
    sportelloSenzaScadenza,
    now,
  });
  const contentHash = await sha256(markdown);
  const canonicalKey = await sha256(officialUrl.toLowerCase());
  const discoveredBy = safeTextArray([
    ...new Set(
      hit.provider.split("+").concat(extractionProvider, "perplexity"),
    ),
  ]);
  // Valori vincolati da CHECK: mai inventati e mai degradati in un valore
  // plausibile. Categoria non ammessa ⇒ rifiuto fail-closed.
  const category = normalizeCategoryCode(extracted.category);
  if (!category)
    return { stored: false, verified: false, code: "CATEGORY_INVALID" };
  const authorityLevel = normalizeAuthorityLevel(source.authority_level);
  if (!authorityLevel)
    return { stored: false, verified: false, code: "AUTHORITY_LEVEL_INVALID" };
  // Bandi locali/rari: nascosti ai competitor e con rarity alta.
  const visibility = computeVisibility(
    {
      authority_level: authorityLevel,
      source_kind: source.source_kind,
      rarity_base: source.rarity_base,
      name: source.name,
    },
    officialUrl,
  );



  const row = {
    canonical_key: canonicalKey,
    title:
      normalizeText(extracted.title).slice(0, 500) ||
      hit.title ||
      "Opportunità senza titolo",
    authority_name:
      normalizeText(extracted.authority_name).slice(0, 300) || source.name,
    authority_level: authorityLevel,
    category,
    summary:
      normalizeText(extracted.summary).slice(0, 5000) ||
      hit.description ||
      "Dettagli nella fonte ufficiale.",
    official_url: officialUrl,
    notice_url: normalizeUrl(extracted.notice_url),
    application_url: applyUrls.application_url,
    forms_url: applyUrls.forms_url,
    protocol_email:
      normalizeText(extracted.protocol_email).slice(0, 320) || null,
    // Geo fail-closed: testo ufficiale / host territoriale / seed fonte.
    // Mai ATECO, mai inventare. Non azzera un valore già persistito.
    ...(() => {
      const geo = resolveOpportunityGeo({
        markdown: proofText,
        officialUrl,
        source,
      });
      return {
        region: geo.region || existing?.region || null,
        province: geo.province || existing?.province || null,
        municipality: geo.municipality || existing?.municipality || null,
      };
    })(),
    // ATECO solo dal testo ufficiale già in mano: mai i prefix inventati
    // dal modello (es. 62 da "digitalizzazione"). Fail-closed.
    eligible_ateco_prefixes: localExtractAteco(proofText),
    excluded_ateco_prefixes: safeTextArray(extracted.excluded_ateco_prefixes),
    eligible_legal_forms: safeTextArray(extracted.eligible_legal_forms),
    eligible_company_sizes: safeTextArray(extracted.eligible_company_sizes),
    female_only: extracted.female_only === true,
    youth_only: extracted.youth_only === true,
    startup_only: extracted.startup_only === true,
    innovative_only: extracted.innovative_only === true,
    de_minimis:
      typeof extracted.de_minimis === "boolean" ? extracted.de_minimis : null,
    // numeric(6,2) / numeric(15,2) / numeric(18,2): overflow ⇒ dato assente.
    aid_intensity_percent: boundedNumeric(
      extracted.aid_intensity_percent,
      6,
      2,
    ),
    min_grant_amount: boundedNumeric(extracted.min_grant_amount, 15, 2),
    max_grant_amount: maxGrant,
    total_budget: boundedNumeric(extracted.total_budget, 18, 2),
    opens_at: safeTimestamp(extracted.opens_at),
    deadline_at: deadline,
    click_day: extracted.click_day === true,
    requirements: (() => {
      const local = localExtractRequirements(proofText);
      return local.length ? local : safeTextArray(extracted.requirements, 100, 1000);
    })(),
    eligible_expenses: (() => {
      const local = localExtractEligibleExpenses(proofText);
      return local.length ? local : safeTextArray(extracted.eligible_expenses, 100, 1000);
    })(),
    rarity_score: visibility.rarity_score,
    is_hidden: visibility.is_hidden,
    source_kind: normalizeText(source.source_kind).slice(0, 60) || "CATALOGO",
    publication_reference:
      normalizeText(extracted.publication_reference).slice(0, 300) || null,
    programme_name:
      normalizeText(extracted.programme_name).slice(0, 300) || null,
    programme_code:
      normalizeText(extracted.programme_code).slice(0, 120) || null,
    pnrr_mission: normalizeText(extracted.pnrr_mission).slice(0, 120) || null,
    pnrr_component:
      normalizeText(extracted.pnrr_component).slice(0, 120) || null,
    implementing_body:
      normalizeText(extracted.implementing_body).slice(0, 300) || null,
    eligible_countries: safeTextArray(extracted.eligible_countries),
    consortium_required:
      typeof extracted.consortium_required === "boolean"
        ? extracted.consortium_required
        : null,
    min_partners: boundedInteger(extracted.min_partners, 0, 2_147_483_647),
    direct_applicant_allowed:
      typeof extracted.direct_applicant_allowed === "boolean"
        ? extracted.direct_applicant_allowed
        : null,
    official_source: true,
    discovered_by: discoveredBy,
    content_hash: contentHash,
    raw_excerpt: markdown.slice(0, 4000),
    last_seen_at: now.toISOString(),
  };
  // Ordine fail-closed: DA_VERIFICARE ⇒ evidence ⇒ promozione.
  return await persistOpportunityFailClosed(
    {
      async upsertOpportunity(candidate) {
        const { data, error } = await sb
          .from("trovabandi_opportunities")
          .upsert(candidate as never, { onConflict: "official_url" })
          .select("id")
          .single();
        return {
          id: (data as { id?: string } | null)?.id ?? null,
          error: error ?? undefined,
        };
      },
      async upsertEvidence(candidate) {
        const { error } = await sb
          .from("trovabandi_evidence")
          .upsert(candidate as never, {
            onConflict: "opportunity_id,source_url",
          });
        return { error: error ?? undefined };
      },
      async promote(id, patch) {
        const { error } = await sb
          .from("trovabandi_opportunities")
          .update(patch as never)
          .eq("id", id);
        return { error: error ?? undefined };
      },
    },
    {
      row,
      evidence: {
        source_url: officialUrl,
        source_title: (hit.title || (row.title as string)).slice(0, 500),
        evidence_type: officialUrl.toLowerCase().includes(".pdf")
          ? "PDF"
          : "OFFICIAL_PAGE",
        excerpt: markdown.slice(0, 3000),
        fetched_at: now.toISOString(),
        content_hash: contentHash,
      },
      extraEvidence: extraEvidence as unknown as PersistRow[],
      verification,
      nowIso: now.toISOString(),

    },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return response(204, {});
  if (req.method !== "POST")
    return response(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  if (req.headers.get("origin"))
    return response(403, { ok: false, code: "SERVER_TO_SERVER_ONLY" });
  // Auth server-to-server: segreto dedicato TrovaBandi oppure il segreto job
  // del Central Core (dispatch da pg_cron/DB). Confronto timing-safe.
  const secret = env("AI_CORE_SECRET_TROVABANDI");
  const jobSecret = env("CENTRAL_CORE_JOB_SECRET");
  const supplied = readIncomingEngineSecret(req.headers);
  if (!secret && !jobSecret)
    return response(503, { ok: false, code: "AUTH_NOT_CONFIGURED" });
  const authorized =
    (!!secret && (await safeSecretEqual(secret, supplied))) ||
    (!!jobSecret && (await safeSecretEqual(jobSecret, supplied)));
  if (!authorized) return response(401, { ok: false, code: "UNAUTHORIZED" });


  let body: JsonObject;
  try {
    body = await req.json();
  } catch {
    return response(400, { ok: false, code: "INVALID_JSON" });
  }
  const action = normalizeText(body.action || "feed");
  if (!ALLOWED_ACTIONS.has(action))
    return response(400, { ok: false, code: "INVALID_ACTION" });

  const sb = createDb();

  if (action === "status") {
    const nowIso = new Date().toISOString();
    const [activeResult, runResult] = await Promise.all([
      sb
        .from("trovabandi_opportunities")
        .select("id", { count: "exact", head: true })
        .in("verification_status", ["VERIFICATO", "PARZIALE", "SPORTELLO"])
        .or(`deadline_at.is.null,deadline_at.gte.${nowIso}`),
      sb
        .from("trovabandi_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (activeResult.error || runResult.error || activeResult.count == null) {
      return response(503, { ok: false, code: "STATUS_QUERY_FAILED" });
    }
    return response(200, {
      ok: true,
      active: activeResult.count,
      last_run: runResult.data ?? null,
      providers: {
        firecrawl: !!env("FIRECRAWL_API_KEY"),
        perplexity: !!env("PERPLEXITY_API_KEY"),
        apify: !!env("APIFY_TOKEN"),
      },
    });
  }

  if (action === "backfill_nulls") {
    const maxBatch = Math.min(400, Math.max(1, Number(body.max_batch) || 250));
    // Default: SCRIVE. Il dry-run resta opt-in esplicito (dry_run === true).
    const dryRun = body.dry_run === true;

    // Opt-in esplicito: usa l'estrattore Perplexity già esistente SOLO come
    // fallback sui campi ancora NULL. Lo scrape a pagamento (Firecrawl/Apify)
    // parte se il fetch ufficiale è vuoto/cookie shell, oppure se dopo
    // l'estrazione locale eligible_ateco_prefixes è ancora vuoto.
    const allowPaidExtract = body.allow_paid_extract === true &&
      !!env("PERPLEXITY_API_KEY");
    const allowPaidScrape = allowBackfillPaidScrape(
      body.allow_paid_scrape,
      !!env("FIRECRAWL_API_KEY"),
      !!env("APIFY_TOKEN"),
    );
    let paidCalls = 0;
    const nowIso = new Date().toISOString();

    const backfillSelect = () =>
      sb
        .from("trovabandi_opportunities")
        .select(
          "id, official_url, notice_url, deadline_at, min_grant_amount, max_grant_amount, total_budget, verification_status, raw_excerpt, last_seen_at, authority_level, application_url, forms_url, protocol_email, eligible_ateco_prefixes, region, province, municipality",
        )
        .in("verification_status", [...OPEN_VERIFICATION_STATUSES])
        .or(`deadline_at.is.null,deadline_at.gte.${nowIso}`)
        .or(
          "deadline_at.is.null,min_grant_amount.is.null,max_grant_amount.is.null,total_budget.is.null,application_url.is.null,forms_url.is.null,protocol_email.is.null,eligible_ateco_prefixes.eq.{},region.is.null,province.is.null,municipality.is.null",
        )
        .order("last_seen_at", { ascending: true, nullsFirst: true })
        .limit(maxBatch);

    // PostgREST cannot CASE-order Veneto then NAZIONALE/EU. Two-step select;
    // merge in JS. max_batch stays the packet size (GHA default 1 for jpunn).
    const { data: venetoRows, error: venetoErr } = await backfillSelect().ilike(
      "region",
      "%Veneto%",
    );
    if (venetoErr) {
      return response(500, { ok: false, code: "BACKFILL_SELECT_FAILED" });
    }
    let rows = mergeBackfillPriorityPages([venetoRows ?? []], maxBatch);
    if (rows.length < maxBatch) {
      const { data: nationalRows, error: nationalErr } = await backfillSelect()
        .in("authority_level", ["NAZIONALE", "EU"]);
      if (nationalErr) {
        return response(500, { ok: false, code: "BACKFILL_SELECT_FAILED" });
      }
      rows = mergeBackfillPriorityPages(
        [rows, nationalRows ?? []],
        maxBatch,
      );
    }
    if (rows.length < maxBatch) {
      const { data: restRows, error: restErr } = await backfillSelect();
      if (restErr || !restRows) {
        return response(500, { ok: false, code: "BACKFILL_SELECT_FAILED" });
      }
      rows = mergeBackfillPriorityPages([rows, restRows], maxBatch);
    }

    const { data: territorialSources } = await sb
      .from("trovabandi_sources")
      .select("name, authority_level, region, province, official_domain")
      .eq("enabled", true)
      .in("authority_level", ["REGIONALE", "CAMERALE", "COMUNALE"]);

    const results: any[] = [];
    let updated = 0;
    let skipped = 0;
    let truncated = false;
    let attempted = 0;
    const deadline = Date.now() + BACKFILL_BUDGET_MS;
    const triggerSource =
      normalizeText(body.trigger_source).slice(0, 64) || "manual";

    // Empty / cookie-shell / unusable rows must leave the oldest-nulls
    // queue: bump last_seen_at + updated_at only. Never invent fields.
    const rotateQueueCursor = async (id: string, status: string) => {
      const touch = { last_seen_at: nowIso, updated_at: nowIso };
      if (dryRun) {
        results.push({ id, status, would_patch: touch });
        skipped++;
        return;
      }
      const { error: rotErr } = await sb
        .from("trovabandi_opportunities")
        .update(touch)
        .eq("id", id);
      if (rotErr) {
        results.push({ id, status: "UPDATE_FAILED" });
        skipped++;
        return;
      }
      results.push({ id, status, patch: touch });
      skipped++;
    };

    for (const row of rows) {
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      attempted++;
      let page: LoadedPage | null = null;
      try {
        if (shouldSkipExpiredRecrawl(row as CatalogueRow)) {
          await rotateQueueCursor(row.id, "SKIPPED_EXPIRED");
          continue;
        }
        let domain = "";
        try {
          domain = new URL(row.official_url).hostname
            .replace(/^www\./i, "")
            .toLowerCase();
        } catch {
          await rotateQueueCursor(row.id, "BAD_URL");
          continue;
        }

        const storedRaw = usableStoredEvidence(row.raw_excerpt);
        const stored = storedRaw && !isCookieConsentShell(storedRaw)
          ? storedRaw
          : null;
        page = shouldSkipApplyFetch(row.official_url)
          ? null
          : await directOfficialScrape(row.official_url, domain);
        if (officialPageNeedsPaidScrape(page, isCookieConsentShell) && stored) {
          page = {
            markdown: stored,
            title: "",
            provider: "stored-excerpt",
          };
        }
        const paidBudget = createPaidBudget(allowPaidScrape);
        if (
          officialPageNeedsPaidScrape(page, isCookieConsentShell) &&
          !shouldSkipApplyFetch(row.official_url)
        ) {
          page = await fallbackPaidOfficialPage(page, {
            isCookieShell: isCookieConsentShell,
            loadPage: () => loadPage(row.official_url, domain, paidBudget),
          });
        }
        if (
          !page ||
          page.markdown.length < 200 ||
          isCookieConsentShell(page.markdown)
        ) {
          await rotateQueueCursor(row.id, "SCRAPE_EMPTY");
          continue;
        }

        // 1) Se l'URL ufficiale è un indice/elenco, seguo i link stesso host
        //    che sembrano un avviso reale e leggo la prima scheda vera.
        let noticeUrl: string | null = null;
        const pageUrl = page.finalUrl ?? row.official_url;
        if (page.html && isListingUrl(pageUrl)) {
          const noticeCandidates = extractDetailLinks(
            page.html,
            pageUrl,
            domain,
            { limit: 6, exclude: [row.official_url, pageUrl] },
          ).filter(looksLikeNoticeLink);
          for (const candidate of noticeCandidates.slice(0, 3)) {
            const notice = await directOfficialScrape(candidate.url, domain);
            if (!notice || notice.markdown.length < 200 || isCookieConsentShell(notice.markdown)) continue;
            page = notice;
            noticeUrl = notice.finalUrl ?? candidate.url;
            break;
          }
        }

        const patch: Record<string, unknown> = {};
        // La scheda reale dell'avviso è preferita all'elenco.
        if (noticeUrl && noticeUrl !== row.notice_url) {
          patch.notice_url = noticeUrl;
        }
        const pageDeadline = localExtractDeadline(page.markdown);
        const sportelloSenzaScadenza =
          isProvenSportelloSenzaScadenza(page.markdown) && !pageDeadline;
        if (sportelloSenzaScadenza) {
          // Citazione ufficiale: niente chiusura. Non inventare una data.
          patch.deadline_at = null;
        } else if (row.deadline_at == null && pageDeadline) {
          patch.deadline_at = pageDeadline;
        }

        const amounts = localExtractAmounts(page.markdown);
        if (row.min_grant_amount == null && amounts.min_grant_amount != null) {
          patch.min_grant_amount = amounts.min_grant_amount;
        }
        if (row.max_grant_amount == null && amounts.max_grant_amount != null) {
          patch.max_grant_amount = amounts.max_grant_amount;
        }
        if (row.total_budget == null && amounts.total_budget != null) {
          patch.total_budget = amounts.total_budget;
        }
        const applyUrls = resolveOfficialApplyUrls({
          html: page.html,
          markdown: page.markdown,
          officialUrl: row.official_url,
          officialDomain: domain,
          existingForms: row.forms_url,
          existingApplication: row.application_url,
        });
        if (applyUrls.application_url) {
          if (applyUrls.application_url !== row.application_url) {
            patch.application_url = applyUrls.application_url;
          }
        } else if (row.application_url) {
          patch.application_url = null;
        }
        if (applyUrls.forms_url) {
          if (applyUrls.forms_url !== row.forms_url) {
            patch.forms_url = applyUrls.forms_url;
          }
        } else if (row.forms_url) {
          patch.forms_url = null;
        }
        if (!row.protocol_email) {
          const pec = localExtractProtocolEmail(page.markdown);
          if (pec) patch.protocol_email = pec;
        }
        const existingAteco = Array.isArray(row.eligible_ateco_prefixes)
          ? row.eligible_ateco_prefixes.map((item) => String(item))
          : [];
        let ateco = localExtractAteco(page.markdown);
        // Readable INDEX HTML without ATECO still spends one paid scrape
        // (Firecrawl then Apify) on official_url and notice_url.
        if (
          atecoPrefixesEmpty(existingAteco) &&
          atecoPrefixesEmpty(ateco) &&
          canSpendPaid(paidBudget, "scrape")
        ) {
          const noticeCandidate =
            (typeof patch.notice_url === "string" ? patch.notice_url : null) ||
            noticeUrl ||
            (typeof row.notice_url === "string" ? row.notice_url : null);
          spendPaid(paidBudget, "scrape");
          const paidAteco = await fallbackPaidWhenAtecoEmpty(ateco, {
            officialUrl: row.official_url,
            noticeUrl: noticeCandidate,
            extractAteco: localExtractAteco,
            isCookieShell: isCookieConsentShell,
            loadPage: async (url) => {
              if (shouldSkipApplyFetch(url)) return null;
              // HTTP already readable: skip direct fetch, Firecrawl then Apify.
              return paidProviderScrape(url);
            },
          });
          if (!atecoPrefixesEmpty(paidAteco.ateco)) {
            ateco = paidAteco.ateco;
          }
        }
        const sameAteco =
          existingAteco.length === ateco.length &&
          existingAteco.every((prefix) => ateco.includes(prefix)) &&
          ateco.every((prefix) => existingAteco.includes(prefix));
        if (!sameAteco) patch.eligible_ateco_prefixes = ateco;
        const existingReq = Array.isArray(row.requirements) ? row.requirements : [];
        if (existingReq.length === 0) {
          const req = localExtractRequirements(page.markdown);
          if (req.length) patch.requirements = req;
        }
        const existingExp = Array.isArray(row.eligible_expenses)
          ? row.eligible_expenses
          : [];
        if (existingExp.length === 0) {
          const exp = localExtractEligibleExpenses(page.markdown);
          if (exp.length) patch.eligible_expenses = exp;
        }
        const needsGeo =
          !normalizeText(row.region) ||
          !normalizeText(row.province) ||
          !normalizeText(row.municipality);
        if (needsGeo) {
          const sourceHint = matchTerritorialSource(
            domain,
            (territorialSources ?? []) as Array<{
              name: string | null;
              authority_level: string | null;
              region: string | null;
              province: string | null;
              official_domain: string | null;
            }>,
          );
          const geo = resolveOpportunityGeo({
            markdown: page.markdown,
            officialUrl: row.official_url,
            source: sourceHint ?? {
              official_domain: domain,
              authority_level: String(row.authority_level ?? ""),
              region: null,
              province: null,
            },
          });
          if (!normalizeText(row.region) && geo.region) patch.region = geo.region;
          if (!normalizeText(row.province) && geo.province) {
            patch.province = geo.province;
          }
          if (!normalizeText(row.municipality) && geo.municipality) {
            patch.municipality = geo.municipality;
          }
        }

        // Stessa regola del collect: se dopo la pagina ufficiale mancano
        // ancora scadenza o qualunque importo, si segue in BFS fino a
        // DETAIL_MAX_FETCH_PER_HIT link (max DETAIL_MAX_HOPS hop)
        // dello stesso dominio. Nessun provider a pagamento, fail-closed.
        const missingDeadline = !sportelloSenzaScadenza &&
          row.deadline_at == null &&
          patch.deadline_at == null;
        const missingAmounts = row.max_grant_amount == null &&
          patch.max_grant_amount == null &&
          row.total_budget == null &&
          patch.total_budget == null;
        if (missingDeadline || missingAmounts) {
          const detailNow = new Date();
          const declared = [row.notice_url, row.application_url, row.forms_url]
            .map((value) => normalizeUrl(value))
            .filter(
              (url): url is string =>
                !!url && isAllowedOfficialUrl(url, domain),
            );
          await walkDetailTargets({
            html: page.html ?? "",
            markdown: page.markdown,
            baseUrl: page.finalUrl ?? row.official_url,
            officialDomain: domain,
            declared,
            exclude: [row.official_url, page.finalUrl ?? row.official_url],
            stillNeeded: () =>
              (row.deadline_at == null && patch.deadline_at == null) ||
              (row.max_grant_amount == null &&
                patch.max_grant_amount == null &&
                row.total_budget == null &&
                patch.total_budget == null),
            onPage: (_target, detail) => {
              if (row.deadline_at == null && patch.deadline_at == null) {
                const hit = parseDeadline(detail.markdown, detailNow);
                if (hit) patch.deadline_at = hit.value;
              }
              const detailAmounts = parseAmounts(detail.markdown);
              if (
                row.max_grant_amount == null &&
                patch.max_grant_amount == null &&
                detailAmounts.max_grant_amount
              ) {
                patch.max_grant_amount = detailAmounts.max_grant_amount.value;
              }
              if (
                row.total_budget == null &&
                patch.total_budget == null &&
                detailAmounts.total_budget
              ) {
                patch.total_budget = detailAmounts.total_budget.value;
              }
              if (
                (!normalizeText(row.region) && !patch.region) ||
                (!normalizeText(row.province) && !patch.province) ||
                (!normalizeText(row.municipality) && !patch.municipality)
              ) {
                const geo = resolveOpportunityGeo({
                  markdown: detail.markdown,
                  officialUrl: row.official_url,
                });
                if (!normalizeText(row.region) && !patch.region && geo.region) {
                  patch.region = geo.region;
                }
                if (
                  !normalizeText(row.province) &&
                  !patch.province &&
                  geo.province
                ) {
                  patch.province = geo.province;
                }
                if (
                  !normalizeText(row.municipality) &&
                  !patch.municipality &&
                  geo.municipality
                ) {
                  patch.municipality = geo.municipality;
                }
              }
            },
          });
        }



        // Fallback opt-in: solo se gli estrattori locali non hanno riempito
        // NESSUN campo dato e restano campi NULL da coprire.
        const stillMissing = [
          !sportelloSenzaScadenza &&
            row.deadline_at == null &&
            patch.deadline_at == null,
          row.min_grant_amount == null && patch.min_grant_amount == null,
          row.max_grant_amount == null && patch.max_grant_amount == null,
          row.total_budget == null && patch.total_budget == null,
        ].some(Boolean);
        const localFoundSomething = patch.deadline_at != null ||
          patch.min_grant_amount != null ||
          patch.max_grant_amount != null ||
          patch.total_budget != null;

        let paidUsed = false;
        const mayPay = allowPaidExtract &&
          stillMissing &&
          !localFoundSomething &&
          !shouldSkipPaidExtract(row as CatalogueRow) &&
          !documentIsReadable(page.markdown);
        if (mayPay) {
          const pseudoSource = {
            id: row.id,
            name: "backfill",
            authority_level: String(row.authority_level ?? "NAZIONALE"),
            region: null,
            province: null,
            official_domain: domain,
            search_query: "",
            source_kind: "BACKFILL",
            rarity_base: 0,
            fast_lane: false,
            scan_interval_minutes: 0,
            priority: 0,
            last_scanned_at: null,
            next_scan_at: nowIso,
          } as Source;
          const pseudoHit: SearchHit = {
            url: row.official_url,
            title: "",
            description: "",
            provider: "backfill",
          };
          const extracted = await extractOpportunity(
            pseudoSource,
            pseudoHit,
            page.markdown.slice(0, 20000),
          );
          paidCalls++;
          paidUsed = true;
          if (extracted.ok) {
            const d = extracted.data as JsonObject;
            const num = (v: unknown) =>
              typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
            if (
              !sportelloSenzaScadenza &&
              row.deadline_at == null &&
              patch.deadline_at == null &&
              typeof d.deadline_at === "string"
            ) {
              const iso = new Date(d.deadline_at);
              if (!Number.isNaN(iso.getTime())) {
                patch.deadline_at = iso.toISOString();
              }
            }
            if (row.min_grant_amount == null && num(d.min_grant_amount)) {
              patch.min_grant_amount = d.min_grant_amount;
            }
            if (row.max_grant_amount == null && num(d.max_grant_amount)) {
              patch.max_grant_amount = d.max_grant_amount;
            }
            if (row.total_budget == null && num(d.total_budget)) {
              patch.total_budget = d.total_budget;
            }
          }
        }

        const newDeadline = sportelloSenzaScadenza
          ? null
          : (patch.deadline_at as string | undefined) ??
            (typeof row.deadline_at === "string" ? row.deadline_at : null);
        const newMaxGrant = (patch.max_grant_amount as number | undefined) ??
          (typeof row.max_grant_amount === "number" ? row.max_grant_amount : null);
        const hasEvidence = page.markdown.length > 200;
        const deadlineProven = dateIsPresentInEvidence(
          page.markdown,
          newDeadline,
        );
        const newStatus = officialVerificationStatus({
          hasEvidence,
          deadline: newDeadline,
          deadlineProven,
          maxGrantAmount: newMaxGrant,
          sportelloSenzaScadenza,
        });

        if (newStatus !== row.verification_status) {
          patch.verification_status = newStatus;
          if (newStatus === "VERIFICATO") patch.last_verified_at = nowIso;
        }

        if (
          !isCookieConsentShell(page.markdown) &&
          (!row.raw_excerpt ||
            page.markdown.length > String(row.raw_excerpt || "").length)
        ) {
          patch.raw_excerpt = page.markdown.slice(0, 3000);
        }

        patch.last_seen_at = nowIso;
        patch.updated_at = nowIso;

        // Solo last_seen_at + updated_at → ruota la coda, non inventare campi.
        const fieldKeys = Object.keys(patch).filter(
          (key) => key !== "last_seen_at" && key !== "updated_at",
        );
        if (fieldKeys.length === 0) {
          await rotateQueueCursor(row.id, "NO_NEW_VALUES");
          continue;
        }

        if (dryRun) {
          results.push({
            id: row.id,
            status: "DRY_RUN",
            paid_extract: paidUsed,
            would_patch: patch,
          });
          continue;
        }

        const { error: upErr } = await sb
          .from("trovabandi_opportunities")
          .update(patch)
          .eq("id", row.id);

        if (upErr) {
          results.push({ id: row.id, status: "UPDATE_FAILED" });
          skipped++;
        } else {
          updated++;
          const logged = { ...patch };
          delete logged.raw_excerpt;
          results.push({
            id: row.id,
            status: "UPDATED",
            paid_extract: paidUsed,
            patch: logged,
          });
        }
      } catch {
        results.push({ id: row.id, status: "ITEM_ERROR" });
        skipped++;
      } finally {
        // One row at a time: forget page/PDF bodies after the patch.
        releaseLoadedPageBodies(page, { markdown: true });
        page = null;
      }
    }

    await sb.from("trovabandi_runs").insert({
      action: "backfill_nulls",
      source_id: null,
      trigger_source: triggerSource,
      status: "SUCCEEDED",
      processed_count: attempted,
      verified_count: results.filter(
        (r) =>
          r.patch?.verification_status === "VERIFICATO" ||
          r.would_patch?.verification_status === "VERIFICATO",
      ).length,
      provider_usage: {
        official_http: attempted,
        paid: paidCalls,
        allow_paid_extract: allowPaidExtract,
        allow_paid_scrape: allowPaidScrape,
      },
      warnings: [
        ...(dryRun ? ["dry_run"] : []),
        ...(paidCalls > 0 ? [`paid_extract_calls=${paidCalls}`] : []),
        ...(truncated ? ["truncated"] : []),
      ],
      finished_at: nowIso,
    });

    return response(200, {
      ok: true,
      dry_run: dryRun,
      processed: attempted,
      updated,
      skipped,
      truncated,
      remaining: truncated ? rows.length - attempted : 0,
      paid_extract_calls: paidCalls,
      results,
    });
  }

  if (action === "enrich_apply_urls") {
    const maxBatch = Math.min(40, Math.max(1, Number(body.max_batch) || 16));
    const dryRun = body.dry_run !== false;
    const nowIso = new Date().toISOString();
    const { data: catalog, error: selErr } = await sb
      .from("trovabandi_opportunities")
      .select(
        "id,title,official_url,notice_url,forms_url,application_url,raw_excerpt,verification_status,official_source,last_seen_at,deadline_at",
      )
      .eq("official_source", true)
      .in("verification_status", [...OPEN_VERIFICATION_STATUSES])
      .or(`deadline_at.is.null,deadline_at.gte.${nowIso}`)
      .order("last_seen_at", { ascending: true, nullsFirst: true })
      .limit(500);
    if (selErr || !catalog) {
      return response(500, { ok: false, code: "ENRICH_SELECT_FAILED" });
    }

    const catalogJunk = catalog.filter((row) =>
      classifyOfficialListingUrl(row.official_url) === "junk_listing"
    ).length;
    const catalogCandidates = catalog.length - catalogJunk;
    const alreadyDistinctForms = catalog.filter((row) => {
      const forms = typeof row.forms_url === "string" ? row.forms_url : "";
      return !!forms && forms !== row.official_url &&
        !isIndexOrLandingUrl(forms);
    }).length;
    const pending = catalog.filter((row) => {
      const forms = typeof row.forms_url === "string" ? row.forms_url : "";
      const app = typeof row.application_url === "string"
        ? row.application_url
        : "";
      if (!forms || !app) return true;
      return isIndexOrLandingUrl(forms) || forms === row.official_url;
    });

    const batch = pending.slice(0, maxBatch);
    const results: Array<Record<string, unknown>> = [];
    let gained = 0;
    let stayEmpty = 0;
    let clearedLanding = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of batch) {
      let domain = "";
      try {
        domain = new URL(row.official_url).hostname
          .replace(/^www\./i, "")
          .toLowerCase();
      } catch {
        results.push({ id: row.id, status: "BAD_URL" });
        skipped++;
        stayEmpty++;
        continue;
      }

      const stored = usableStoredEvidence(row.raw_excerpt);
      let html: string | undefined;
      let markdown = stored ?? "";
      const junkListing = isIndexOrLandingUrl(row.official_url);
      const skipOfficial = junkListing || shouldSkipApplyFetch(row.official_url);
      if (!skipOfficial) {
        const page = await directOfficialScrape(row.official_url, domain);
        if (page) {
          markdown = page.markdown || markdown;
          html = page.html;
        }
      }
      if (
        !junkListing &&
        (!html || !extractApplyLinks({
          html,
          markdown,
          officialUrl: row.official_url,
          officialDomain: domain,
        }).forms_url) &&
        typeof row.notice_url === "string" &&
        !shouldSkipApplyFetch(row.notice_url)
      ) {
        let noticeDomain = domain;
        try {
          noticeDomain = new URL(row.notice_url).hostname
            .replace(/^www\./i, "")
            .toLowerCase();
        } catch {
          noticeDomain = domain;
        }
        const notice = await directOfficialScrape(row.notice_url, noticeDomain);
        if (notice) {
          markdown = `${markdown}\n${notice.markdown}`;
          html = notice.html ?? html;
        }
      }

      const resolved = resolveOfficialApplyUrls({
        html,
        markdown,
        officialUrl: row.official_url,
        officialDomain: domain,
        existingForms: row.forms_url,
        existingApplication: row.application_url,
      });

      const hadForms = typeof row.forms_url === "string" &&
        row.forms_url.length > 0;
      const gainedForms = !!resolved.forms_url &&
        resolved.forms_url !== row.forms_url;
      const gainedApp = !!resolved.application_url &&
        resolved.application_url !== row.application_url;
      const nowHasApply = !!(resolved.forms_url || resolved.application_url);
      if (gainedForms || gainedApp) gained++;
      else if (!nowHasApply) stayEmpty++;
      if (hadForms && !resolved.forms_url) clearedLanding++;

      const patch: Record<string, unknown> = { updated_at: nowIso };
      if (resolved.forms_url !== (row.forms_url ?? null)) {
        patch.forms_url = resolved.forms_url;
      }
      if (resolved.application_url !== (row.application_url ?? null)) {
        patch.application_url = resolved.application_url;
      }

      const result = {
        id: row.id,
        title: row.title,
        official_url: row.official_url,
        skipped_fvg_bur: shouldSkipApplyFetch(row.official_url),
        junk_listing: junkListing,
        forms_url: resolved.forms_url,
        application_url: resolved.application_url,
        fillable_pdf: isFillablePdfUrl(resolved.forms_url),
        gained: gainedForms || gainedApp,
        stay_empty: !nowHasApply,
        cleared_landing: hadForms && !resolved.forms_url,
      };

      if (Object.keys(patch).length <= 1) {
        results.push({ ...result, status: "NO_CHANGE" });
        skipped++;
        continue;
      }
      if (dryRun) {
        results.push({ ...result, status: "DRY_RUN", would_patch: patch });
        continue;
      }
      const { error: upErr } = await sb
        .from("trovabandi_opportunities")
        .update(patch)
        .eq("id", row.id)
        .eq("official_source", true);
      if (upErr) {
        results.push({ ...result, status: "UPDATE_FAILED" });
        skipped++;
      } else {
        updated++;
        results.push({ ...result, status: "UPDATED" });
      }
    }

    await sb.from("trovabandi_runs").insert({
      action: "enrich_apply_urls",
      source_id: null,
      trigger_source: "manual",
      status: "SUCCEEDED",
      processed_count: batch.length,
      verified_count: gained,
      provider_usage: {
        official_http: batch.filter((row) => !shouldSkipApplyFetch(row.official_url))
          .length,
        paid: 0,
        catalog_official_open: catalog.length,
        pending_apply_path: pending.length,
      },
      warnings: [
        ...(dryRun ? ["dry_run"] : []),
        "skip_bur_fvg",
      ],
      finished_at: nowIso,
    });

    return response(200, {
      ok: true,
      dry_run: dryRun,
      catalog_official_open: catalog.length,
      catalog_junk_listing: catalogJunk,
      catalog_candidates: catalogCandidates,
      already_distinct_forms: alreadyDistinctForms,
      pending_apply_path: pending.length,
      processed: batch.length,
      remaining: Math.max(0, pending.length - batch.length),
      would_gain_or_gained: gained,
      stay_empty: stayEmpty,
      cleared_landing: clearedLanding,
      updated,
      skipped,
      results,
    });
  }

  if (action === "maintenance") {

    const now = new Date().toISOString();
    const staleBefore = new Date(
      Date.now() - RUN_STALE_AFTER_MINUTES * 60_000,
    ).toISOString();
    const staleResult = await sb
      .from("trovabandi_runs")
      .update(
        {
          status: "FAILED",
          error_code: "STALE_RUN_TIMEOUT",
          warnings: ["stale_run_reconciled"],
          finished_at: now,
        },
        { count: "exact" },
      )
      .eq("status", "RUNNING")
      .lt("started_at", staleBefore);
    if (staleResult.error || staleResult.count == null) {
      return response(500, {
        ok: false,
        code: "STALE_RUN_RECONCILIATION_FAILED",
      });
    }
    const expiryResult = await sb
      .from("trovabandi_opportunities")
      .update(
        { verification_status: "SCADUTO", updated_at: now },
        { count: "exact" },
      )
      .lt("deadline_at", now)
      .in("verification_status", [...EXPIRE_VERIFICATION_STATUSES]);
    if (expiryResult.error || expiryResult.count == null) {
      return response(500, { ok: false, code: "OPPORTUNITY_EXPIRY_FAILED" });
    }
    return response(200, {
      ok: true,
      stale_runs_reconciled: staleResult.count,
      expired: expiryResult.count,
    });
  }

  if (action === "release_gate") {
    const nowIso = new Date().toISOString();
    const coverageSince = new Date(
      Date.now() - COVERAGE_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const staleBefore = new Date(
      Date.now() - RUN_STALE_AFTER_MINUTES * 60_000,
    ).toISOString();
    const [
      enabledSourcesResult,
      recentRunsResult,
      staleRunsResult,
      verifiedResult,
      partialResult,
    ] = await Promise.all([
      sb
        .from("trovabandi_sources")
        .select("id,source_kind,priority,last_scanned_at,next_scan_at")
        .eq("enabled", true),
      sb
        .from("trovabandi_runs")
        .select("source_id,provider_usage")
        .eq("status", "SUCCEEDED")
        .not("source_id", "is", null)
        .not("finished_at", "is", null)
        .gte("finished_at", coverageSince),
      sb
        .from("trovabandi_runs")
        .select("id", { count: "exact", head: true })
        .eq("status", "RUNNING")
        .lt("started_at", staleBefore),
      sb.rpc("trovabandi_verified_active_distinct_count", { p_now: nowIso }),
      sb
        .from("trovabandi_opportunities")
        .select("id", { count: "exact", head: true })
        .eq("verification_status", "PARZIALE")
        .or(`deadline_at.is.null,deadline_at.gte.${nowIso}`),
    ]);

    if (
      enabledSourcesResult.error ||
      recentRunsResult.error ||
      staleRunsResult.error ||
      verifiedResult.error ||
      partialResult.error ||
      staleRunsResult.count == null ||
      partialResult.count == null
    ) {
      return response(503, {
        ok: false,
        gate_passed: false,
        cron_activation_allowed: false,
        code: "RELEASE_GATE_QUERY_FAILED",
      });
    }

    const verifiedActiveCount = nonNegativeSafeInteger(verifiedResult.data);
    if (verifiedActiveCount == null) {
      return response(503, {
        ok: false,
        gate_passed: false,
        cron_activation_allowed: false,
        code: "RELEASE_GATE_COUNT_INVALID",
      });
    }

    const gate = evaluateReleaseGate({
      enabledSources: (enabledSourcesResult.data ?? []) as DueSource[],
      recentSuccessfulRuns: (recentRunsResult.data ?? []) as SuccessfulRun[],
      staleRunningCount: staleRunsResult.count,
      verifiedActiveCount,
      partialActiveCount: partialResult.count,
      coverageSinceIso: coverageSince,
    });
    return response(gate.ok ? 200 : 409, {
      ok: gate.ok,
      gate_passed: gate.ok,
      cron_activation_allowed: gate.ok,
      checks: gate.checks,
      metrics: gate.metrics,
    });
  }

  if (action === "request_refresh") {
    const profile = (body.profile ?? {}) as CompanyProfile;
    const interests = stringArray(profile.investimenti_previsti).map(
      normalizeCode,
    );
    const requestKey = await sha256(
      [
        normalizeCode(profile.regione),
        normalizeCode(profile.provincia),
        normalizeCode(profile.codice_ateco).slice(0, 2),
        inferCompanySize(profile),
        profile.imprenditoria_femminile ? "F" : "",
        profile.impresa_giovanile ? "G" : "",
        profile.startup_innovativa || profile.pmi_innovativa ? "I" : "",
        interests.sort().join(","),
      ].join("|"),
    );
    const refreshWriteResult = await sb
      .from("trovabandi_refresh_requests")
      .upsert(
        {
          request_key: requestKey,
          region: normalizeText(profile.regione) || null,
          province: normalizeText(profile.provincia) || null,
          municipality: normalizeText(profile.comune) || null,
          ateco_prefix: normalizeCode(profile.codice_ateco).slice(0, 2) || null,
          company_size: inferCompanySize(profile),
          interest_categories: interests,
          female_business: profile.imprenditoria_femminile === true,
          youth_business: profile.impresa_giovanile === true,
          innovative_business:
            profile.startup_innovativa === true ||
            profile.pmi_innovativa === true,
          requested_at: new Date().toISOString(),
          processed_at: null,
        },
        { onConflict: "request_key" },
      );
    if (refreshWriteResult.error) {
      return response(503, { ok: false, code: "REFRESH_REQUEST_WRITE_FAILED" });
    }
    return response(202, { ok: true, queued: true });
  }

  if (isCatalogRequest(action, body)) {
    const paging = parseCatalogPaging(body);
    const nowIso = new Date().toISOString();
    const now = new Date(nowIso);
    const pageSize = paging.fetchAll ? CATALOG_SAFE_CAP : paging.limit;
    const targetTotal = pageSize + (paging.fetchAll ? 0 : 1);
    const catalogRows: JsonObject[] = [];
    let queryFailed = false;
    let fetched = 0;
    while (fetched < targetTotal) {
      const chunk = Math.min(CATALOG_POSTGREST_CHUNK, targetTotal - fetched);
      const from = paging.fetchAll
        ? fetched
        : paging.offset + fetched;
      const { data, error } = await sb
        .from("trovabandi_opportunities")
        .select(CATALOG_SELECT_COLUMNS)
        .eq("official_source", true)
        .in("verification_status", [...OPEN_VERIFICATION_STATUSES])
        .or(`deadline_at.is.null,deadline_at.gte.${nowIso}`)
        .like("official_url", "http%")
        .order("deadline_at", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + chunk - 1);
      if (error) {
        queryFailed = true;
        break;
      }
      const batch = (data ?? []) as JsonObject[];
      catalogRows.push(...batch);
      fetched += batch.length;
      if (batch.length < chunk) break;
    }
    if (queryFailed) return response(500, { ok: false, code: "CATALOG_QUERY_FAILED" });
    const profile = (body.profile ?? null) as CompanyProfile | null;
    const considered = catalogRows.map((item) => mapCatalogBando(item, profile));
    const visible = considered.filter((item) => isOfficialOpenCatalogRow(item, now));
    let hasMore = false;
    let returned: JsonObject[];
    if (paging.fetchAll) {
      returned = visible.slice(0, CATALOG_SAFE_CAP);
    } else {
      hasMore = catalogRows.length > pageSize;
      returned = visible.slice(0, pageSize);
    }
    return response(200, {
      ok: true,
      mode: "catalog",
      bandi: returned,
      total_considered: considered.length,
      excluded: considered.length - returned.length,
      fetched_at: nowIso,
      generated_at: nowIso,
      source: "central-core",
      page: paging.page,
      limit: paging.fetchAll ? returned.length : paging.limit,
      has_more: hasMore,
      next_page: hasMore ? paging.page + 1 : null,
      next_cursor: hasMore ? paging.page + 1 : null,
    });
  }

  if (action === "feed") {
    const profile = (body.profile ?? {}) as CompanyProfile;
    if (!normalizeText(profile.regione) || !normalizeText(profile.codice_ateco))
      return response(400, { ok: false, code: "PROFILE_INCOMPLETE" });
    const limit = Math.max(1, Math.min(300, Number(body.limit ?? 200)));
    const { data, error } = await sb
      .from("trovabandi_opportunities")
      .select(
        "*, trovabandi_evidence(source_url,source_title,evidence_type,excerpt,fetched_at)",
      )
      .in("verification_status", [...OPEN_VERIFICATION_STATUSES])
      .or(`deadline_at.is.null,deadline_at.gte.${new Date().toISOString()}`)
      .order("deadline_at", { ascending: true, nullsFirst: false })
      .limit(limit);
    if (error) return response(500, { ok: false, code: "FEED_QUERY_FAILED" });
    const matched = (data ?? []).map((item) => ({
      ...item,
      modulistica_url: (item as JsonObject).forms_url ?? null,
      match: matchOpportunity(item as JsonObject, profile),
    }));
    const statusRank: Record<string, number> = {
      COMPATIBILE: 0,
      DA_VERIFICARE: 1,
    };
    const visible = matched
      .filter((item) => item.match.status !== "NON_COMPATIBILE")
      .sort((a, b) => {
        const rank =
          (statusRank[a.match.status] ?? 9) - (statusRank[b.match.status] ?? 9);
        if (rank !== 0) return rank;
        const score = b.match.score - a.match.score;
        if (score !== 0) return score;
        const ad = a.deadline_at
          ? new Date(a.deadline_at as string).getTime()
          : Infinity;
        const bd = b.deadline_at
          ? new Date(b.deadline_at as string).getTime()
          : Infinity;
        return ad - bd;
      });
    return response(200, {
      ok: true,
      bandi: visible,
      total_considered: matched.length,
      excluded: matched.length - visible.length,
      fetched_at: new Date().toISOString(),
      source: "central-core",
    });
  }

  const sourceId = normalizeText(body.source_id);
  const maxPages = boundedMaxPages(body.max_pages ?? 2);
  const dryRun = body.dry_run === true;
  const triggerSource =
    normalizeText(body.trigger_source).slice(0, 120) || "replit";
  const requestedLane = normalizeText(body.lane);
  const lane = requestedLane ? normalizeLane(requestedLane) : null;
  if (requestedLane && !lane) {
    return response(400, { ok: false, code: "INVALID_LANE" });
  }
  const allowPaid = parseAllowPaid(body.allow_paid, true);
  let refreshSignal: RefreshSignal | null = null;
  if (!sourceId) {
    const refreshResult = await sb
      .from("trovabandi_refresh_requests")
      .select("*")
      .is("processed_at", null)
      .order("requested_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (refreshResult.error) {
      return response(503, { ok: false, code: "REFRESH_SIGNAL_QUERY_FAILED" });
    }
    refreshSignal = (refreshResult.data as RefreshSignal | null) ?? null;
  }

  const selectionNow = new Date().toISOString();
  let sourceData: Source | null = null;
  if (sourceId) {
    const explicitResult = await sb
      .from("trovabandi_sources")
      .select("*")
      .eq("enabled", true)
      .eq("id", sourceId)
      .maybeSingle();
    if (explicitResult.error) {
      return response(503, { ok: false, code: "SOURCE_QUERY_FAILED" });
    }
    if (!explicitResult.data) {
      return response(404, { ok: false, code: "SOURCE_NOT_AVAILABLE" });
    }
    sourceData = explicitResult.data as Source;
    if (dryRun) {
      return response(200, {
        ok: true,
        dry_run: true,
        would_collect: {
          source_id: sourceData.id,
          source_kind: sourceData.source_kind,
          lane: sourceLane(sourceData),
          next_scan_at: sourceData.next_scan_at,
          max_pages: maxPages,
          allow_paid: allowPaid,
        },
      });
    }
  } else {
    const dueResult = await sb
      .from("trovabandi_sources")
      .select("*")
      .eq("enabled", true)
      .lte("next_scan_at", selectionNow)
      .order("next_scan_at", { ascending: true })
      .order("last_scanned_at", { ascending: true, nullsFirst: true })
      .order("priority", { ascending: false })
      .order("id", { ascending: true })
      .limit(1000);
    if (dueResult.error) {
      return response(503, { ok: false, code: "SOURCE_QUERY_FAILED" });
    }

    const rankedCandidates = rankDueSources(
      filterSourcesByLane((dueResult.data ?? []) as Source[], lane),
      refreshSignal?.region,
    );
    if (dryRun) {
      const candidate = rankedCandidates[0] ?? null;
      return response(
        200,
        candidate
          ? {
              ok: true,
              dry_run: true,
              would_collect: {
                source_id: candidate.id,
                source_kind: candidate.source_kind,
                lane: sourceLane(candidate),
                next_scan_at: candidate.next_scan_at,
                max_pages: maxPages,
                allow_paid: allowPaid,
              },
            }
          : {
              ok: true,
              dry_run: true,
              skipped: true,
              reason: "NO_SOURCE_DUE",
              max_pages: maxPages,
            },
      );
    }

    const leaseUntil = new Date(
      Date.now() + RUN_STALE_AFTER_MINUTES * 60_000,
    ).toISOString();
    for (const candidate of rankedCandidates) {
      // Optimistic lease: only one overlapping scheduler can move the exact
      // due timestamp. A failed worker releases itself naturally after 20 min.
      const claimResult = await sb
        .from("trovabandi_sources")
        .update({ next_scan_at: leaseUntil, updated_at: selectionNow })
        .eq("id", candidate.id)
        .eq("enabled", true)
        .eq("next_scan_at", candidate.next_scan_at)
        .lte("next_scan_at", selectionNow)
        .select("*")
        .maybeSingle();
      if (claimResult.error) {
        return response(503, { ok: false, code: "SOURCE_CLAIM_FAILED" });
      }
      if (claimResult.data) {
        sourceData = claimResult.data as Source;
        break;
      }
    }

    if (!sourceData) {
      const finishedAt = new Date().toISOString();
      const skippedResult = await sb
        .from("trovabandi_runs")
        .insert({
          action: "collect",
          source_id: null,
          trigger_source: triggerSource,
          status: "SKIPPED",
          error_code: "NO_SOURCE_DUE",
          provider_usage: {},
          warnings: [],
          started_at: selectionNow,
          finished_at: finishedAt,
        })
        .select("id")
        .single();
      if (skippedResult.error || !skippedResult.data?.id) {
        return response(503, { ok: false, code: "SKIPPED_RUN_WRITE_FAILED" });
      }
      return response(200, {
        ok: true,
        skipped: true,
        reason: "NO_SOURCE_DUE",
        status: "SKIPPED",
        run_id: skippedResult.data.id,
      });
    }
  }

  const baseSource = sourceData;
  const refreshMatchesSource =
    !!refreshSignal &&
    (!baseSource.region ||
      normalizeCode(baseSource.region) === normalizeCode(refreshSignal.region));
  const appliedRefreshSignal = refreshMatchesSource ? refreshSignal : null;
  const personalisedTerms = appliedRefreshSignal
    ? [
        appliedRefreshSignal.region,
        appliedRefreshSignal.province,
        appliedRefreshSignal.municipality,
        appliedRefreshSignal.ateco_prefix
          ? `ATECO ${appliedRefreshSignal.ateco_prefix}`
          : null,
        appliedRefreshSignal.company_size,
        ...(appliedRefreshSignal.interest_categories ?? []),
        appliedRefreshSignal.female_business ? "imprenditoria femminile" : null,
        appliedRefreshSignal.youth_business ? "imprenditoria giovanile" : null,
        appliedRefreshSignal.innovative_business
          ? "startup PMI innovativa"
          : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const source: Source = {
    ...baseSource,
    search_query: `${baseSource.search_query} ${personalisedTerms}`.trim(),
  };
  const runCreateResult = await sb
    .from("trovabandi_runs")
    .insert({
      action: "collect",
      source_id: source.id,
      trigger_source: triggerSource,
    })
    .select("id")
    .single();
  if (runCreateResult.error || !runCreateResult.data?.id) {
    return response(503, { ok: false, code: "RUN_CREATE_FAILED" });
  }
  const run = runCreateResult.data;
  const warnings: string[] = [];
  try {
    const nowMs = Date.now();
    const runningPaid = await sb
      .from("trovabandi_runs")
      .select("id", { count: "exact", head: true })
      .eq("action", "collect")
      .eq("status", "RUNNING")
      .neq("id", run.id)
      .gt(
        "started_at",
        new Date(Date.now() - RUN_STALE_AFTER_MINUTES * 60_000).toISOString(),
      );
    const paidBudget = createPaidBudget(
      allowPaid,
      (runningPaid.count ?? 0) > 0,
    );
    if (!paidBudget.allowPaid && allowPaid) {
      warnings.push("paid_blocked_concurrent_run");
    }
    // Cache-first: il pool persistito di candidati ufficiali evita ricerche
    // a pagamento ridondanti e garantisce profondita' reale sulla fonte.
    let cachedPool = await loadCachedCandidates(sb, source);
    // Pagine di partenza ufficiali: solo se il pool è vuoto, prima di
    // qualsiasi ricerca a pagamento. Nessun path inventato.
    const seedHits =
      cachedPool.length === 0
        ? await harvestSeedListings(sb, source, paidBudget)
        : [];
    if (seedHits.length > 0) {
      const seedIso = new Date(nowMs).toISOString();
      cachedPool = dedupeCandidates([
        ...cachedPool,
        ...seedHits.map((hit) => ({
          url: hit.url,
          title: hit.title,
          snippet: hit.description,
          provider: hit.provider,
          discovered_at: seedIso,
          last_seen_at: seedIso,
          last_attempted_at: null,
          attempt_count: 0,
        })),
      ]);
    }
    const freshPool = freshCandidates(cachedPool, nowMs);
    const searchSkippedByCache = shouldSkipPaidSearch(
      freshPool.length,
      maxPages,
    );
    const searchSkippedByBudget =
      !searchSkippedByCache && !canSpendPaid(paidBudget, "search");
    if (!searchSkippedByCache && !searchSkippedByBudget) {
      spendPaid(paidBudget, "search");
    }
    const [fc, pp] = searchSkippedByCache || searchSkippedByBudget
      ? ([
          { ok: true, hits: [] },
          { ok: true, hits: [] },
        ] as [SearchOutcome<SearchHit>, SearchOutcome<SearchHit>])
      : await Promise.all([firecrawlSearch(source), perplexitySearch(source)]);
    let processed = 0;
    let verified = 0;
    let pagesScraped = 0;
    // Guasti operativi: degradano il run a PARTIAL e non sbloccano il gate.
    let operationalFailures = 0;
    // Diagnostica non sensibile: solo fase + codice, mai URL completi o contenuti.
    const diagnostics: Array<{ phase: string; code: string }> = [];
    // La ricerca non fallisce mai silenziosamente in []: ogni guasto provider
    // è diagnosticato e genera warning. Firecrawl e Perplexity sono però
    // fallback reciproci: il guasto di uno non degrada il run quando l'altro
    // ha completato con almeno una hit ufficiale valida (warning informativo).
    const searchEntries = searchSkippedByCache || searchSkippedByBudget
      ? []
      : ([
          ["firecrawl", fc],
          ["perplexity", pp],
        ] as const).map(([provider, outcome]) => {
          const entry = searchDiagnostics(provider, outcome);
          return { ...entry, hits: outcome.ok ? outcome.hits.length : 0 };
        });
    if (searchSkippedByCache) {
      diagnostics.push({ phase: "search", code: "SKIPPED_CACHE_HIT" });
    } else if (searchSkippedByBudget) {
      diagnostics.push({ phase: "search", code: "SKIPPED_BUDGET" });
    }
    for (const entry of searchRedundancyOutcome(searchEntries)) {
      diagnostics.push({ phase: entry.phase, code: entry.code });
      if (!entry.degraded) continue;
      const base = `${entry.phase}_${entry.code.toLowerCase()}`;
      if (entry.operational) {
        warnings.push(base);
        operationalFailures++;
      } else {
        warnings.push(`${base}_non_blocking`);
      }
    }

    const fcHits = fc.ok ? fc.hits : [];
    const ppHits = pp.ok ? pp.hits : [];
    const searchHits = [...fcHits, ...ppHits];
    if (searchHits.length > 0) {
      await upsertCandidates(sb, source, searchHits);
    }
    // Pool unificato: candidati cache + evidenze persistite + hit nuove.
    const refreshedUrls = new Set(
      searchHits
        .map((hit) => canonicalCandidateUrl(hit.url))
        .filter((url): url is string => !!url),
    );
    const pool = dedupeCandidates([
      ...cachedPool.filter((candidate) => !refreshedUrls.has(candidate.url)),
      ...searchHits.map((hit) => ({
        url: hit.url,
        title: hit.title,
        snippet: hit.description,
        provider: hit.provider,
        discovered_at: new Date(nowMs).toISOString(),
        last_seen_at: new Date(nowMs).toISOString(),
        last_attempted_at: null,
        attempt_count: 0,
      })),
    ]);
    const byUrl = new Map(pool.map((candidate) => [candidate.url, candidate]));
    const existingByUrl = new Map<string, CatalogueRow>();
    const existingResult = await sb
      .from("trovabandi_opportunities")
      .select(
        "official_url,verification_status,deadline_at,min_grant_amount,max_grant_amount,total_budget,application_url,forms_url,protocol_email,raw_excerpt,eligible_ateco_prefixes,region,province,municipality",
      )
      .ilike("official_url", `%${source.official_domain}%`)
      .limit(250);
    for (const row of (existingResult.data ?? []) as CatalogueRow[]) {
      const key = canonicalCandidateUrl(row.official_url);
      if (key) existingByUrl.set(key, row);
    }
    // Rotazione deterministica: mai sempre le prime due hit.
    const rotated = rotateCandidates(pool, maxPages, nowMs);
    const hits: SearchHit[] = rotated.map((candidate) => ({
      url: candidate.url,
      title: normalizeText(candidate.title),
      description: normalizeText(candidate.snippet),
      provider: normalizeText(candidate.provider) || "cache",
    }));
    let directFetchAttempted = 0;
    let directFetchSucceeded = 0;
    let scrapeFailures = 0;
    // Budget condiviso dei fetch di dettaglio: costo provider zero, ma il
    // tempo del run resta limitato.
    const detailBudget = { remaining: DETAIL_MAX_FETCH_PER_RUN };

    for (const hit of hits) {
      const cachedState = byUrl.get(hit.url);
      const existing = existingByUrl.get(hit.url) ??
        existingByUrl.get(canonicalCandidateUrl(hit.url) ?? "");
      if (shouldSkipExpiredRecrawl(existing)) {
        diagnostics.push({ phase: "scrape", code: "SKIPPED_EXPIRED" });
        continue;
      }
      if (isCompleteVerified(existing)) {
        diagnostics.push({ phase: "scrape", code: "SKIPPED_COMPLETE" });
        continue;
      }
      if (isIndexOrLandingUrl(hit.url)) {
        diagnostics.push({ phase: "scrape", code: "SKIPPED_INDEX_LISTING" });
        continue;
      }
      let scraped: LoadedPage | null = null;
      if (shouldSkipApplyFetch(hit.url)) {
        // BUR FVG: known hang. Nessun recrawl HTTP, solo excerpt già persistito.
        diagnostics.push({ phase: "scrape", code: "SKIPPED_FVG_BUR" });
        const storedFvg = usableStoredEvidence(existing?.raw_excerpt);
        if (!storedFvg) continue;
        scraped = {
          markdown: storedFvg,
          title: hit.title,
          provider: "stored-excerpt",
        };
      } else {
        directFetchAttempted++;
        scraped = await loadPage(hit.url, source.official_domain, paidBudget);
      }
      const officialOk = !!scraped &&
        (scraped.provider === "official-http" ||
          scraped.provider === "official-pdf" ||
          scraped.provider === "official-csv");
      if (officialOk) directFetchSucceeded++;
      if (!scraped) {
        const stored = usableStoredEvidence(existing?.raw_excerpt);
        if (stored) {
          scraped = {
            markdown: stored,
            title: hit.title,
            provider: "stored-excerpt",
          };
        }
      }
      await markCandidateAttempt(
        sb,
        source,
        hit.url,
        Number(cachedState?.attempt_count ?? 0) || 0,
        scraped ? await sha256(scraped.markdown) : null,
      );
      if (!scraped) {
        diagnostics.push({ phase: "scrape", code: "NO_CONTENT" });
        warnings.push(`scrape_failed:${new URL(hit.url).hostname}`);
        scrapeFailures++;
        continue;
      }
      // pages_scraped misura gli scrape riusciti, non i tentativi.
      pagesScraped++;
      diagnostics.push({
        phase: "scrape",
        code: `OK_${scraped.provider.toUpperCase()}`,
      });
      const localAmounts = parseAmounts(scraped.markdown);
      const localDraft = localOpportunityDraft({
        markdown: scraped.markdown,
        officialUrl: hit.url,
        titleHint: hit.title || scraped.title,
        officialDomain: source.official_domain,
        deadline: parseDeadline(scraped.markdown, new Date())?.value ?? null,
        min_grant_amount: localAmounts.min_grant_amount?.value ?? null,
        max_grant_amount: localAmounts.max_grant_amount?.value ?? null,
        total_budget: localAmounts.total_budget?.value ?? null,
      });
      if (
        !isEligibleOfficialOpportunity({
          officialUrl: hit.url,
          markdown: scraped.markdown,
        })
      ) {
        diagnostics.push({ phase: "extract", code: "NOT_OPPORTUNITY" });
        continue;
      }
      const readable = documentIsReadable(scraped.markdown);
      const needPaidExtract = shouldUsePaidProvider(officialOk, readable) &&
        !shouldSkipPaidExtract(existing) &&
        !localDraft;
      let extracted: ExtractionOutcome = localDraft
        ? { ok: true, data: localDraft, mode: "json_fallback" }
        : { ok: false, code: "NOT_OPPORTUNITY" };
      if (
        needPaidExtract &&
        canSpendPaid(paidBudget, "extract")
      ) {
        spendPaid(paidBudget, "extract");
        extracted = await extractOpportunity(source, hit, scraped.markdown);
      } else if (!localDraft && !needPaidExtract) {
        extracted = { ok: false, code: "NOT_OPPORTUNITY" };
      }
      if (!extracted.ok) {
        diagnostics.push({ phase: "extract", code: extracted.code });
        // NOT_OPPORTUNITY e gli altri esiti negativi validi non generano warning.
        if (isOperationalFailure(extracted.code)) {
          warnings.push(`extract_${extracted.code.toLowerCase()}`);
          operationalFailures++;
        }
        continue;
      }
      diagnostics.push({
        phase: "extract",
        code: localDraft
          ? "OK_LOCAL"
          : extracted.mode === "json_fallback"
            ? "OK_FALLBACK"
            : "OK_SCHEMA",
      });
      // Arricchimento di dettaglio: solo se mancano scadenza o importi.
      const enrichment = await enrichFromDetailPages(
        source,
        hit,
        scraped,
        extracted.data,
        detailBudget,
      );
      if (enrichment.attempted > 0) {
        diagnostics.push({
          phase: "detail",
          code:
            enrichment.filled.length > 0
              ? `OK_${[...new Set(enrichment.filled)].join("+").toUpperCase()}`
              : "NO_FIELD",
        });
      }
      const enrichedExtraction = {
        ...extracted.data,
        ...enrichment.patch,
      } as JsonObject;
      const stored = await storeOpportunity(
        sb,
        source,
        hit,
        enrichedExtraction,
        scraped.markdown,
        scraped.provider,
        enrichment.evidence,
        scraped,
        existing,
      );
      diagnostics.push({ phase: "store", code: stored.code });
      if (!stored.stored) {
        warnings.push(`store_${stored.code.toLowerCase()}`);
        operationalFailures++;
        continue;
      }
      processed++;
      if (stored.verified) verified++;
    }

    operationalFailures += sourceScrapeOperationalFailures(
      scrapeFailures,
      pagesScraped,
    );

    const diagnosticCounters = aggregateDiagnostics(diagnostics);
    const finished = new Date().toISOString();
    const sourceStateResult = await sb
      .from("trovabandi_sources")
      .update({
        last_scanned_at: finished,
        next_scan_at: new Date(
          Date.now() +
            Math.max(15, Number(source.scan_interval_minutes || 360)) * 60_000,
        ).toISOString(),
        updated_at: finished,
      })
      .eq("id", source.id);
    if (sourceStateResult.error) {
      await sb
        .from("trovabandi_runs")
        .update({
          status: "FAILED",
          error_code: "SOURCE_STATE_WRITE_FAILED",
          finished_at: finished,
        })
        .eq("id", run.id)
        .eq("status", "RUNNING");
      return response(500, { ok: false, code: "SOURCE_STATE_WRITE_FAILED" });
    }

    if (appliedRefreshSignal?.id) {
      const refreshStateResult = await sb
        .from("trovabandi_refresh_requests")
        .update({ processed_at: finished })
        .eq("id", appliedRefreshSignal.id);
      if (refreshStateResult.error) {
        await sb
          .from("trovabandi_runs")
          .update({
            status: "FAILED",
            error_code: "REFRESH_STATE_WRITE_FAILED",
            finished_at: finished,
          })
          .eq("id", run.id)
          .eq("status", "RUNNING");
        return response(500, { ok: false, code: "REFRESH_STATE_WRITE_FAILED" });
      }
    }

    const completion = collectionCompletionOutcome(operationalFailures);
    const runFinishResult = await sb
      .from("trovabandi_runs")
      .update({
        status: completion.runStatus,
        error_code: completion.errorCode,
        discovered_count: byUrl.size,
        processed_count: processed,
        verified_count: verified,
        provider_usage: {
          firecrawl_search: fcHits.length,
          perplexity_search: ppHits.length,
          firecrawl_search_status: searchSkippedByCache
            ? "SKIPPED_CACHE"
            : searchSkippedByBudget
              ? "SKIPPED_BUDGET"
              : fc.ok
                ? "OK"
                : fc.code,
          perplexity_search_status: searchSkippedByCache
            ? "SKIPPED_CACHE"
            : searchSkippedByBudget
              ? "SKIPPED_BUDGET"
              : pp.ok
                ? "OK"
                : pp.code,
          paid_search_calls: searchSkippedByCache || searchSkippedByBudget
            ? 0
            : 2,
          paid_scrape_calls: paidBudget.paidScrapes,
          paid_extract_calls: paidBudget.paidExtracts,
          allow_paid: paidBudget.allowPaid,
          cache_candidates: cachedPool.length,
          seed_candidates: seedHits.length,
          cache_candidates_fresh: freshPool.length,
          search_skipped_cache_hit: searchSkippedByCache,
          rotated_candidates: hits.length,
          direct_fetch_attempted: directFetchAttempted,
          direct_fetch_succeeded: directFetchSucceeded,
          pages_attempted: hits.length,
          pages_scraped: pagesScraped,
          diagnostics: diagnosticCounters,
        },
        warnings: [...new Set(warnings)],
        finished_at: finished,
      })
      .eq("id", run.id)
      .eq("status", "RUNNING")
      .select("id")
      .maybeSingle();
    if (runFinishResult.error || !runFinishResult.data?.id) {
      return response(503, { ok: false, code: "RUN_FINALIZE_FAILED" });
    }
    return response(completion.httpStatus, {
      ok: completion.ok,
      ...(completion.errorCode
        ? { code: completion.errorCode, error_code: completion.errorCode }
        : {}),
      run_id: run.id,
      source_id: source.id,
      source: source.name,
      status: completion.runStatus,
      discovered: byUrl.size,
      attempted: hits.length,
      scraped: pagesScraped,
      processed,
      verified,

      warnings: [...new Set(warnings)],
      diagnostics: diagnosticCounters,
    });
  } catch (error) {
    await sb
      .from("trovabandi_runs")
      .update({
        status: "FAILED",
        error_code: error instanceof Error ? error.name : "UNKNOWN",
        warnings,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("status", "RUNNING");
    return response(500, { ok: false, code: "COLLECT_FAILED" });
  }
});

