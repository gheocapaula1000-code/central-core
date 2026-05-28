// _shared/entityKey.ts
// Normalised matching keys for cross-source entity resolution.
// Used by the evidence ledger so signals from different sources can be
// joined on the same (area / microzone / property) without person-level data.

export interface EntityKeyParts {
  comune?: string | null;
  cap?: string | null;
  microzona?: string | null;
  omi_zone?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  property_type?: string | null;
  time_window?: string | null; // e.g. "2026-Q1"
}

const norm = (v: unknown): string =>
  String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Strip diacritics + punctuation for stable address matching (no PII stored, just hash input). */
function normalizeAddress(a: string | null | undefined): string {
  if (!a) return "";
  return String(a)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s,/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundCoord(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "";
  return Number(n).toFixed(digits);
}

export function areaKey(parts: EntityKeyParts): string {
  return [
    "area",
    norm(parts.comune),
    norm(parts.cap),
    norm(parts.microzona) || norm(parts.omi_zone),
  ].filter(Boolean).join(":");
}

export function microzoneKey(parts: EntityKeyParts): string {
  return ["mz", norm(parts.comune), norm(parts.microzona) || norm(parts.omi_zone)]
    .filter(Boolean).join(":");
}

export function comuneKey(parts: EntityKeyParts): string {
  return ["c", norm(parts.comune)].filter(Boolean).join(":");
}

export function propertyKey(parts: EntityKeyParts): string {
  const addr = normalizeAddress(parts.address);
  const coord = roundCoord(parts.lat) + "," + roundCoord(parts.lng);
  return [
    "p",
    norm(parts.comune),
    addr,
    coord,
    norm(parts.property_type),
  ].filter(Boolean).join(":");
}

export function opportunityKey(parts: EntityKeyParts & { primary_signal?: string }): string {
  return [
    "op",
    norm(parts.comune),
    norm(parts.microzona) || norm(parts.omi_zone),
    norm(parts.primary_signal),
    norm(parts.time_window),
  ].filter(Boolean).join(":");
}
