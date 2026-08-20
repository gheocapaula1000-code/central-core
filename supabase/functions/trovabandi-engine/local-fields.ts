// UEradar.com — estrattori locali fail-closed per campi di profondità.
//
// Nessun provider a pagamento. Se il testo ufficiale non dichiara il
// campo in modo esplicito, si restituisce vuoto/null. Il matching resta
// DA_VERIFICARE / PARZIALE quando ATECO, PEC o URL domanda mancano.

import { EXTRACTION_CATEGORIES, type ExtractionCategory } from "./extraction.ts";
import { isAllowedOfficialUrl } from "./scrape.ts";

const ATECO_NEAR =
  /\b(?:codic[ei]\s+ateco|ateco(?:\s+ammess[ioe])?|classificazione\s+ateco)\b/gi;
const ATECO_CODE = /\b(\d{2}(?:\.\d{1,2}){1,2}|\d{4,6})\b/g;
const EMAIL =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PEC_HINT =
  /\b(?:pec|posta\s+elettronica\s+certificata|protocollo(?:\s+informatico)?)\b/i;
const APPLICATION_HINT =
  /\b(?:presenta(?:zione)?\s+(?:la\s+)?domanda|domanda\s+online|sportello|candidatura|apply|submission|modulo\s+di\s+domanda|piattaforma)\b/i;

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

/** Prefissi ATECO solo se il testo li qualifica esplicitamente. */
export function localExtractAteco(markdown: string): string[] {
  if (typeof markdown !== "string" || markdown.length < 20) return [];
  const found = new Set<string>();
  for (const hint of markdown.matchAll(ATECO_NEAR)) {
    const start = (hint.index ?? 0) + hint[0].length;
    const window = markdown.slice(start, start + 100);
    for (const match of window.matchAll(ATECO_CODE)) {
      const compact = match[1].replace(/\./g, "");
      if (compact.length < 2) continue;
      found.add(compact.slice(0, 2));
      if (found.size >= 12) return [...found];
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
  const patterns = [
    /\[([^\]]{0,80})\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi,
    /https?:\/\/[^\s<>"']+/gi,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const label = match[1] ?? "";
      const raw = (match[2] ?? match[0] ?? "").replace(/[),.;]+$/, "");
      if (!isAllowedOfficialUrl(raw, officialDomain)) continue;
      const ctx = `${label} ${nearby(markdown, match.index ?? 0, 70)}`;
      if (!APPLICATION_HINT.test(ctx) && !/\b(?:domanda|apply|sportello)\b/i.test(raw)) {
        continue;
      }
      return raw;
    }
  }
  return null;
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
  if (!looksLikeOpportunity(input.markdown)) return null;
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
