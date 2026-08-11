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

const POSITIVE_TOKENS: Array<[RegExp, number]> = [
  [/scadenz/i, 6],
  [/termin[ei]/i, 4],
  [/bando\b|avviso\b/i, 4],
  [/decreto|determina|delibera/i, 3],
  [/allegat|modulistica|documenti/i, 2],
  [/dotazion|risorse|contribut|agevolazion/i, 3],
  [/dettagli|scheda|leggi tutto|approfondi/i, 2],
  [/\.pdf(\?|#|$)/i, 3],
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
  const limit = Math.max(0, options?.limit ?? 2);
  if (!html || limit === 0) return [];
  const excluded = new Set(
    [...(options?.exclude ?? [])]
      .map((value) => canonical(value))
      .filter(Boolean),
  );
  const base = canonical(baseUrl);
  if (base) excluded.add(base);

  const scored = new Map<string, DetailLink>();
  let match: RegExpExecArray | null;
  while ((match = LINK_REGEX.exec(html)) !== null) {
    const rawHref = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#")) continue;
    if (/^(javascript|mailto|tel|data):/i.test(rawHref)) continue;
    let absolute: string;
    try {
      absolute = canonical(new URL(rawHref, baseUrl).toString());
    } catch {
      continue;
    }
    if (!absolute || excluded.has(absolute)) continue;
    if (!isAllowedOfficialUrl(absolute, officialDomain)) continue;
    const label = stripTags(match[5] ?? "").slice(0, 200);
    const haystack = `${label} ${absolute}`;
    if (NEGATIVE_TOKENS.test(haystack)) continue;
    let score = 0;
    for (const [pattern, weight] of POSITIVE_TOKENS) {
      if (pattern.test(haystack)) score += weight;
    }
    if (score <= 0) continue;
    const existing = scored.get(absolute);
    if (!existing || existing.score < score) {
      scored.set(absolute, { url: absolute, score, label });
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit);
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

const DEADLINE_STRONG =
  /(scadenz\w*|termine ultimo|termine finale|termine di presentazione|entro (?:e non oltre )?(?:il|le|la)|domande?\s+entro|presentazione\s+entro|chiusura(?: dello)? sportello|data di chiusura)/i;

const NUMERIC_DATE = /(\d{1,2})[/\-.](\d{1,2})[/\-.](20\d{2})/g;
const TEXT_DATE = new RegExp(
  `(\\d{1,2})\\s+(${Object.keys(MESI).join("|")})\\s+(20\\d{2})`,
  "gi",
);
const HOUR = /ore\s+(\d{1,2})[:.](\d{2})/i;

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
  return best;
}

const AMOUNT =
  /(?:€|euro|eur)\s*([\d][\d.\s]{2,18}(?:,\d{1,2})?)|([\d][\d.\s]{4,18}(?:,\d{1,2})?)\s*(?:€|euro|eur)\b/gi;

const MAX_GRANT_CTX =
  /(contributo (?:massimo|max)|importo massimo del contributo|agevolazione massima|contributo (?:concedibile|erogabile)|fino a un massimo di contributo)/i;
const BUDGET_CTX =
  /(dotazione(?: finanziaria| complessiva)?|risorse (?:disponibili|stanziate|complessive)|stanziament\w*|plafond|budget complessivo)/i;

const MIN_AMOUNT = 1_000;
const MAX_AMOUNT = 2_000_000_000;

function parseAmountValue(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const value = Number(cleaned);
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
  AMOUNT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AMOUNT.exec(text)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    const value = parseAmountValue(raw);
    if (value == null) continue;
    const from = Math.max(0, match.index - 160);
    const window = text.slice(from, match.index + match[0].length + 40);
    const evidence = window.replace(/\s+/g, " ").trim().slice(0, 300);
    if (MAX_GRANT_CTX.test(window)) {
      if (!out.max_grant_amount || out.max_grant_amount.value < value) {
        out.max_grant_amount = { value, evidence, confidence: "alta" };
      }
      continue;
    }
    if (BUDGET_CTX.test(window)) {
      if (!out.total_budget || out.total_budget.value < value) {
        out.total_budget = { value, evidence, confidence: "alta" };
      }
    }
  }
  return out;
}

function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

/** Serve un fetch di dettaglio solo se manca la scadenza o ogni importo. */
export function needsDetailEnrichment(
  extracted: Record<string, unknown>,
): boolean {
  const noDeadline = isMissing(extracted.deadline_at);
  const noAmount =
    isMissing(extracted.max_grant_amount) && isMissing(extracted.total_budget);
  return noDeadline || noAmount;
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
