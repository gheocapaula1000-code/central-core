// _shared/dealZoneScope.ts
// Pure helpers for classifying DEAL-LEVEL evidence rows (op:/auct:/p:/addr:/lead:)
// against an agency's operating scope (comuni + microzones).
//
// Why this exists:
//   The legacy scope matcher only validated that `parts[1]` (the comune
//   segment) belonged to the agency's comuni. That meant a Padova-wide
//   listing with no microzone hint was either lost as `outside_scope` (when
//   the matcher was strict) or incorrectly surfaced as an Arcella deal (when
//   it was permissive). Neither is acceptable.
//
// HARD RULES enforced here:
//   - Deal rows OUTSIDE the agency's comuni are flagged `outside_comune`.
//   - When the agency scope is microzone-specific, a deal row must carry an
//     explicit microzone signal (key segment, evidence_value.microzone,
//     mapped address/title keyword) to be considered `inside_agency_zone`.
//   - No fake assignment: when the microzone cannot be confidently inferred,
//     the row is `inside_comune_unmapped` — NOT surfaced as a deal AND NOT
//     dropped as outside_scope.

import type { EvidenceRow } from "./evidenceLedger.ts";

export type DealZoneStatus =
  | "outside_comune"
  | "comune_scope_only"
  | "inside_agency_zone"
  | "zone_mismatch"
  | "inside_comune_unmapped";

export interface DealScope {
  comuni: Set<string>;     // normalized lowercase
  microzones: Set<string>; // normalized lowercase slugs/labels
  /** Comuni whose scope covers the FULL canonical zone set (e.g. all Padova).
   *  When set, deal rows inside the comune without a microzone hint are
   *  treated as `comune_scope_only` instead of `inside_comune_unmapped`. */
  fullComune?: Set<string>;
}

export interface DealZoneClassification {
  status: DealZoneStatus;
  matched_zone: string | null;
  confidence: "high" | "medium" | "low" | null;
  method: "key_segment" | "evidence_field" | "address_keyword" | null;
}

const DEAL_PREFIXES = ["op:", "auct:", "p:", "addr:", "lead:"];
export function isDealKey(entity_key: string): boolean {
  return DEAL_PREFIXES.some((p) => entity_key.startsWith(p));
}

const norm = (s: unknown): string =>
  String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Comune-specific zone keyword maps. ONLY add entries the project explicitly
// approved — this is metadata, not fabricated geo data. All target slugs MUST
// already exist as recognised agency microzone slugs.
const ZONE_KEYWORDS: Record<string, Record<string, string[]>> = {
  padova: {
    arcella: [
      "arcella",
      "san carlo",
      "san bellino",
      "ss. trinità",
      "ss trinita",
      "santissima trinita",
      "pontevigodarzere",
      "tiziano aspetti",
      "via aspetti",
      "guido reni",
      "via reni",
      "via curzola",
    ],
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function evValRec(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? p as Record<string, unknown> : {};
    } catch { /* ignore */ }
  }
  return {};
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export interface InferredZone {
  slug: string;
  confidence: "high" | "medium" | "low";
  method: "key_segment" | "evidence_field" | "address_keyword";
}

/** Infer a microzone slug for a deal row. Returns null when no confident hint. */
export function inferDealZoneSlug(
  entity_key: string,
  group: EvidenceRow[],
  comune_seg: string,
): InferredZone | null {
  const parts = entity_key.split(":");
  // 1) Embedded slug in the key (op:<comune>:<slug>:<id-or-rest>)
  if (parts.length >= 4 && parts[2]) {
    const seg = norm(parts[2]);
    if (seg && !UUID_RE.test(seg) && /[a-z]/.test(seg)) {
      return { slug: seg, confidence: "high", method: "key_segment" };
    }
  }
  // 2) Explicit microzone / quartiere / zone_slug in evidence_value.
  for (const r of group) {
    const v = evValRec(r.evidence_value);
    const mz = pickStr(v, ["microzone", "microzona", "quartiere", "zone_slug", "area_label"]);
    if (mz) return { slug: norm(mz), confidence: "high", method: "evidence_field" };
  }
  // 3) Comune-specific address/title keyword mapping (low confidence).
  const kwMap = ZONE_KEYWORDS[comune_seg];
  if (kwMap) {
    const combined = group
      .map((r) => {
        const v = evValRec(r.evidence_value);
        return [v.address, v.indirizzo, v.via, v.title, v.area_name, v.headline]
          .filter((x) => typeof x === "string")
          .join(" ");
      })
      .join(" ")
      .toLowerCase();
    if (combined.trim()) {
      for (const [slug, keywords] of Object.entries(kwMap)) {
        if (keywords.some((kw) => combined.includes(kw))) {
          return { slug, confidence: "low", method: "address_keyword" };
        }
      }
    }
  }
  return null;
}

export function classifyDealZoneScope(
  entity_key: string,
  group: EvidenceRow[],
  scope: DealScope,
): DealZoneClassification {
  const parts = entity_key.split(":");
  const comune_seg = norm(parts[1] ?? "");
  if (!comune_seg || !scope.comuni.has(comune_seg)) {
    return { status: "outside_comune", matched_zone: null, confidence: null, method: null };
  }
  if (scope.microzones.size === 0 || scope.fullComune?.has(comune_seg)) {
    // Full-comune scope: any deal inside the comune is eligible, with or
    // without a microzone hint. If we have an inferred zone, surface it as
    // metadata; otherwise proceed as comune_scope_only.
    const inferred = inferDealZoneSlug(entity_key, group, comune_seg);
    if (inferred && scope.microzones.has(inferred.slug)) {
      return {
        status: "inside_agency_zone",
        matched_zone: inferred.slug,
        confidence: inferred.confidence,
        method: inferred.method,
      };
    }
    return { status: "comune_scope_only", matched_zone: inferred?.slug ?? null, confidence: inferred?.confidence ?? null, method: inferred?.method ?? null };
  }
  const inferred = inferDealZoneSlug(entity_key, group, comune_seg);
  if (!inferred) {
    return { status: "inside_comune_unmapped", matched_zone: null, confidence: null, method: null };
  }
  if (scope.microzones.has(inferred.slug)) {
    return {
      status: "inside_agency_zone",
      matched_zone: inferred.slug,
      confidence: inferred.confidence,
      method: inferred.method,
    };
  }
  return {
    status: "zone_mismatch",
    matched_zone: inferred.slug,
    confidence: inferred.confidence,
    method: inferred.method,
  };
}
