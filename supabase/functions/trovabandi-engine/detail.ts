// UEradar / TrovaBandi — arricchimento da pagina o PDF di dettaglio.
//
// Costo provider zero: i link di dettaglio vengono letti dall'HTML già
// scaricato dal fetch ufficiale diretto e riscaricati con lo stesso client
// HTTP (nessun Firecrawl, nessun Apify, nessuna chiamata di estrazione AI).
//
// Regole non negoziabili:
//  - solo stesso dominio ufficiale (la verifica resta in scrape.ts);
//  - parser deterministici: nessuna inferenza, nessun dato inventato;
//  - una data è una scadenza soltanto se il contesto lo dichiara;
//  - un importo è valorizzato soltanto se il contesto distingue contributo
//    massimo e dotazione complessiva;
//  - il merge riempie esclusivamente campi nulli, non sovrascrive mai.

import { isAllowedOfficialUrl } from "./scrape.ts";

export interface DetailLink {
  url: string;
  score: number;
  label: string;
}

const LINK_REGEX = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi;

export const DETAIL_DEFAULT_LIMIT = 8;

const POSITIVE_TOKENS: Array<[RegExp, number]> = [
  [/disposizion/i, 12],
  [/Download\?idAllegato=/i, 8],
  [/allegat\w*.*\.pdf|\.pdf.*allegat/i, 10],
  [/(?:bando|avviso)\b.*\.pdf|\.pdf.*(?:bando|avviso)/i, 8],
  [/scadenz/i, 8],
  [/dotazion/i, 6],
  [/\.pdf(\?|#|$)/i, 5],
  [/termin[ei]/i, 4],
  [/bando\b|avviso\b/i, 4],
  [/decreto|determina|delibera/i, 3],
  [/allegat|modulistica|documenti/i, 3],
  [/risorse|contribut|agevolazion/i, 3],
  [/dettagli|scheda|leggi tutto|approfondi/i, 2],
];

const NEGATIVE_TOKENS =
  /(privacy|cookie|accessibilit|amministrazione-trasparente|login|mappa-del-sito|newsletter|facebook|twitter|linkedin|instagram|youtube|rss|feed|\.(?:jpg|jpeg|png|gif|svg|zip|doc|docx|xls|xlsx|mp4)(?:\?|#|$))/i;

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/** Punteggio deterministico: solo token espliciti, nessuna inferenza. */
export function scoreDetailCandidate(haystack: string): number {
  if (!haystack) return 0;
  let score = 0;
  for (const [pattern, weight] of POSITIVE_TOKENS) {
    if (pattern.test(haystack)) score += weight;
  }
  // Modulistica / schede sintetiche after disposizioni / avviso / bando.
  if (
    /modul[oi]|modulistica|facsimile|scheda\s+sintetic/i.test(haystack) &&
    !/disposizion|(?:bando|avviso)\b/i.test(haystack)
  ) {
    score = Math.max(0, score - 6);
  }
  return score;
}

function excludedSet(
  exclude: Iterable<string> | undefined,
  baseUrl: string,
): Set<string> {
  const excluded = new Set(
    [...(exclude ?? [])].map((value) => canonical(value)).filter(Boolean),
  );
  const base = canonical(baseUrl);
  if (base) excluded.add(base);
  return excluded;
}

function resolveOfficialHref(
  rawHref: string,
  baseUrl: string,
  officialDomain: string,
  excluded: Set<string>,
): string | null {
  const href = rawHref.trim();
  if (!href || href.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|data):/i.test(href)) return null;
  let absolute: string;
  try {
    absolute = canonical(new URL(href, baseUrl).toString());
  } catch {
    return null;
  }
  if (!absolute || excluded.has(absolute)) return null;
  if (!isAllowedOfficialUrl(absolute, officialDomain)) return null;
  return absolute;
}

function keepBestLink(
  scored: Map<string, DetailLink>,
  url: string,
  score: number,
  label: string,
): void {
  const existing = scored.get(url);
  if (!existing || existing.score < score) {
    scored.set(url, { url, score, label: label.slice(0, 200) });
  }
}

function rankedLinks(
  scored: Map<string, DetailLink>,
  limit: number,
): DetailLink[] {
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit);
}

/**
 * Estrae al massimo `limit` link di dettaglio dall'HTML già scaricato.
 * Nessun fetch, nessuna esecuzione: puro parsing testuale.
 */
export function extractDetailLinks(
  html: string,
  baseUrl: string,
  officialDomain: string,
  options?: { limit?: number; exclude?: Iterable<string> },
): DetailLink[] {
  const limit = Math.max(0, options?.limit ?? DETAIL_DEFAULT_LIMIT);
  if (!html || limit === 0) return [];
  const excluded = excludedSet(options?.exclude, baseUrl);

  const scored = new Map<string, DetailLink>();
  let match: RegExpExecArray | null;
  LINK_REGEX.lastIndex = 0;
  while ((match = LINK_REGEX.exec(html)) !== null) {
    const rawHref = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    const absolute = resolveOfficialHref(
      rawHref,
      baseUrl,
      officialDomain,
      excluded,
    );
    if (!absolute) continue;
    const label = stripTags(match[5] ?? "").slice(0, 200);
    const haystack = `${label} ${absolute}`;
    if (NEGATIVE_TOKENS.test(haystack)) continue;
    const score = scoreDetailCandidate(haystack);
    if (score <= 0) continue;
    keepBestLink(scored, absolute, score, label);
  }
  return rankedLinks(scored, limit);
}

const ABSOLUTE_URL = /https?:\/\/[^\s<>"'`\]\)]+/gi;
const RELATIVE_PDF =
  /((?:\.\.\/|\.\/|\/)[^\s<>"'`\]]+\.pdf(?:[?#][^\s<>"'`]*)?)/gi;
const MARKDOWN_LINK = /\[([^\]]{0,200})\]\(([^)\s]+)\)/g;

function trimUrlNoise(raw: string): string {
  return raw.replace(/[.,;:]+$/g, "");
}

function contextWindow(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 80);
  const to = Math.min(text.length, end + 80);
  return text.slice(from, to).replace(/\s+/g, " ");
}

function isInsideAbsoluteUrl(text: string, index: number): boolean {
  return /https?:\/\/\S*$/i.test(text.slice(Math.max(0, index - 96), index));
}

/**
 * Trova URL https e path relativi .pdf nel markdown/testo piano.
 * Il punteggio usa ±80 caratteri di contesto. Solo stesso dominio ufficiale.
 */
export function extractDetailLinksFromMarkdown(
  markdown: string,
  baseUrl: string,
  officialDomain: string,
  options?: { limit?: number; exclude?: Iterable<string> },
): DetailLink[] {
  const limit = Math.max(0, options?.limit ?? DETAIL_DEFAULT_LIMIT);
  if (!markdown || limit === 0) return [];
  const excluded = excludedSet(options?.exclude, baseUrl);
  const scored = new Map<string, DetailLink>();

  const consider = (
    rawHref: string,
    start: number,
    end: number,
    label: string,
  ) => {
    const absolute = resolveOfficialHref(
      trimUrlNoise(rawHref),
      baseUrl,
      officialDomain,
      excluded,
    );
    if (!absolute) return;
    const context = contextWindow(markdown, start, end);
    const haystack = `${label} ${absolute} ${context}`;
    if (NEGATIVE_TOKENS.test(haystack)) return;
    const score = scoreDetailCandidate(haystack);
    if (score <= 0) return;
    keepBestLink(scored, absolute, score, label);
  };

  MARKDOWN_LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK.exec(markdown)) !== null) {
    consider(
      match[2] ?? "",
      match.index,
      match.index + match[0].length,
      stripTags(match[1] ?? ""),
    );
  }

  ABSOLUTE_URL.lastIndex = 0;
  while ((match = ABSOLUTE_URL.exec(markdown)) !== null) {
    consider(match[0], match.index, match.index + match[0].length, "");
  }

  RELATIVE_PDF.lastIndex = 0;
  while ((match = RELATIVE_PDF.exec(markdown)) !== null) {
    if (isInsideAbsoluteUrl(markdown, match.index)) continue;
    consider(match[1] ?? "", match.index, match.index + match[0].length, "");
  }

  return rankedLinks(scored, limit);
}

const DECLARED_SCORE_BONUS = 40;
const DETAIL_GATHER_LIMIT = 32;

export interface CollectDetailTargetsInput {
  html: string;
  markdown?: string;
  baseUrl: string;
  officialDomain: string;
  exclude?: Iterable<string>;
  declared?: Iterable<string>;
  limit?: number;
}

/**
 * Unisce URL dichiarati, link HTML e URL nel markdown. Deduplica, ordina
 * per punteggio (i PDF di avviso dichiarati restano in testa) e taglia
 * a `limit` (default 8). Nessun fetch.
 */
export function collectDetailTargets(
  input: CollectDetailTargetsInput,
): string[] {
  const limit = Math.max(0, input.limit ?? DETAIL_DEFAULT_LIMIT);
  if (limit === 0) return [];
  const exclude = excludedSet(input.exclude, input.baseUrl);
  const scored = new Map<string, number>();

  const consider = (url: string, score: number) => {
    const absolute = canonical(url);
    if (!absolute || exclude.has(absolute)) return;
    if (!isAllowedOfficialUrl(absolute, input.officialDomain)) return;
    if (NEGATIVE_TOKENS.test(absolute)) return;
    const existing = scored.get(absolute) ?? Number.NEGATIVE_INFINITY;
    if (score > existing) scored.set(absolute, score);
  };

  for (const link of extractDetailLinks(
    input.html,
    input.baseUrl,
    input.officialDomain,
    { limit: DETAIL_GATHER_LIMIT, exclude },
  )) {
    consider(link.url, link.score);
  }

  if (input.markdown) {
    for (const link of extractDetailLinksFromMarkdown(
      input.markdown,
      input.baseUrl,
      input.officialDomain,
      { limit: DETAIL_GATHER_LIMIT, exclude },
    )) {
      consider(link.url, link.score);
    }
  }

  for (const raw of input.declared ?? []) {
    const absolute = canonical(raw);
    if (!absolute) continue;
    consider(absolute, scoreDetailCandidate(absolute) + DECLARED_SCORE_BONUS);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([url]) => url);
}

export interface DetailFieldHit<T> {
  value: T;
  evidence: string;
  confidence: "alta" | "media";
}

const MESI: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
};

// Mesi inglesi, forma estesa e abbreviata (fonti UE / CINEA / EISMEA).
const MONTHS_EN: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const DEADLINE_STRONG =
  /(scadenz\w*|termine ultimo|termine finale|termine di presentazione|entro (?:e non oltre )?(?:il|le|la)|domande?\s+entro|presentazione\s+entro|chiusura(?: dello)? sportello|data di chiusura|deadline|closing date|close[sd]? on|closure date|cut[- ]?off date|submission date|applications? (?:close|must be submitted|due)|due (?:by|date)|no later than|not later than|expir\w* on|final date|last day|open until|available until)/i;

const NUMERIC_DATE = /(\d{1,2})[/\-.](\d{1,2})[/\-.](20\d{2})/g;
// Formato ISO usato dai portali UE: 2026-10-09.
const ISO_DATE = /(20\d{2})-(\d{2})-(\d{2})/g;
const TEXT_DATE = new RegExp(
  `(\\d{1,2})\\s+(${Object.keys(MESI).join("|")})\\s+(20\\d{2})`,
  "gi",
);
const MONTH_EN_ALT = Object.keys(MONTHS_EN).sort((a, b) => b.length - a.length).join("|");
// "9 October 2026" / "9th October 2026"
const TEXT_DATE_EN_DMY = new RegExp(
  `(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_EN_ALT})\\.?,?\\s+(20\\d{2})`,
  "gi",
);
// "October 9, 2026"
const TEXT_DATE_EN_MDY = new RegExp(
  `(${MONTH_EN_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`,
  "gi",
);
const HOUR = /(?:ore|at|by|hrs?)\s+(\d{1,2})[:.](\d{2})/i;


function isoFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString();
}

/**
 * Scadenza da testo ufficiale: accettata solo con contesto esplicito di
 * termine entro 200 caratteri e finestra temporale plausibile (dal giorno
 * corrente a 36 mesi). Qualunque ambiguità restituisce null.
 */
export function parseDeadline(
  text: string,
  now: Date = new Date(),
): DetailFieldHit<string> | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const min = now.getTime() - 24 * 60 * 60 * 1000;
  const max = now.getTime() + 36 * 30 * 24 * 60 * 60 * 1000;
  let best: DetailFieldHit<string> | null = null;

  const consider = (
    start: number,
    end: number,
    year: number,
    month: number,
    day: number,
  ) => {
    const from = Math.max(0, start - 200);
    const context = lower.slice(from, end + 60);
    if (!DEADLINE_STRONG.test(context)) return;
    const hourMatch = HOUR.exec(text.slice(from, end + 60));
    const hour = hourMatch ? Number(hourMatch[1]) : 23;
    const minute = hourMatch ? Number(hourMatch[2]) : 59;
    if (hour > 23 || minute > 59) return;
    const iso = isoFromParts(year, month, day, hour, minute);
    if (!iso) return;
    const time = new Date(iso).getTime();
    if (time < min || time > max) return;
    const evidence = text
      .slice(from, end + 60)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    // La scadenza più vicina nel futuro è la più prudente.
    if (!best || time < new Date(best.value).getTime()) {
      best = { value: iso, evidence, confidence: "alta" };
    }
  };

  NUMERIC_DATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMERIC_DATE.exec(text)) !== null) {
    consider(
      match.index,
      match.index + match[0].length,
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
    );
  }
  ISO_DATE.lastIndex = 0;
  while ((match = ISO_DATE.exec(text)) !== null) {
    consider(
      match.index,
      match.index + match[0].length,
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
  }
  TEXT_DATE.lastIndex = 0;
  while ((match = TEXT_DATE.exec(text)) !== null) {
    consider(
      match.index,
      match.index + match[0].length,
      Number(match[3]),
      MESI[match[2].toLowerCase()],
      Number(match[1]),
    );
  }
  TEXT_DATE_EN_DMY.lastIndex = 0;
  while ((match = TEXT_DATE_EN_DMY.exec(text)) !== null) {
    consider(
      match.index,
      match.index + match[0].length,
      Number(match[3]),
      MONTHS_EN[match[2].toLowerCase()],
      Number(match[1]),
    );
  }
  TEXT_DATE_EN_MDY.lastIndex = 0;
  while ((match = TEXT_DATE_EN_MDY.exec(text)) !== null) {
    consider(
      match.index,
      match.index + match[0].length,
      Number(match[3]),
      MONTHS_EN[match[1].toLowerCase()],
      Number(match[2]),
    );
  }
  return best;
}

const AMOUNT =
  /(?:€|eur\b|euros?\b)\s*([\d][\d.,\s]{2,20}\d)|([\d][\d.,\s]{4,20}\d)\s*(?:€|eur\b|euros?\b)/gi;

/**
 * Moltiplicatori per importi scritti a parole. Solo forme non ambigue:
 * "mln"/"mld"/"bn" sono abbreviazioni standard, "m"/"k" isolate NON sono
 * accettate perché troppo spesso indicano metri o altre unità.
 */
const SCALE_WORDS: Record<string, number> = {
  mila: 1_000,
  migliaia: 1_000,
  thousand: 1_000,
  thousands: 1_000,
  milione: 1_000_000,
  milioni: 1_000_000,
  mln: 1_000_000,
  million: 1_000_000,
  millions: 1_000_000,
  miliardo: 1_000_000_000,
  miliardi: 1_000_000_000,
  mld: 1_000_000_000,
  billion: 1_000_000_000,
  billions: 1_000_000_000,
  bn: 1_000_000_000,
};

const SCALE_PATTERN =
  "mila|migliaia|thousands?|milion[ei]|mln|millions?|miliard[oi]|mld|billions?|bn";

/**
 * Importi a parole: la valuta deve essere esplicita (prima o dopo il numero),
 * altrimenti la cifra viene scartata.
 */
const SCALED_AMOUNT = new RegExp(
  `(?:(?:€|eur\\b|euros?\\b)\\s*(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(${SCALE_PATTERN})\\b)` +
    `|(?:(\\d{1,3}(?:[.,]\\d{1,2})?)\\s*(${SCALE_PATTERN})\\b\\s*(?:di\\s+)?(?:€|eur\\b|euros?\\b))`,
  "gi",
);


const MAX_GRANT_CTX =
  /(contributo (?:massimo|max)|importo massimo del contributo|agevolazione massima|contributo (?:concedibile|erogabile)|fino a un massimo di contributo|maximum (?:grant|contribution|funding|aid|support|amount of (?:the )?(?:grant|aid))|grant (?:amount )?up to|funding up to|up to a maximum of|maximum amount per (?:project|beneficiary|application)|per project maximum)/i;
const BUDGET_CTX =
  /(dotazione(?: finanziaria| complessiva)?|risorse (?:disponibili|stanziate|complessive)|stanziament\w*|plafond|budget complessivo|(?:total|overall|indicative|available|call|programme|program)\s+budget|budget (?:of|for the call|available)|endowment|financial envelope|total funding available|available funds|total allocation)/i;

const MIN_AMOUNT = 1_000;
const MAX_AMOUNT = 2_000_000_000;

/**
 * Normalizza il valore numerico gestendo sia il formato italiano
 * (1.234.567,89) sia quello inglese (1,234,567.89). L'ultimo separatore
 * è decimale solo se seguito da 1-2 cifre; in ogni altro caso è migliaia.
 */
function parseAmountValue(raw: string): number | null {
  let s = raw.replace(/\s/g, "").replace(/[.,]$/, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);
  if (lastSep >= 0) {
    const decimals = s.length - lastSep - 1;
    const isDecimal = decimals === 1 || decimals === 2;
    const sepChar = s[lastSep];
    const intPart = s.slice(0, lastSep).replace(/[.,]/g, "");
    if (isDecimal) {
      // Ambiguità "1.234" / "1,234": con 3 cifre è migliaia, qui decimals<3.
      s = `${intPart}.${s.slice(lastSep + 1)}`;
    } else {
      if (sepChar && decimals !== 3 && decimals !== 0) return null;
      s = s.replace(/[.,]/g, "");
    }
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Valore di un importo scritto a parole ("5 milioni", "1,5 mld").
 * Il separatore è sempre decimale: la parte intera è limitata a 3 cifre.
 */
function parseScaledValue(raw: string, word: string): number | null {
  const scale = SCALE_WORDS[word.toLowerCase()];
  if (!scale) return null;
  const normalized = raw.replace(/\s/g, "").replace(",", ".");
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized) * scale;
  if (!Number.isFinite(value)) return null;
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) return null;
  return Math.round(value * 100) / 100;
}

export interface DetailAmounts {
  max_grant_amount?: DetailFieldHit<number>;
  total_budget?: DetailFieldHit<number>;
}

/**
 * Importi da testo ufficiale: valorizzati soltanto quando il contesto
 * distingue esplicitamente contributo massimo e dotazione complessiva.
 * Soglie di ammissibilità, volumi d'affari e massimali di spesa vengono
 * ignorati per progetto.
 */
export function parseAmounts(text: string): DetailAmounts {
  const out: DetailAmounts = {};
  if (!text) return out;

  const assign = (value: number, start: number, end: number) => {
    const from = Math.max(0, start - 160);
    const window = text.slice(from, end + 40);
    const evidence = window.replace(/\s+/g, " ").trim().slice(0, 300);
    if (MAX_GRANT_CTX.test(window)) {
      if (!out.max_grant_amount || out.max_grant_amount.value < value) {
        out.max_grant_amount = { value, evidence, confidence: "alta" };
      }
      return;
    }
    if (BUDGET_CTX.test(window)) {
      if (!out.total_budget || out.total_budget.value < value) {
        out.total_budget = { value, evidence, confidence: "alta" };
      }
    }
  };

  AMOUNT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AMOUNT.exec(text)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    const value = parseAmountValue(raw);
    if (value == null) continue;
    assign(value, match.index, match.index + match[0].length);
  }

  SCALED_AMOUNT.lastIndex = 0;
  while ((match = SCALED_AMOUNT.exec(text)) !== null) {
    const raw = (match[1] ?? match[3] ?? "").trim();
    const word = (match[2] ?? match[4] ?? "").trim();
    const value = parseScaledValue(raw, word);
    if (value == null) continue;
    assign(value, match.index, match.index + match[0].length);
  }

  return out;
}


function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

/** Serve un fetch di dettaglio se manca la scadenza o l'importo (max_grant).
 * total_budget da solo non chiude la scheda PWA: manca importo_max. */
export function needsDetailEnrichment(
  extracted: Record<string, unknown>,
): boolean {
  const noDeadline = isMissing(extracted.deadline_at);
  const noImporto = isMissing(extracted.max_grant_amount);
  return noDeadline || noImporto;
}

export interface DetailMergeResult {
  patch: Record<string, unknown>;
  filled: string[];
}

/**
 * Merge fail-closed: scrive esclusivamente campi nulli o vuoti.
 * Un valore già estratto dalla pagina principale non viene mai sovrascritto.
 */
export function mergeDetailIntoExtraction(
  extracted: Record<string, unknown>,
  detail: { deadline?: DetailFieldHit<string> | null; amounts?: DetailAmounts },
): DetailMergeResult {
  const patch: Record<string, unknown> = {};
  const filled: string[] = [];
  if (detail.deadline && isMissing(extracted.deadline_at)) {
    patch.deadline_at = detail.deadline.value;
    filled.push("deadline_at");
  }
  const amounts = detail.amounts ?? {};
  if (amounts.max_grant_amount && isMissing(extracted.max_grant_amount)) {
    patch.max_grant_amount = amounts.max_grant_amount.value;
    filled.push("max_grant_amount");
  }
  if (amounts.total_budget && isMissing(extracted.total_budget)) {
    patch.total_budget = amounts.total_budget.value;
    filled.push("total_budget");
  }
  return { patch, filled };
}
