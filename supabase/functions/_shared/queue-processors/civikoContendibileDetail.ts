// Parser puro per le schede dettaglio dei soli candidati contendibili.
// Nessun fetch e nessun accesso DB: trasforma il risultato Firecrawl in
// evidenze verificabili, senza inventare civico o piano.

import {
  collectImageRefs,
  descriptionFingerprintInput,
  extractCivicoFromText,
  extractPianoFromText,
  extractViaFromText,
  normalizeViaKey,
} from "../unitEvidenceExtractor.ts";

export const DETAIL_EVIDENCE_VERSION = "civiko-detail-v1";

export interface ContendibileDetailContext {
  listing_id: number;
  url: string;
  commercial_zone_slug: string;
}

export interface ContendibileDetailEvidence {
  via_norm: string | null;
  civico_norm: string | null;
  piano_key: string | null;
  descr_fp_input: string | null;
  unit_ref: string | null;
  image_refs: string[];
  text_chars: number;
  version: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function addText(out: string[], value: unknown, max = 120_000): void {
  if (typeof value !== "string") return;
  const v = value.slice(0, max).trim();
  if (v) out.push(v);
}

function collectPageText(result: unknown): string {
  const root = asRecord(result) ?? {};
  const data = asRecord(root.data) ?? root;
  const metadata = asRecord(data.metadata) ?? asRecord(root.metadata) ?? {};
  const out: string[] = [];

  addText(out, metadata.title);
  addText(out, metadata.description);
  addText(out, metadata.ogTitle);
  addText(out, metadata.ogDescription);
  addText(out, data.markdown);
  addText(out, root.markdown);
  addText(out, data.html);
  addText(out, root.html);

  return stripHtml(out.join("\n")).slice(0, 180_000);
}

export function extractUnitReference(text: string): string | null {
  const match = text.match(
    /\b(?:rif(?:erimento)?|cod(?:ice)?)\s*(?:annuncio|immobile|interno|agenzia)?\s*[:#\-]?\s*([a-z0-9][a-z0-9\/_\-\.]{2,20})\b/i,
  );
  if (!match) return null;
  const ref = match[1].toLowerCase().replace(/[^a-z0-9/_-]+/g, "");
  if (ref.length < 3 || /^\d{7,}$/.test(ref)) return null;
  return ref;
}

export function parseContendibileDetail(
  result: unknown,
  context: ContendibileDetailContext,
): ContendibileDetailEvidence {
  if (!Number.isInteger(context.listing_id) || context.listing_id <= 0) {
    throw new Error("invalid_listing_id");
  }
  if (!/^https:\/\//i.test(context.url)) throw new Error("invalid_listing_url");
  if (!context.commercial_zone_slug) throw new Error("missing_commercial_zone_slug");

  const text = collectPageText(result);
  if (text.length < 120) throw new Error("detail_text_too_short");

  const viaRaw = extractViaFromText(text);
  const civico = viaRaw ? extractCivicoFromText(text) : null;
  // extractViaFromText include talvolta il civico finale nell'odonimo.
  // Lo separiamo prima della normalizzazione: evita conflitti artificiali
  // con ev_via_norm già derivato dalla card (es. tullio-lombardo vs
  // tullio-lombardo-18).
  const viaWithoutCivico = viaRaw?.replace(
    /[\s,]+\d{1,3}\s*(?:\/\s*)?[a-z]?$/i,
    "",
  ) ?? null;
  const viaNorm = normalizeViaKey(viaWithoutCivico);
  const piano = extractPianoFromText(text);
  const descrFpInput = descriptionFingerprintInput(text);

  return {
    via_norm: viaNorm,
    civico_norm: civico,
    piano_key: piano,
    descr_fp_input: descrFpInput,
    unit_ref: extractUnitReference(text),
    image_refs: collectImageRefs(result, 12),
    text_chars: text.length,
    version: DETAIL_EVIDENCE_VERSION,
  };
}
