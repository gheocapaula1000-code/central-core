// _shared/commercialZoneMapping.ts
// Deterministic mapping from a record (with optional slug, OMI code, lat/lng,
// alias text) to one of the 8 official Padova commercial zones.
//
// NEVER invents. NEVER falls back to "Padova". NEVER uses simple municipality
// membership. Uses only the shared PadovaOmiResolver + the active rows of
// public.civiko_commercial_zones passed in by the caller.
//
// Order of resolution (per spec):
//   a. existing commercial_zone_slug on the row, only if in the 8 valid slugs
//   b. existing OMI code on the row, mapped exclusively via civiko_commercial_zones (attiva=true)
//   c. valid lat/lng → PIP (via resolvePadovaOmiBatch, batched by the caller)
//   d. only if no valid coords → official aliases in the resolver, confidence >= 0.70
//   → otherwise unresolved (slug=null, method="unresolved", confidence=null)

import {
  resolvePadovaOmiSync,
  resolvePadovaOmiBatch,
  UNRESOLVED_OMI_CODE,
  type PadovaOmiResolution,
} from "./padovaOmiResolver.ts";

export const VALID_COMMERCIAL_ZONE_SLUGS = [
  "arcella",
  "centro-storico",
  "ovest-sacra-famiglia-chiesanuova",
  "portello-stazione-stanga",
  "san-carlo-san-bellino",
  "sant-osvaldo-facciolati",
  "sud-voltabarozzo-guizza",
  "torre-ponte-brenta-camin",
] as const;

export type CommercialZoneSlug = typeof VALID_COMMERCIAL_ZONE_SLUGS[number];
const VALID_SET: ReadonlySet<string> = new Set(VALID_COMMERCIAL_ZONE_SLUGS);

export function isValidCommercialZoneSlug(s: unknown): s is CommercialZoneSlug {
  return typeof s === "string" && VALID_SET.has(s);
}

export type ActiveZoneRow = { slug: string; omi_codes: string[] };

/** Build OMI code (uppercase) → slug map from active rows only, keeping
 *  exclusively the 8 valid slugs. */
export function buildOmiToSlugMap(rows: ActiveZoneRow[]): Map<string, CommercialZoneSlug> {
  const m = new Map<string, CommercialZoneSlug>();
  const ambiguous = new Set<string>();
  for (const r of rows) {
    if (!isValidCommercialZoneSlug(r.slug)) continue;
    for (const c of r.omi_codes ?? []) {
      if (typeof c !== "string") continue;
      const code = c.trim().toUpperCase();
      if (!code) continue;
      if (ambiguous.has(code)) continue;
      const prev = m.get(code);
      if (prev && prev !== r.slug) {
        // Same OMI code claimed by more than one active commercial zone:
        // deterministic contract requires exactly one match, so drop it.
        m.delete(code);
        ambiguous.add(code);
        continue;
      }
      if (!prev) m.set(code, r.slug);
    }
  }
  return m;
}

export type ZoneAssignment = {
  commercial_zone_slug: CommercialZoneSlug | null;
  zone_match_method: string; // "existing_slug" | "existing_omi" | "point_in_polygon" | "precomputed_omi" | "alias_match" | "unresolved"
  zone_match_confidence: number | null;
};

const UNRESOLVED: ZoneAssignment = {
  commercial_zone_slug: null,
  zone_match_method: "unresolved",
  zone_match_confidence: null,
};

/** True iff lat/lng are numbers, finite and not both 0. */
export function hasValidCoords(lat: unknown, lng: unknown): boolean {
  const la = Number(lat);
  const lo = Number(lng);
  return Number.isFinite(la) && Number.isFinite(lo) && (la !== 0 || lo !== 0);
}

/** Strong-method OMI reasons that can drive a commercial-zone assignment. */
const STRONG_OMI_REASONS: ReadonlySet<string> = new Set([
  "precomputed_omi",
  "point_in_polygon",
  "alias_match",
]);

/** Map a PadovaOmiResolution + the OMI→slug map into a ZoneAssignment.
 *  CAP hints (confidence 0.40) and salvage never assign a slug. */
export function assignFromResolution(
  res: PadovaOmiResolution | null | undefined,
  omiToSlug: Map<string, CommercialZoneSlug>,
): ZoneAssignment {
  if (!res || !res.omi_zone_code || res.omi_zone_code === UNRESOLVED_OMI_CODE) return UNRESOLVED;
  if (!STRONG_OMI_REASONS.has(res.omi_zone_reason)) return UNRESOLVED;
  if (typeof res.omi_zone_confidence !== "number" || res.omi_zone_confidence < 0.70) return UNRESOLVED;
  const slug = omiToSlug.get(res.omi_zone_code.trim().toUpperCase());
  if (!slug) return UNRESOLVED;
  return {
    commercial_zone_slug: slug,
    zone_match_method: res.omi_zone_reason,
    zone_match_confidence: res.omi_zone_confidence,
  };
}

/** Rule (a) + (b) synchronous fast path. Returns null when caller should
 *  proceed to coords/alias resolution. */
export function tryExistingSlugOrOmi(
  record: Record<string, unknown>,
  omiToSlug: Map<string, CommercialZoneSlug>,
): ZoneAssignment | null {
  const existingSlug = record["commercial_zone_slug"];
  if (typeof existingSlug === "string" && isValidCommercialZoneSlug(existingSlug)) {
    return {
      commercial_zone_slug: existingSlug,
      zone_match_method: "existing_slug",
      zone_match_confidence: 0.99,
    };
  }
  const existingOmi = record["omi_zone_code"] ?? record["omi_zone"] ?? record["codice_omi"];
  if (typeof existingOmi === "string" && existingOmi.trim()) {
    const code = existingOmi.trim().toUpperCase();
    const slug = omiToSlug.get(code);
    if (slug) {
      return {
        commercial_zone_slug: slug,
        zone_match_method: "existing_omi",
        zone_match_confidence: 0.95,
      };
    }
  }
  return null;
}

/** Alias-only path (rule d): use ONLY when no valid coordinates exist. */
export function assignFromAliasOnly(
  record: Record<string, unknown>,
  omiToSlug: Map<string, CommercialZoneSlug>,
): ZoneAssignment {
  const sync = resolvePadovaOmiSync(record);
  // Only alias_match / precomputed_omi with confidence >= 0.70 count here.
  return assignFromResolution(sync, omiToSlug);
}

/** Batched assigner: resolves each record following rules a → b → c/d.
 *  Uses a single PIP RPC call for all records with valid coordinates. */
export async function assignCommercialZonesBatch(
  records: Array<Record<string, unknown>>,
  omiToSlug: Map<string, CommercialZoneSlug>,
  supa: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } | null,
): Promise<ZoneAssignment[]> {
  const out: ZoneAssignment[] = new Array(records.length);
  const pipRecords: Array<Record<string, unknown>> = [];
  const pipIdx: number[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? {};
    // a + b
    const fast = tryExistingSlugOrOmi(r, omiToSlug);
    if (fast) { out[i] = fast; continue; }
    // c: valid coords → PIP branch (batched)
    if (hasValidCoords(r["lat"], r["lng"])) {
      pipRecords.push(r);
      pipIdx.push(i);
      out[i] = UNRESOLVED; // provisional
      continue;
    }
    // d: alias only (no coords)
    out[i] = assignFromAliasOnly(r, omiToSlug);
  }

  if (pipRecords.length > 0) {
    const resolutions = await resolvePadovaOmiBatch(pipRecords, supa);
    for (let k = 0; k < resolutions.length; k++) {
      const target = pipIdx[k];
      const res = resolutions[k];
      // Only accept PIP or precomputed here. If PIP failed and the resolver
      // fell back to alias/CAP salvage while coords existed, we treat as
      // unresolved (spec: alias only when no coords).
      if (res && (res.omi_zone_reason === "point_in_polygon" || res.omi_zone_reason === "precomputed_omi")) {
        out[target] = assignFromResolution(res, omiToSlug);
      } else {
        out[target] = UNRESOLVED;
      }
    }
  }

  return out;
}
