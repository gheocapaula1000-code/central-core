// ═══════════════════════════════════════════════════════════════
// padovaPortalParser — funzioni PURE per trasformare un result
// Firecrawl (scrape markdown) in NormalizedListing[].
//
// VINCOLI (Fase 1A shadow mode):
// - Nessun fetch, nessun secret, nessun accesso DB.
// - Input: result Firecrawl + processor_context.
// - Output: NormalizedListing[] con cap per mode (soft=25, full=60).
//   Difesa in profondità: hard-cap globale 100.
// - Portali supportati: immobiliare.it, idealista.it, casa.it, subito.it.
// - Riusa le regole markdown di portalScrapers.ts / casaParser.ts:
//   estrae realmente property_type, surface_sqm, rooms, agency_name,
//   address quando presenti nella card markdown.
// - Filtro geografico Padova, dedupe per listing_id/URL.
// - Nessun dato inventato.
//
// NOTA: la logica dei tipi è funzionalmente equivalente a
// civiko-radar-veneto/listingIdentity.ts; il file è duplicato perché
// il bundler edge isola una funzione dall'altra.
// ═══════════════════════════════════════════════════════════════

import { parseCasaListPage } from "../casaParser.ts";
import {
  extractViaFromText,
  isQuartiereLabel,
  normalizePianoKey,
} from "../unitEvidenceExtractor.ts";

export type PropertyType =
  | "appartamento"
  | "villa"
  | "villetta"
  | "attico"
  | "loft"
  | "rustico"
  | "terreno"
  | "commerciale"
  | "altro";

const TYPE_NORMALIZATION: Array<[RegExp, PropertyType]> = [
  [/villett/i, "villetta"],
  [/villa\b/i, "villa"],
  [/attico|penth/i, "attico"],
  [/loft/i, "loft"],
  [/rustico|casale|cascina/i, "rustico"],
  [/terren|lotto|edificabil/i, "terreno"],
  [/negozio|ufficio|capanno|magazz|commercial/i, "commerciale"],
  [/appartament|trilocal|bilocal|monolocal|quadrilocal|pentaloc/i, "appartamento"],
];

export function normalizePropertyType(raw: string | null | undefined): PropertyType {
  if (!raw) return "altro";
  for (const [re, type] of TYPE_NORMALIZATION) {
    if (re.test(raw)) return type;
  }
  return "altro";
}

export type PortalSource =
  | "immobiliare.it"
  | "idealista.it"
  | "casa.it"
  | "subito.it"
  | "bakeca.it";

export interface NormalizedListing {
  source: PortalSource;
  listing_id: string;
  url: string;
  title: string;
  /** SOLO odonimo reale (via/piazza/corso…). Mai un quartiere. */
  address: string | null;
  /** Etichetta di zona/quartiere del portale. Non è un indirizzo. */
  quartiere?: string | null;
  /** Piano normalizzato (T/R/S/M/A/Pn) quando dimostrabile. */
  piano_key?: string | null;
  price_eur: number | null;
  surface_sqm: number | null;
  rooms: number | null;
  property_type: PropertyType;
  agency_name: string | null;
  is_private?: boolean;
  lat: number | null;
  lng: number | null;
}

export interface PortalProcessorContext {
  municipality: string;
  province: string;
  portal: PortalSource;
  mode: "soft" | "full";
  // Campi Fase 1B multipagina — opzionali per retro-compat con job Fase 1A.
  page?: number;
  max_pages?: number;
  run_date?: string;

}

const HARD_CAP = 100;
const MODE_CAPS: Record<"soft" | "full", number> = { soft: 25, full: 60 };

const PRICE_NEAR_RE = /€\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})(?!\d|\.\d)/;
// Unicode-safe: dopo "m²" \b non funziona, usiamo lookahead che rifiuta
// solo lettere/numeri/underscore Unicode.
const SQM_NEAR_RE = /(\d{2,4})\s*m(?:q|²)(?![\p{L}\p{N}_])/iu;
const ROOMS_NEAR_RE = /(\d{1,2})\s*(?:local[ei]|stanz[ei]|camer[ei])\b/i;
// La regex viene applicata su testo NFD-stripped: senza accenti.
const OTHER_COMUNI_RE =
  /\b(abano|albignasego|rubano|selvazzano|vigonza|cadoneghe|noventa padovana|ponte san nicolo|vicenza|verona|treviso|venezia|mestre|rovigo|belluno|milano|roma|bologna|torino|firenze)\b/i;
const PADOVA_BOUNDS = { minLat: 45.34, maxLat: 45.48, minLng: 11.78, maxLng: 11.98 };

function stripAccentsLower(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function parsePriceEurLocal(raw: string): number | null {
  const digits = raw.replace(/\./g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 1000 || n > 5_000_000) return null;
  return Math.round(n);
}

function parseIntSafe(raw: string, min: number, max: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}

function isValidHttpsUrl(u: string, host: string): boolean {
  if (typeof u !== "string") return false;
  const m = u.match(/^https:\/\/([^/]+)/i);
  return !!m && m[1].toLowerCase() === host;
}

function isInsidePadova(l: NormalizedListing): boolean {
  const hasReal = typeof l.lat === "number" && typeof l.lng === "number" &&
    !(Math.abs(l.lat) < 0.000001 && Math.abs(l.lng) < 0.000001);
  if (hasReal) {
    return l.lat! >= PADOVA_BOUNDS.minLat && l.lat! <= PADOVA_BOUNDS.maxLat &&
      l.lng! >= PADOVA_BOUNDS.minLng && l.lng! <= PADOVA_BOUNDS.maxLng;
  }
  const txt = stripAccentsLower(
    `${l.title ?? ""} ${l.address ?? ""} ${l.quartiere ?? ""}`,
  );
  return !OTHER_COMUNI_RE.test(txt);
}

function extractMarkdown(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const md1 = typeof d.markdown === "string" ? d.markdown : "";
  const md2 = typeof r.markdown === "string" ? (r.markdown as string) : "";
  return md1 || md2 || "";
}

function extractSurface(win: string): number | null {
  const m = win.match(SQM_NEAR_RE);
  return m ? parseIntSafe(m[1], 8, 2000) : null;
}
function extractRooms(win: string): number | null {
  const m = win.match(ROOMS_NEAR_RE);
  return m ? parseIntSafe(m[1], 1, 30) : null;
}
function extractAgency(win: string): string | null {
  // "Agenzia: Foo" / "Immobiliare Foo" / "Studio Foo"
  const m = win.match(/(?:Agenzia[:\s]+|\bImmobiliare\s+|\bStudio\s+)([A-Z][^\n|·•]{2,60})/);
  return m ? m[1].trim().slice(0, 150) : null;
}
function extractAddress(win: string): string | null {
  // Solo odonimi reali: `extractViaFromText` rifiuta le etichette di quartiere.
  const via = extractViaFromText(win.split(/\n/).slice(0, 8).join("\n"));
  return via ? via.slice(0, 200) : null;
}

// ──────────────── casa.it ────────────────
function parseCasa(md: string, cap: number): NormalizedListing[] {
  const parsed = parseCasaListPage(md, "https://www.casa.it/");
  const out: NormalizedListing[] = [];
  for (const p of parsed) {
    if (!isValidHttpsUrl(p.source_url, "www.casa.it")) continue;
    const rawAgency = (p.agency_name ?? "").trim();
    const isPrivate = p.is_privato || /privat[oi]/i.test(rawAgency);
    const typeSource = `${p.title ?? ""} ${p.description ?? ""}`;
    // `p.zone` è l'etichetta di quartiere della card: NON è un indirizzo.
    const zoneLabel = p.zone ? p.zone.trim() : null;
    // Una via si usa solo se realmente presente in titolo/descrizione.
    const via =
      extractViaFromText(p.title) ??
      extractViaFromText(p.description) ??
      (zoneLabel && !isQuartiereLabel(zoneLabel) ? extractViaFromText(zoneLabel) : null);
    const listing: NormalizedListing = {
      source: "casa.it",
      listing_id: `casa-${p.listing_id}`,
      url: p.source_url.slice(0, 400),
      title: (p.title ?? "Annuncio").slice(0, 200),
      address: via ? via.slice(0, 200) : null,
      quartiere: zoneLabel ? zoneLabel.slice(0, 200) : null,
      piano_key: normalizePianoKey(p.floor),
      price_eur: p.price_eur,
      surface_sqm: p.surface_sqm,
      rooms: p.rooms,
      property_type: normalizePropertyType(typeSource),
      agency_name: rawAgency && !isPrivate ? rawAgency.slice(0, 150) : null,
      is_private: isPrivate,
      lat: null,
      lng: null,
    };
    if (!isInsidePadova(listing)) continue;
    out.push(listing);
    if (out.length >= cap) break;
  }
  return out;
}

// ──────────────── immobiliare.it / idealista.it ────────────────
interface Profile {
  source: PortalSource;
  host: string;
  linkRe: RegExp;
  urlBuilder: (id: string) => string;
  idPrefix: string;
}

const IMM_PROFILE: Profile = {
  source: "immobiliare.it",
  host: "www.immobiliare.it",
  linkRe:
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.immobiliare\.it\/annunci\/(\d{6,})\/?[^)]*\)/g,
  urlBuilder: (id) => `https://www.immobiliare.it/annunci/${id}/`,
  idPrefix: "imm",
};

const IDL_PROFILE: Profile = {
  source: "idealista.it",
  host: "www.idealista.it",
  linkRe:
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.idealista\.it\/immobile\/(\d{5,})\/?[^)]*\)/g,
  urlBuilder: (id) => `https://www.idealista.it/immobile/${id}/`,
  idPrefix: "idl",
};

function parseByProfile(md: string, profile: Profile, cap: number): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const seen = new Set<string>();
  profile.linkRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = profile.linkRe.exec(md)) !== null && out.length < cap) {
    const rawTitle = (m[1] ?? "").trim();
    const id = (m[2] ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (/Immagine\s+\d+\s+di\s+\d+/i.test(rawTitle)) continue;
    const winStart = m.index + m[0].length;
    const win = md.slice(winStart, winStart + 600);
    const pm = win.match(PRICE_NEAR_RE);
    const price = pm ? parsePriceEurLocal(pm[1]) : null;
    if (!rawTitle && price == null) continue;
    const url = profile.urlBuilder(id);
    if (!isValidHttpsUrl(url, profile.host)) continue;
    const agency = extractAgency(win);
    const address = extractAddress(win);
    const isPrivate = /\bprivat[oi]\b/i.test(win);
    seen.add(id);
    const listing: NormalizedListing = {
      source: profile.source,
      listing_id: `${profile.idPrefix}-${id}`,
      url,
      title: (rawTitle || "Annuncio").slice(0, 200),
      address,
      price_eur: price,
      surface_sqm: extractSurface(win),
      rooms: extractRooms(win),
      property_type: normalizePropertyType(`${rawTitle} ${win.slice(0, 200)}`),
      agency_name: agency && !isPrivate ? agency : null,
      is_private: isPrivate,
      lat: null,
      lng: null,
    };
    if (!isInsidePadova(listing)) continue;
    out.push(listing);
  }
  return out;
}

// ──────────────── subito.it ────────────────
function parseSubito(md: string, cap: number): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const seen = new Set<string>();
  const re =
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.subito\.it\/([^)\s]*?-(\d{6,})\.htm)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null && out.length < cap) {
    const rawTitle = (m[1] ?? "").trim();
    const path = (m[2] ?? "").trim();
    const id = (m[3] ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (/Immagine\s+\d+\s+di\s+\d+/i.test(rawTitle)) continue;
    const winStart = m.index + m[0].length;
    const win = md.slice(winStart, winStart + 600);
    const pm = win.match(PRICE_NEAR_RE);
    const price = pm ? parsePriceEurLocal(pm[1]) : null;
    if (!rawTitle && price == null) continue;
    const url = `https://www.subito.it/${path}`;
    if (!isValidHttpsUrl(url, "www.subito.it")) continue;
    const agency = extractAgency(win);
    const isPrivate = !agency || /\bprivat[oi]\b/i.test(win);
    seen.add(id);
    const listing: NormalizedListing = {
      source: "subito.it",
      listing_id: `sub-${id}`,
      url: url.slice(0, 400),
      title: (rawTitle || "Annuncio").slice(0, 200),
      address: extractAddress(win),
      price_eur: price,
      surface_sqm: extractSurface(win),
      rooms: extractRooms(win),
      property_type: normalizePropertyType(`${rawTitle} ${win.slice(0, 200)}`),
      agency_name: agency && !isPrivate ? agency : null,
      is_private: isPrivate,
      lat: null,
      lng: null,
    };
    if (!isInsidePadova(listing)) continue;
    out.push(listing);
  }
  return out;
}

// ──────────────── bakeca.it ────────────────
function parseBakeca(md: string, cap: number): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const seen = new Set<string>();
  const re =
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.bakeca\.it\/(dettaglio\/[^)\s]*?(\d{6,})[^)\s]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null && out.length < cap) {
    const rawTitle = (m[1] ?? "").trim();
    const path = (m[2] ?? "").trim();
    const id = (m[3] ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (/Immagine\s+\d+\s+di\s+\d+/i.test(rawTitle)) continue;
    const winStart = m.index + m[0].length;
    const win = md.slice(winStart, winStart + 600);
    const pm = win.match(PRICE_NEAR_RE);
    const price = pm ? parsePriceEurLocal(pm[1]) : null;
    if (!rawTitle && price == null) continue;
    const url = `https://www.bakeca.it/${path}`;
    if (!isValidHttpsUrl(url, "www.bakeca.it")) continue;
    const agency = extractAgency(win);
    const isPrivate = !agency || /\bprivat[oi]\b/i.test(win);
    seen.add(id);
    const listing: NormalizedListing = {
      source: "bakeca.it",
      listing_id: `bkc-${id}`,
      url: url.slice(0, 400),
      title: (rawTitle || "Annuncio").slice(0, 200),
      address: extractAddress(win),
      price_eur: price,
      surface_sqm: extractSurface(win),
      rooms: extractRooms(win),
      property_type: normalizePropertyType(`${rawTitle} ${win.slice(0, 200)}`),
      agency_name: agency && !isPrivate ? agency : null,
      is_private: isPrivate,
      lat: null,
      lng: null,
    };
    if (!isInsidePadova(listing)) continue;
    out.push(listing);
  }
  return out;
}

// ──────────────── Dispatcher ────────────────
export function parseFirecrawlResult(
  result: unknown,
  context: PortalProcessorContext,
): NormalizedListing[] {
  const md = extractMarkdown(result);
  if (!md) return [];
  const cap = Math.min(HARD_CAP, MODE_CAPS[context.mode] ?? MODE_CAPS.soft);
  let listings: NormalizedListing[];
  switch (context.portal) {
    case "casa.it":
      listings = parseCasa(md, cap); break;
    case "immobiliare.it":
      listings = parseByProfile(md, IMM_PROFILE, cap); break;
    case "idealista.it":
      listings = parseByProfile(md, IDL_PROFILE, cap); break;
    case "subito.it":
      listings = parseSubito(md, cap); break;
    case "bakeca.it":
      listings = parseBakeca(md, cap); break;
    default:
      return [];
  }
  // Dedupe finale per listing_id
  const seen = new Set<string>();
  const clean: NormalizedListing[] = [];
  for (const l of listings) {
    if (seen.has(l.listing_id)) continue;
    seen.add(l.listing_id);
    clean.push(l);
    if (clean.length >= cap) break;
  }
  return clean;
}

export const ALLOWED_PORTALS: PortalSource[] = [
  "immobiliare.it",
  "idealista.it",
  "casa.it",
  "subito.it",
  "bakeca.it",
];
