// ═══════════════════════════════════════════════════════════════
// padovaPortalParser — funzioni PURE per trasformare un result
// Firecrawl (scrape markdown) in NormalizedListing[].
//
// VINCOLI (Fase 1A shadow mode):
// - Nessun fetch, nessun secret, nessun accesso DB.
// - Input: result Firecrawl + processor_context.
// - Output: NormalizedListing[] (max 100).
// - Portali supportati: immobiliare.it, idealista.it, casa.it, subito.it.
// - Riusa le stesse regole di parsing di portalScrapers.ts / casaParser.ts.
// - Scarta URL non http/https e annunci con address che referenzia
//   un comune diverso da Padova.
// ═══════════════════════════════════════════════════════════════

import { parseCasaListPage } from "../casaParser.ts";
import {
  normalizePropertyType,
  type PropertyType,
} from "../../civiko-radar-veneto/listingIdentity.ts";

export type PortalSource =
  | "immobiliare.it"
  | "idealista.it"
  | "casa.it"
  | "subito.it";

export interface NormalizedListing {
  source: PortalSource;
  listing_id: string;
  url: string;
  title: string;
  address: string | null;
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
}

const MAX_LISTINGS = 100;
const PRICE_NEAR_RE = /€\s*(\d{1,3}(?:\.\d{3})+|\d{4,7})(?!\d|\.\d)/;
const OTHER_COMUNI_RE =
  /\b(vicenza|verona|treviso|venezia|mestre|rovigo|belluno|milano|roma|bologna|torino|firenze)\b/i;

function parsePriceEurLocal(raw: string): number | null {
  const digits = raw.replace(/\./g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 1000 || n > 5_000_000) return null;
  return Math.round(n);
}

function isValidHttpUrl(u: string): boolean {
  if (typeof u !== "string") return false;
  return /^https?:\/\//i.test(u);
}

function isNotPadova(address: string | null): boolean {
  if (!address) return false;
  if (/padova/i.test(address)) return false;
  return OTHER_COMUNI_RE.test(address);
}

function extractMarkdown(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const md1 = typeof d.markdown === "string" ? d.markdown : "";
  const md2 = typeof r.markdown === "string" ? (r.markdown as string) : "";
  return md1 || md2 || "";
}

// ──────────────── casa.it ────────────────
function parseCasa(md: string): NormalizedListing[] {
  const parsed = parseCasaListPage(md, "https://www.casa.it/");
  const out: NormalizedListing[] = [];
  for (const p of parsed) {
    if (!isValidHttpUrl(p.source_url)) continue;
    const rawAgency = (p.agency_name ?? "").trim();
    const isPrivate = p.is_privato || /privat[oi]/i.test(rawAgency);
    const listing: NormalizedListing = {
      source: "casa.it",
      listing_id: `casa-${p.listing_id}`,
      url: p.source_url.slice(0, 400),
      title: (p.title ?? "Annuncio").slice(0, 200),
      address: p.zone ? p.zone.slice(0, 200) : null,
      price_eur: p.price_eur,
      surface_sqm: p.surface_sqm,
      rooms: p.rooms,
      property_type: normalizePropertyType(null),
      agency_name: rawAgency && !isPrivate ? rawAgency.slice(0, 150) : null,
      is_private: isPrivate,
      lat: null,
      lng: null,
    };
    if (isNotPadova(listing.address)) continue;
    out.push(listing);
    if (out.length >= MAX_LISTINGS) break;
  }
  return out;
}

// ──────────────── immobiliare.it / idealista.it ────────────────
interface Profile {
  source: PortalSource;
  linkRe: RegExp;
  urlBuilder: (id: string) => string;
  idPrefix: string;
}

const IMM_PROFILE: Profile = {
  source: "immobiliare.it",
  linkRe:
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.immobiliare\.it\/annunci\/(\d{6,})\/?[^)]*\)/g,
  urlBuilder: (id) => `https://www.immobiliare.it/annunci/${id}/`,
  idPrefix: "imm",
};

const IDL_PROFILE: Profile = {
  source: "idealista.it",
  linkRe:
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.idealista\.it\/immobile\/(\d{5,})\/?[^)]*\)/g,
  urlBuilder: (id) => `https://www.idealista.it/immobile/${id}/`,
  idPrefix: "idl",
};

function parseByProfile(md: string, profile: Profile): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const seen = new Set<string>();
  profile.linkRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = profile.linkRe.exec(md)) !== null && out.length < MAX_LISTINGS) {
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
    if (!isValidHttpUrl(url)) continue;
    seen.add(id);
    out.push({
      source: profile.source,
      listing_id: `${profile.idPrefix}-${id}`,
      url,
      title: (rawTitle || "Annuncio").slice(0, 200),
      address: null,
      price_eur: price,
      surface_sqm: null,
      rooms: null,
      property_type: normalizePropertyType(null),
      agency_name: null,
      is_private: false,
      lat: null,
      lng: null,
    });
  }
  return out;
}

// ──────────────── subito.it ────────────────
function parseSubito(md: string): NormalizedListing[] {
  const out: NormalizedListing[] = [];
  const seen = new Set<string>();
  const re =
    /(?<=^|[^!])\[([^\]\n]+?)\]\(https:\/\/www\.subito\.it\/([^)\s]*?-(\d{6,})\.htm)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null && out.length < MAX_LISTINGS) {
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
    if (!isValidHttpUrl(url)) continue;
    seen.add(id);
    out.push({
      source: "subito.it",
      listing_id: `sub-${id}`,
      url: url.slice(0, 400),
      title: (rawTitle || "Annuncio").slice(0, 200),
      address: null,
      price_eur: price,
      surface_sqm: null,
      rooms: null,
      property_type: normalizePropertyType(null),
      agency_name: null,
      is_private: true,
      lat: null,
      lng: null,
    });
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
  let listings: NormalizedListing[];
  switch (context.portal) {
    case "casa.it":
      listings = parseCasa(md);
      break;
    case "immobiliare.it":
      listings = parseByProfile(md, IMM_PROFILE);
      break;
    case "idealista.it":
      listings = parseByProfile(md, IDL_PROFILE);
      break;
    case "subito.it":
      listings = parseSubito(md);
      break;
    default:
      return [];
  }
  // Extra safety: cap + URL/comune guard applicati globalmente.
  const clean: NormalizedListing[] = [];
  for (const l of listings) {
    if (!isValidHttpUrl(l.url)) continue;
    if (isNotPadova(l.address)) continue;
    clean.push(l);
    if (clean.length >= MAX_LISTINGS) break;
  }
  return clean;
}

export const ALLOWED_PORTALS: PortalSource[] = [
  "immobiliare.it",
  "idealista.it",
  "casa.it",
  "subito.it",
];
