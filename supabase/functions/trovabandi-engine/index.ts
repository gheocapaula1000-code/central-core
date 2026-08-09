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
  type PersistVerification,
} from "./persist.ts";
import {
  htmlToEvidenceText,
  isAllowedOfficialUrl,
  isHtmlContentType,
  isPdfContentType,
  officialUrlVariants,
  pdfToEvidenceText,
  readLimitedBytes,
  readLimitedText,
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
  "request_refresh",
  "collect",
  "maintenance",
  "release_gate",
  "status",
]);

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
  else blockers.push("Codice ATECO non compreso");

  const forms = stringArray(opportunity.eligible_legal_forms).map(
    normalizeCode,
  );
  if (forms.length === 0) missing.push("Forma giuridica da verificare");
  else if (forms.includes(normalizeCode(profile.forma_giuridica)))
    confirmed.push("Forma giuridica ammessa");
  else blockers.push("Forma giuridica non ammessa");

  const sizes = stringArray(opportunity.eligible_company_sizes).map(
    normalizeCode,
  );
  if (sizes.length === 0) missing.push("Dimensione impresa da verificare");
  else if (sizes.includes(inferCompanySize(profile)))
    confirmed.push("Dimensione impresa ammessa");
  else blockers.push("Dimensione impresa non ammessa");

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

  const verified =
    normalizeCode(opportunity.verification_status) === "VERIFICATO";
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

async function fetchOfficialVariant(
  url: string,
  officialDomain: string,
): Promise<{ markdown: string; title: string; provider: string } | null> {
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
      const parsed = contentType.includes("text/plain")
        ? { title: "", text: raw.trim() }
        : htmlToEvidenceText(raw);
      const markdown = parsed.text.slice(0, 60_000);
      return markdown.length > 200
        ? { markdown, title: parsed.title, provider: "official-http" }
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
): Promise<{ markdown: string; title: string; provider: string } | null> {
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
async function loadPage(url: string, officialDomain: string) {
  const direct = await directOfficialScrape(url, officialDomain);
  if (direct) return direct;
  // Budget: al massimo una chiamata Firecrawl per variante (max 2) e una sola
  // chiamata Apify sulla variante piu' probabile.
  const variants = officialUrlVariants(url).slice(0, 2);
  for (const variant of variants) {
    const scraped = await scrapePage(variant);
    if (scraped) return scraped;
  }
  return await apifyScrape(variants[variants.length - 1] ?? url);
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
    .select("official_url,notice_url,updated_at")
    .ilike("official_url", `%${source.official_domain}%`)
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
  const prompt = `Estrai esclusivamente dati presenti nel testo ufficiale seguente. Non dedurre requisiti, date o importi mancanti. Se la pagina non descrive un bando, incentivo o finanziamento per imprese aperto, in apertura o con documentazione ancora rilevante, imposta is_opportunity=false. official_url deve essere ${hit.url}. Date ISO 8601. Prefissi ATECO senza punteggiatura superflua. Per opportunità UE estrai programma, codice call/topic, Paesi ammessi e obbligo/minimo partner. Per PNRR estrai Missione, Componente e soggetto attuatore soltanto se espliciti.\n${schemaHint}\n\n${markdown}`;

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
): Promise<{ stored: boolean; verified: boolean; code: string }> {
  const officialUrl = normalizeUrl(hit.url);
  if (!officialUrl || !hostMatches(officialUrl, source.official_domain))
    return { stored: false, verified: false, code: "OFF_DOMAIN" };

  const deadline = safeTimestamp(extracted.deadline_at);
  const now = new Date();
  const expired = deadline
    ? new Date(deadline).getTime() < now.getTime()
    : false;
  const hasEvidence =
    markdown.length > 200 && source.official_domain.length > 3;
  const deadlineProven = dateIsPresentInEvidence(markdown, deadline);
  const verification: PersistVerification =
    expired && deadlineProven
      ? "SCADUTO"
      : hasEvidence && deadline && deadlineProven
        ? "VERIFICATO"
        : hasEvidence
          ? "PARZIALE"
          : "DA_VERIFICARE";
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
    application_url: normalizeUrl(extracted.application_url),
    forms_url: normalizeUrl(extracted.forms_url),
    protocol_email:
      normalizeText(extracted.protocol_email).slice(0, 320) || null,
    region: normalizeText(extracted.region).slice(0, 120) || source.region,
    province:
      normalizeText(extracted.province).slice(0, 120) || source.province,
    municipality: normalizeText(extracted.municipality).slice(0, 120) || null,
    eligible_ateco_prefixes: safeTextArray(extracted.eligible_ateco_prefixes),
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
    max_grant_amount: boundedNumeric(extracted.max_grant_amount, 15, 2),
    total_budget: boundedNumeric(extracted.total_budget, 18, 2),
    opens_at: safeTimestamp(extracted.opens_at),
    deadline_at: deadline,
    click_day: extracted.click_day === true,
    requirements: safeTextArray(extracted.requirements, 100, 1000),
    eligible_expenses: safeTextArray(extracted.eligible_expenses, 100, 1000),
    rarity_score:
      boundedInteger(Math.trunc(Number(source.rarity_base ?? 1)), 1, 5) ?? 1,
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
  const supplied = req.headers.get("x-internal-secret") ?? "";
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
        .in("verification_status", ["VERIFICATO", "PARZIALE"])
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
      .in("verification_status", ["VERIFICATO", "PARZIALE", "DA_VERIFICARE"]);
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
      .in("verification_status", ["VERIFICATO", "PARZIALE", "DA_VERIFICARE"])
      .or(`deadline_at.is.null,deadline_at.gte.${new Date().toISOString()}`)
      .order("deadline_at", { ascending: true, nullsFirst: false })
      .limit(limit);
    if (error) return response(500, { ok: false, code: "FEED_QUERY_FAILED" });
    const matched = (data ?? []).map((item) => ({
      ...item,
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
          next_scan_at: sourceData.next_scan_at,
          max_pages: maxPages,
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
      (dueResult.data ?? []) as Source[],
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
                next_scan_at: candidate.next_scan_at,
                max_pages: maxPages,
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
    // Cache-first: il pool persistito di candidati ufficiali evita ricerche
    // a pagamento ridondanti e garantisce profondita' reale sulla fonte.
    const cachedPool = await loadCachedCandidates(sb, source);
    const freshPool = freshCandidates(cachedPool, nowMs);
    const searchSkippedByCache = shouldSkipPaidSearch(
      freshPool.length,
      maxPages,
    );
    const [fc, pp] = searchSkippedByCache
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
    const searchEntries = searchSkippedByCache
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

    for (const hit of hits) {
      const cachedState = byUrl.get(hit.url);
      directFetchAttempted++;
      const scraped = await loadPage(hit.url, source.official_domain);
      if (scraped?.provider === "official-http") directFetchSucceeded++;
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
      const extracted = await extractOpportunity(source, hit, scraped.markdown);
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
        code: extracted.mode === "json_fallback" ? "OK_FALLBACK" : "OK_SCHEMA",
      });
      const stored = await storeOpportunity(
        sb,
        source,
        hit,
        extracted.data,
        scraped.markdown,
        scraped.provider,
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
            : fc.ok
              ? "OK"
              : fc.code,
          perplexity_search_status: searchSkippedByCache
            ? "SKIPPED_CACHE"
            : pp.ok
              ? "OK"
              : pp.code,
          paid_search_calls: searchSkippedByCache ? 0 : 2,
          cache_candidates: cachedPool.length,
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

