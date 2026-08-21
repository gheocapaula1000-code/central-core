// TrovaBandi — parsing e validazione rigorosa dell'estrazione documentale.
// Isolato dal dominio TrovaBandi: nessuna dipendenza condivisa con altre PWA.
//
// Regole:
//  - nessun falso positivo: si accetta solo is_opportunity === true con
//    categoria nell'enum ufficiale, titolo/summary presenti e official_url
//    sul dominio ufficiale atteso;
//  - fail-closed: qualunque ambiguità restituisce un codice di errore
//    non sensibile (mai URL completi, contenuti o secret).

import { isIndexOrLandingUrl } from "./opportunity-gate.ts";

export type JsonObject = Record<string, unknown>;

export const EXTRACTION_CATEGORIES = [
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
] as const;

export type ExtractionCategory = (typeof EXTRACTION_CATEGORIES)[number];

/** Classi HTTP sanificate: mai body, mai URL, mai secret. */
export type HttpFailureCode =
  | "HTTP_400"
  | "HTTP_401"
  | "HTTP_402"
  | "HTTP_403"
  | "HTTP_422"
  | "HTTP_429"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "HTTP_ERROR";

export type ExtractionFailureCode =
  | "NO_KEY"
  | "TIMEOUT"
  | HttpFailureCode
  | "EMPTY_CONTENT"
  | "PARSE_FAILED"
  | "NOT_OBJECT"
  | "SCHEMA_INVALID"
  | "CATEGORY_INVALID"
  | "URL_OFF_DOMAIN"
  | "NOT_OPPORTUNITY"
  | "UNKNOWN";

export type ExtractionOutcome =
  | { ok: true; data: JsonObject; mode: "json_schema" | "json_fallback" }
  | { ok: false; code: ExtractionFailureCode; mode?: "json_schema" | "json_fallback" };

/** Mappa uno status HTTP in una classe sanificata. */
export function httpFailureCode(status?: number): HttpFailureCode {
  if (typeof status !== "number" || !Number.isFinite(status)) return "HTTP_ERROR";
  if (status >= 500) return "HTTP_5XX";
  if (status === 400 || status === 401 || status === 402 || status === 403) {
    return `HTTP_${status}` as HttpFailureCode;
  }
  if (status === 422) return "HTTP_422";
  if (status === 429) return "HTTP_429";
  if (status >= 400) return "HTTP_4XX";
  return "HTTP_ERROR";
}

/**
 * Il fallback plain JSON è ammesso soltanto dopo un rifiuto dello schema
 * (HTTP 400/422) oppure una risposta 200 non parsabile/vuota.
 * Mai dopo 401/402/403/429/5xx/timeout: sono errori operativi, non di formato.
 */
const FALLBACK_ALLOWED_AFTER = new Set<ExtractionFailureCode>([
  "HTTP_400",
  "HTTP_422",
  "EMPTY_CONTENT",
  "PARSE_FAILED",
  "NOT_OBJECT",
]);

export function shouldTryPlainJsonFallback(code: ExtractionFailureCode): boolean {
  return FALLBACK_ALLOWED_AFTER.has(code);
}

/**
 * Unico esito negativo valido e non operativo: la pagina non è un'opportunità.
 * SCHEMA_INVALID, CATEGORY_INVALID e URL_OFF_DOMAIN sono guasti operativi
 * (estrazione inaffidabile o fuori dominio) e devono degradare il run.
 */
const NEGATIVE_OUTCOME_CODES = new Set<ExtractionFailureCode>(["NOT_OPPORTUNITY"]);

export function isNegativeOutcome(code: ExtractionFailureCode): boolean {
  return NEGATIVE_OUTCOME_CODES.has(code);
}

/** Guasti operativi: degradano il run a PARTIAL e non devono sbloccare il gate. */
export function isOperationalFailure(code: ExtractionFailureCode): boolean {
  return !NEGATIVE_OUTCOME_CODES.has(code);
}

/** Esiti tipizzati della ricerca provider: mai [] silenzioso su guasto. */
export type SearchFailureCode =
  | "NO_KEY"
  | "TIMEOUT"
  | HttpFailureCode
  | "RESPONSE_INVALID"
  | "PARSE_FAILED";

export type SearchOutcome<T> = { ok: true; hits: T[] } | { ok: false; code: SearchFailureCode };

/** Classifica un errore di rete/abort in un codice sanificato. */
export function searchFailureFromError(error: unknown): SearchFailureCode {
  return error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "HTTP_ERROR";
}

/**
 * Estrae le righe di risultato dal payload provider.
 * Una risposta valida con zero risultati NON è un guasto; una risposta di
 * forma inattesa sì (RESPONSE_INVALID).
 */
export function extractSearchRows(
  payload: unknown,
  provider: "firecrawl" | "perplexity",
): { ok: true; rows: unknown[] } | { ok: false; code: "RESPONSE_INVALID" } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "RESPONSE_INVALID" };
  }
  const obj = payload as JsonObject;
  if (provider === "perplexity") {
    if (Array.isArray(obj.results)) return { ok: true, rows: obj.results };
    return { ok: false, code: "RESPONSE_INVALID" };
  }
  const data = obj.data;
  if (Array.isArray(data)) return { ok: true, rows: data };
  if (data && typeof data === "object" && Array.isArray((data as JsonObject).web)) {
    return { ok: true, rows: (data as JsonObject).web as unknown[] };
  }
  return { ok: false, code: "RESPONSE_INVALID" };
}



/** Estrae un oggetto JSON da contenuto testuale del modello (fences, prefazioni). */
export function parseExtractionContent(
  content: string,
): { ok: true; value: JsonObject } | { ok: false; code: "EMPTY_CONTENT" | "PARSE_FAILED" | "NOT_OBJECT" } {
  const raw = typeof content === "string" ? content.trim() : "";
  if (!raw) return { ok: false, code: "EMPTY_CONTENT" };

  const candidates: string[] = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as JsonObject };
      }
      return { ok: false, code: "NOT_OBJECT" };
    } catch {
      // prova il candidato successivo
    }
  }
  return { ok: false, code: "PARSE_FAILED" };
}

function hostMatchesDomain(url: string, domain: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const allowed = domain.toLowerCase().replace(/^www\./, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  } catch {
    return false;
  }
}

/**
 * Validazione rigorosa. Restituisce l'oggetto normalizzato solo quando la
 * pagina è realmente un'opportunità con evidenza ufficiale sul dominio atteso.
 */
export function validateExtraction(
  parsed: JsonObject,
  officialDomain: string,
  evidenceUrl: string,
):
  | { ok: true; data: JsonObject }
  | {
      ok: false;
      code: "SCHEMA_INVALID" | "CATEGORY_INVALID" | "URL_OFF_DOMAIN" | "NOT_OPPORTUNITY";
    } {
  if (parsed.is_opportunity !== true) return { ok: false, code: "NOT_OPPORTUNITY" };
  if (isIndexOrLandingUrl(evidenceUrl)) return { ok: false, code: "NOT_OPPORTUNITY" };

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (title.length < 3 || summary.length < 10) return { ok: false, code: "SCHEMA_INVALID" };

  const category = (typeof parsed.category === "string" ? parsed.category : "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  if (!(EXTRACTION_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, code: "CATEGORY_INVALID" };
  }

  // L'evidenza deve sempre restare sul dominio ufficiale della fonte.
  if (!hostMatchesDomain(evidenceUrl, officialDomain)) return { ok: false, code: "URL_OFF_DOMAIN" };
  const declared = typeof parsed.official_url === "string" ? parsed.official_url.trim() : "";
  if (declared && !hostMatchesDomain(declared, officialDomain)) {
    return { ok: false, code: "URL_OFF_DOMAIN" };
  }

  const booleanFields = [
    "female_only",
    "youth_only",
    "startup_only",
    "innovative_only",
    "click_day",
    "de_minimis",
    "consortium_required",
    "direct_applicant_allowed",
  ];
  for (const field of booleanFields) {
    const value = parsed[field];
    if (value != null && typeof value !== "boolean") return { ok: false, code: "SCHEMA_INVALID" };
  }
  const numberFields = [
    "aid_intensity_percent",
    "min_grant_amount",
    "max_grant_amount",
    "total_budget",
    "min_partners",
  ];
  for (const field of numberFields) {
    const value = parsed[field];
    if (value != null && (typeof value !== "number" || !Number.isFinite(value))) {
      return { ok: false, code: "SCHEMA_INVALID" };
    }
  }
  const arrayFields = [
    "eligible_ateco_prefixes",
    "excluded_ateco_prefixes",
    "eligible_legal_forms",
    "eligible_company_sizes",
    "requirements",
    "eligible_expenses",
    "eligible_countries",
  ];
  for (const field of arrayFields) {
    const value = parsed[field];
    if (value != null && !Array.isArray(value)) return { ok: false, code: "SCHEMA_INVALID" };
  }

  return { ok: true, data: { ...parsed, category, title, summary, official_url: evidenceUrl } };
}

/** Diagnostica aggregata non sensibile: solo fase, codice e conteggio. */
export function aggregateDiagnostics(entries: Array<{ phase: string; code: string }>) {
  const counters: Record<string, number> = {};
  for (const entry of entries) {
    const key = `${entry.phase}:${entry.code}`;
    counters[key] = (counters[key] ?? 0) + 1;
  }
  return counters;
}

/**
 * Categoria: normalizzazione conservativa (underscore preservati) e
 * validazione contro l'enum ufficiale. Nessun valore inventato: se il
 * risultato non è ammesso dal CHECK di database si ritorna null.
 */
export function normalizeCategoryCode(value: unknown): ExtractionCategory | null {
  const code = (typeof value === "string" ? value : "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (EXTRACTION_CATEGORIES as readonly string[]).includes(code)
    ? (code as ExtractionCategory)
    : null;
}

export const AUTHORITY_LEVELS = ["EU", "NAZIONALE", "REGIONALE", "CAMERALE", "COMUNALE"] as const;

export function normalizeAuthorityLevel(value: unknown): string | null {
  const code = (typeof value === "string" ? value : "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (AUTHORITY_LEVELS as readonly string[]).includes(code) ? code : null;
}

/**
 * Valore per colonne numeric(p,s): rifiuta non finiti, negativi e overflow.
 * Non arrotonda verso valori "plausibili": fuori range ⇒ null (dato assente).
 */
export function boundedNumeric(value: unknown, precision: number, scale: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  const max = Math.pow(10, precision - scale);
  if (value >= max) return null;
  return Math.round(value * Math.pow(10, scale)) / Math.pow(10, scale);
}

/** Intero non negativo entro il range int4; qualsiasi altro valore ⇒ null. */
export function boundedInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/** Timestamptz sicuro: solo date reali entro un intervallo plausibile. */
export function safeTimestamp(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const date = new Date(raw);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  const year = date.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  return date.toISOString();
}

/** Array di testo per colonne text[]: elementi non vuoti, deduplicati, limitati. */
export function safeTextArray(value: unknown, maxItems = 100, maxLength = 500): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, maxLength);
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Telemetria sicura degli errori di scrittura: SOLO il codice Postgres/PostgREST.
 * Mai message, details, hint, riga, URL o contenuto.
 */
export function sanitizeDbErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const raw = typeof code === "string" ? code.trim().toUpperCase() : "";
  const safe = raw.replace(/[^A-Z0-9]/g, "");
  if (!safe) return "DB_UNKNOWN";
  return `DB_${safe.slice(0, 12)}`;
}

/**
 * Traduce un esito di ricerca in una voce di diagnostica sanificata.
 * Zero risultati con risposta valida non è un guasto operativo.
 */
export function searchDiagnostics(
  provider: "firecrawl" | "perplexity",
  outcome: { ok: true; hits: unknown[] } | { ok: false; code: SearchFailureCode },
): { phase: string; code: string; operational: boolean } {
  const phase = `search_${provider}`;
  if (outcome.ok === true) {
    return { phase, code: outcome.hits.length > 0 ? "OK" : "OK_EMPTY", operational: false };
  }
  return { phase, code: outcome.code, operational: true };
}


