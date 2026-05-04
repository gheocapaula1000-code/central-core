// ═══════════════════════════════════════════════════════════════
// Listing Identity — cross-portal matching helpers
// ═══════════════════════════════════════════════════════════════
//
// L'identità digitale di un annuncio è derivata da:
//   - lat/lng arrotondati a 4 decimali (~11m precisione)
//   - tipologia normalizzata (appartamento/villa/...)
//   - superficie in mq arrotondata a 5
//   - n. locali
//
// Hash: sha1(lat|lng|type|sqm_bucket|rooms)
// Se mancano lat/lng o sqm, ritorna null (no fingerprint debole).
// ═══════════════════════════════════════════════════════════════

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

export interface IdentityInput {
  lat: number | null | undefined;
  lng: number | null | undefined;
  surface_sqm: number | null | undefined;
  property_type: string | null | undefined;
  rooms?: number | null | undefined;
}

const TYPE_NORMALIZATION: Array<[RegExp, PropertyType]> = [
  [/villa\b/i, "villa"],
  [/villett/i, "villetta"],
  [/attico|penth/i, "attico"],
  [/loft/i, "loft"],
  [/rustico|casale|cascina/i, "rustico"],
  [/terren|lotto|edificabil/i, "terreno"],
  [/negozio|ufficio|capanno|magazz|commercial/i, "commerciale"],
  [/appartament|trilocal|bilocal|monolocal|quadrilocal|pentaloc|loft/i, "appartamento"],
];

export function normalizePropertyType(raw: string | null | undefined): PropertyType {
  if (!raw) return "altro";
  for (const [re, type] of TYPE_NORMALIZATION) {
    if (re.test(raw)) return type;
  }
  return "altro";
}

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeIdentityHash(input: IdentityInput): Promise<string | null> {
  if (
    typeof input.lat !== "number" || !Number.isFinite(input.lat) ||
    typeof input.lng !== "number" || !Number.isFinite(input.lng) ||
    typeof input.surface_sqm !== "number" || !Number.isFinite(input.surface_sqm) ||
    input.surface_sqm <= 0
  ) {
    return null;
  }
  const latR = input.lat.toFixed(4);
  const lngR = input.lng.toFixed(4);
  const type = normalizePropertyType(input.property_type ?? null);
  const sqmBucket = Math.round(input.surface_sqm / 5) * 5; // bucket di 5 mq
  const rooms = typeof input.rooms === "number" && Number.isFinite(input.rooms) ? Math.round(input.rooms) : 0;
  return sha1Hex(`${latR}|${lngR}|${type}|${sqmBucket}|${rooms}`);
}

export function roundCoord(v: number | null | undefined, digits = 4): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
