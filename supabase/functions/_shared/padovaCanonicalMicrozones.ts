import { CANONICAL_COMUNE_MICROZONES } from "./comuneRegistry.ts";

const norm = (s: unknown): string =>
  String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const CANONICAL_PADOVA = new Set((CANONICAL_COMUNE_MICROZONES.padova ?? []).map(norm));

// Bridge from official OMI polygon codes to the Core canonical Padova slugs.
// Only canonical slugs from CANONICAL_COMUNE_MICROZONES.padova are emitted.
const OMI_TO_CANONICAL_PADOVA: Record<string, string> = {
  B1: "centro storico",
  B2: "prato della valle",
  C1: "arcella",
  C2: "stazione",
  C3: "mortise",
  C4: "mortise",
  C5: "sant'osvaldo",
  C6: "sacra famiglia",
  D1: "chiesanuova",
  D2: "mandria",
  D3: "voltabarozzo",
  D4: "camin",
  D5: "arcella",
  D6: "pontevigodarzere",
  D7: "mortise",
  D8: "forcellini",
  E1: "camin",
  E2: "camin",
  E3: "voltabarozzo",
  R1: "pontevigodarzere",
  R2: "mandria",
  R3: "voltabarozzo",
};

export interface PadovaMicrozoneResolution {
  slug: string;
  omi_zone: string;
  omi_zone_descr: string | null;
}

export function normalizePadovaCanonicalMicrozone(value: unknown): string | null {
  const slug = norm(value);
  return CANONICAL_PADOVA.has(slug) ? slug : null;
}

export function canonicalPadovaSlugFromOmiZone(omiZone: unknown): string | null {
  const code = String(omiZone ?? "").trim().toUpperCase();
  const slug = OMI_TO_CANONICAL_PADOVA[code];
  return normalizePadovaCanonicalMicrozone(slug);
}

function hasUsablePadovaCoordinate(lat: unknown, lng: unknown): lat is number {
  return typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001 &&
    lat >= 45.33 && lat <= 45.47 && lng >= 11.77 && lng <= 11.98;
}

// deno-lint-ignore no-explicit-any
export async function resolvePadovaCanonicalMicrozoneByPoint(sb: any, lat: unknown, lng: unknown): Promise<PadovaMicrozoneResolution | null> {
  if (!hasUsablePadovaCoordinate(lat, lng)) return null;
  const { data, error } = await sb.rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });
  if (error) return null;
  const first = Array.isArray(data) ? data[0] : null;
  const slug = canonicalPadovaSlugFromOmiZone(first?.zona);
  if (!slug) return null;
  return {
    slug,
    omi_zone: String(first.zona).trim().toUpperCase(),
    omi_zone_descr: typeof first.zona_descr === "string" ? first.zona_descr : null,
  };
}