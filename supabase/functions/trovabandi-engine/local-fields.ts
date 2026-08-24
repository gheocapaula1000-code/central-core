// UEradar.com — estrattori locali fail-closed per campi di profondità.
//
// Nessun provider a pagamento. Se il testo ufficiale non dichiara il
// campo in modo esplicito, si restituisce vuoto/null. Il matching resta
// DA_VERIFICARE / PARZIALE quando ATECO, PEC o URL domanda mancano.
// SPORTELLO è deciso dal testo ufficiale (verification.ts), non qui.

import { extractApplyLinks } from "./apply-links.ts";
import { EXTRACTION_CATEGORIES, type ExtractionCategory } from "./extraction.ts";
import { isEligibleOfficialOpportunity } from "./opportunity-gate.ts";

// Solo linguaggio di classificazione ufficiale. Mai "digitale" / "PMI" /
// "innovazione": non attestano un codice.
const ATECO_NEAR =
  /\b(?:codic[ei]\s+(?:ateco|nace)|(?:classificazione|settori?|division[ei]|categorie)\s+(?:ateco|nace)|ateco(?:\s+ammess[ioe])?|nace(?:\s+rev(?:ision)?)?)\b/gi;
// Solo con punto: 62.1 / 62.10 / 62.10.00 — mai un giorno ("30 settembre").
const ATECO_DOTTED_ONLY = /\b(\d{2})(?:\.\d{1,2}){1,2}(?:\.\d{2})?\b/g;
const ATECO_COMPACT = /\b(\d{4}|\d{6})\b/g;
const ATECO_LIST_TOKEN =
  /^(\d{2})(?:\.\d{1,2}){0,2}(?:\.\d{2})?/;
const MONTH_OR_DATE =
  /^(?:\s*(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|june|july|august|september|october|november|december)|\s*\/\s*\d)/i;
const DOC_REF_BEFORE =
  /(?:allegat[oi]|articol[oi]|art\.|decreto|comma|punto|n\.|n°)\s*$/i;

function isClassificationYear(raw: string): boolean {
  if (!/^\d{4}$/.test(raw)) return false;
  const year = Number(raw);
  return year >= 1990 && year <= 2100;
}

function isValidDivision(two: string): boolean {
  if (!/^\d{2}$/.test(two)) return false;
  const n = Number(two);
  return n >= 1 && n <= 99;
}

function addDivision(found: Set<string>, two: string): boolean {
  if (!isValidDivision(two)) return false;
  found.add(two);
  return found.size >= 12;
}

function precededByDocRef(text: string, index: number): boolean {
  return DOC_REF_BEFORE.test(text.slice(Math.max(0, index - 24), index));
}

/** Elenco di codici subito dopo la keyword: "ATECO 62", "62.01 e 63.11", "55-Ricettività, 56". */
function collectListedCodes(after: string, found: Set<string>): boolean {
  let s = after.replace(/^\s*(?:ammess[ioe]\s+)?/i, "");
  while (s.length > 0 && found.size < 12) {
    s = s.replace(/^[\s,;:\/]+/, "");
    s = s.replace(/^(?:e|ed|o)\s+/i, "");
    const year = s.match(/^(?:19|20)\d{2}\b/);
    if (year) {
      s = s.slice(year[0].length);
      s = s.replace(/^\s+[A-U]\b/, "");
      continue;
    }
    const match = s.match(ATECO_LIST_TOKEN);
    if (!match) break;
    const full = match[0].replace(/\./g, "");
    const rest = s.slice(match[0].length);
    if (!MONTH_OR_DATE.test(rest) && isValidDivision(match[1])) {
      found.add(match[1]);
    }
    s = rest.replace(/^-[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\s]*/u, "");
    s = s.replace(/^\s*\([^)]{0,80}\)/, "");
    if (/^\s*\.\s+[A-Za-z]/.test(s)) break;
    if (/^[\s,;:\/]/.test(s) || /^(?:e|ed|o)\s+/i.test(s)) continue;
    const hop = s.match(
      /^(?:(?![.\n,;\d])[\s\S]){0,80}?(\s+e\s+|\s+ed\s+|\s+o\s+)(?=\d{2})/i,
    );
    if (hop) s = s.slice(hop[0].length);
  }
  return found.size >= 12;
}
const EMAIL =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PEC_HINT =
  /\b(?:pec|posta\s+elettronica\s+certificata|protocollo(?:\s+informatico)?)\b/i;

const OPPORTUNITY_HINT =
  /\b(?:bando|avviso\s+pubblico|contributo|incentiv[oi]|agevolazion[ei]|fondo\s+perduto|finanziamento\s+agevolato|voucher|call\s+for\s+(?:proposals?|tenders?)|grant|funding\s+opportunit)\b/i;

const CATEGORY_HINTS: Array<[RegExp, ExtractionCategory]> = [
  [/imprenditoria\s+femminile|imprese?\s+femminili/i, "IMPRENDITORIA_FEMMINILE"],
  [/imprenditoria\s+giovanile|imprese?\s+giovanili/i, "IMPRENDITORIA_GIOVANILE"],
  [/fondo\s+perduto|contributo\s+a\s+fondo\s+perduto/i, "FONDO_PERDUTO"],
  [/tasso\s+zero/i, "TASSO_ZERO"],
  [/finanziamento\s+agevolato/i, "FINANZIAMENTO_AGEVOLATO"],
  [/credito\s+(?:d['’])?imposta/i, "CREDITO_IMPOSTA"],
  [/\bvoucher\b/i, "VOUCHER"],
  [/digitalizzazion|transizione\s+digitale/i, "DIGITALIZZAZIONE"],
  [/transizione\s+energetica|rinnovabil/i, "TRANSIZIONE_ENERGETICA"],
  [/ricerca\s+e\s+sviluppo|\bpnr\b|horizon/i, "RICERCA_SVILUPPO"],
  [/internazionalizzazion/i, "INTERNAZIONALIZZAZIONE"],
  [/startup|pmi\s+innovativa/i, "STARTUP_INNOVAZIONE"],
  [/formazione|occupazione/i, "FORMAZIONE_OCCUPAZIONE"],
  [/agricolt|psr|pac\b|rurale/i, "AGRICOLTURA_RURALE"],
  [/turism|cultur/i, "TURISMO_CULTURA"],
  [/economia\s+circolare/i, "ECONOMIA_CIRCOLARE"],
  [/\bgaranzia\b/i, "GARANZIA"],
];

function nearby(text: string, index: number, radius = 80): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

/**
 * Prefissi ATECO (divisione a 2 cifre) solo se il testo ufficiale li
 * attesta accanto a una keyword di classificazione. Fail-closed:
 * anni di edizione (2007/2025), decreti, "digitalizzazione PMI" → [].
 */
export function localExtractAteco(markdown: string): string[] {
  if (typeof markdown !== "string" || markdown.trim().length < 20) return [];
  const found = new Set<string>();
  for (const hint of markdown.matchAll(ATECO_NEAR)) {
    const idx = hint.index ?? 0;
    const afterStart = idx + hint[0].length;
    if (collectListedCodes(markdown.slice(afterStart, afterStart + 240), found)) {
      return [...found];
    }
    const start = Math.max(0, idx - 48);
    const end = Math.min(markdown.length, afterStart + 240);
    const window = markdown.slice(start, end);
    for (const match of window.matchAll(ATECO_DOTTED_ONLY)) {
      const at = start + (match.index ?? 0);
      if (precededByDocRef(markdown, at)) continue;
      const full = match[0].replace(/\./g, "");
      if (isClassificationYear(full)) continue;
      if (addDivision(found, match[1])) return [...found];
    }
    for (const match of window.matchAll(ATECO_COMPACT)) {
      const at = start + (match.index ?? 0);
      if (precededByDocRef(markdown, at)) continue;
      if (isClassificationYear(match[1])) continue;
      if (addDivision(found, match[1].slice(0, 2))) return [...found];
    }
  }
  return [...found];
}

/** PEC/protocollo: solo email vicina a una keyword istituzionale. */
export function localExtractProtocolEmail(markdown: string): string | null {
  if (typeof markdown !== "string") return null;
  for (const match of markdown.matchAll(EMAIL)) {
    const idx = match.index ?? -1;
    if (idx < 0) continue;
    if (!PEC_HINT.test(nearby(markdown, idx, 60))) continue;
    const email = match[0].toLowerCase();
    if (email.length > 320) continue;
    return email;
  }
  return null;
}

/** URL di domanda: link ufficiale il cui contesto parla di presentazione. */
export function localExtractApplicationUrl(
  markdown: string,
  officialDomain: string,
): string | null {
  if (typeof markdown !== "string" || !officialDomain) return null;
  return extractApplyLinks({
    markdown,
    officialUrl: `https://${officialDomain.replace(/^www\./i, "")}/placeholder`,
    officialDomain,
  }).application_url;
}

/** URL di modulistica / PDF compilabile, solo se etichettato sulla pagina. */
export function localExtractFormsUrl(
  markdown: string,
  officialDomain: string,
): string | null {
  if (typeof markdown !== "string" || !officialDomain) return null;
  return extractApplyLinks({
    markdown,
    officialUrl: `https://${officialDomain.replace(/^www\./i, "")}/placeholder`,
    officialDomain,
  }).forms_url;
}

export function looksLikeOpportunity(markdown: string): boolean {
  if (typeof markdown !== "string" || markdown.trim().length < 400) return false;
  return OPPORTUNITY_HINT.test(markdown);
}

export function localGuessCategory(markdown: string): ExtractionCategory {
  if (typeof markdown !== "string") return "ALTRO";
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(markdown)) return category;
  }
  return "ALTRO";
}

export function localTitle(markdown: string, fallback: string): string {
  const first = (markdown ?? "")
    .split(/\n+/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length >= 8 && line.length <= 220);
  const title = (first || fallback || "").replace(/\s+/g, " ").trim();
  return title.slice(0, 500);
}

/**
 * Bozza locale di opportunità: solo campi dichiarati nel testo.
 * Non marca mai COMPATIBILE: ATECO/forme/dimensioni restano vuoti se
 * assenti, quindi il matching resta DA_VERIFICARE.
 */
export function localOpportunityDraft(input: {
  markdown: string;
  officialUrl: string;
  titleHint?: string;
  officialDomain: string;
  deadline?: string | null;
  min_grant_amount?: number | null;
  max_grant_amount?: number | null;
  total_budget?: number | null;
}): Record<string, unknown> | null {
  if (
    !isEligibleOfficialOpportunity({
      officialUrl: input.officialUrl,
      markdown: input.markdown,
    })
  ) {
    return null;
  }
  const title = localTitle(input.markdown, input.titleHint ?? "");
  if (title.length < 3) return null;
  const summary = input.markdown.replace(/\s+/g, " ").trim().slice(0, 800);
  if (summary.length < 10) return null;
  return {
    is_opportunity: true,
    title,
    authority_name: "",
    category: localGuessCategory(input.markdown),
    summary,
    official_url: input.officialUrl,
    application_url: localExtractApplicationUrl(
      input.markdown,
      input.officialDomain,
    ),
    forms_url: localExtractFormsUrl(input.markdown, input.officialDomain),
    protocol_email: localExtractProtocolEmail(input.markdown),
    eligible_ateco_prefixes: localExtractAteco(input.markdown),
    excluded_ateco_prefixes: [],
    eligible_legal_forms: [],
    eligible_company_sizes: [],
    female_only: /imprenditoria\s+femminile|riservat[oa]\s+a\s+imprese?\s+femminili/i.test(
      input.markdown,
    ),
    youth_only: /imprenditoria\s+giovanile|riservat[oa]\s+a\s+imprese?\s+giovanili/i.test(
      input.markdown,
    ),
    startup_only: false,
    innovative_only: false,
    deadline_at: input.deadline ?? null,
    min_grant_amount: input.min_grant_amount ?? null,
    max_grant_amount: input.max_grant_amount ?? null,
    total_budget: input.total_budget ?? null,
    requirements: [],
    eligible_expenses: [],
    eligible_countries: [],
  };
}

export function assertKnownCategory(value: string): ExtractionCategory {
  return (EXTRACTION_CATEGORIES as readonly string[]).includes(value)
    ? (value as ExtractionCategory)
    : "ALTRO";
}
