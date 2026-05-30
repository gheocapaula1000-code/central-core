// _shared/opportunityClassification.ts
// Classifies an entity (and its evidence group) into:
//   - area_insight       (comune / microzone / omi_zone / cap)
//   - commercial_action  (derived suggestion attached to an area)
//   - deal_opportunity   (listing / auction / property / address / lead)
//
// HARD RULES enforced here:
//   - entity_key prefixes `c:` and `mz:` are ALWAYS area_insight, never deals.
//   - A deal_opportunity requires an actionable target (url/ref/address) AND
//     evidence from a deal-eligible market source (F13/F16/F21 by default).
//   - F19/F22 alone (aggregate-only / sensitive) cannot drive a deal.

import type { EvidenceRow } from "./evidenceLedger.ts";

export type InsightType = "area_insight" | "commercial_action" | "deal_opportunity";
export type EntityGranularity =
  | "comune" | "microzone" | "omi_zone" | "cap"
  | "address" | "listing" | "auction" | "property" | "lead";

/** Market sources whose evidence may carry an actionable deal target. */
export const DEAL_ELIGIBLE_SOURCES = new Set(["F5", "F11", "F13", "F14", "F15", "F16", "F18", "F21"]);

/** Sensitive/aggregate sources that can never drive a deal alone. */
export const DEAL_FORBIDDEN_SOLO_SOURCES = new Set(["F19", "F22"]);

export interface ActionableTarget {
  ok: boolean;
  target_type?: "listing" | "auction" | "property" | "address" | "lead";
  target_ref?: string;
  target_url?: string;
  address?: string;
  title?: string;
}

export interface EntityClassification {
  insight_type: InsightType;
  entity_granularity: EntityGranularity;
}

/** Pure key-based classification. Does not look at evidence content. */
export function classifyEntityKey(entity_key: string): EntityClassification {
  const key = String(entity_key ?? "");
  if (key.startsWith("c:"))    return { insight_type: "area_insight",     entity_granularity: "comune" };
  if (key.startsWith("mz:"))   return { insight_type: "area_insight",     entity_granularity: "microzone" };
  if (key.startsWith("area:")) return { insight_type: "area_insight",     entity_granularity: "omi_zone" };
  if (key.startsWith("cap:"))  return { insight_type: "area_insight",     entity_granularity: "cap" };
  if (key.startsWith("p:"))    return { insight_type: "deal_opportunity", entity_granularity: "property" };
  if (key.startsWith("op:"))   return { insight_type: "deal_opportunity", entity_granularity: "listing" };
  if (key.startsWith("auct:")) return { insight_type: "deal_opportunity", entity_granularity: "auction" };
  if (key.startsWith("addr:")) return { insight_type: "deal_opportunity", entity_granularity: "address" };
  if (key.startsWith("lead:")) return { insight_type: "deal_opportunity", entity_granularity: "lead" };
  // unknown prefix → conservative: treat as area (won't appear as a deal)
  return { insight_type: "area_insight", entity_granularity: "comune" };
}

/**
 * Probe an evidence group for an actionable target carried by a deal-eligible
 * source. Returns ok=false when no listing url / auction id / property ref is
 * present.
 */
export function extractActionableTarget(group: EvidenceRow[], entity_key = ""): ActionableTarget {
  const key = String(entity_key ?? "");
  for (const r of group) {
    if (!DEAL_ELIGIBLE_SOURCES.has(r.source_code)) continue;
    const v = evidenceValueAsRecord(r.evidence_value);
    const url = pickStr(v, ["target_url", "listing_url", "url", "source_url", "auction_url", "link", "annuncio_url", "asset_url"]);
    const ref = pickStr(v, ["target_ref", "raw_ref_id", "id", "auction_id", "listing_id", "property_ref", "asset_id", "pvp_id"])
      ?? (typeof r.raw_ref_id === "string" && r.raw_ref_id.trim() ? r.raw_ref_id.trim() : null);
    const addr = pickStr(v, ["address", "indirizzo", "via"]);
    const title = pickStr(v, ["title", "name"]);
    // ACTIONABLE = url OR ref OR address. Title alone is NOT actionable
    // (a deal card without a link/ref/address would dead-end the agent).
    if (url || ref || addr) {
      const target_type: ActionableTarget["target_type"] =
        key.startsWith("op:") ? "listing"
        : key.startsWith("auct:") ? "auction"
        : r.source_code === "F16" ? "auction"
        : r.source_code === "F18" ? "property"
        : "listing";
      return {
        ok: true,
        target_type,
        target_url: url ?? undefined,
        target_ref: ref ?? undefined,
        address: addr ?? undefined,
        title: title ?? undefined,
      };
    }
  }

  // Segnali offmarket/legali: target ref è l'entity_key stesso,
  // source_url preso dall'evidence_value
  let bestUrl: string | null = null;
  let bestRef: string | null = null;
  let bestTitle: string | null = null;
  let bestAddress: string | null = null;
  let bestType: ActionableTarget["target_type"] | null = null;
  if (!bestUrl && !bestRef) {
    for (const r of group) {
      const v = r.evidence_value as Record<string, unknown> | null;
      if (!v) continue;
      const u = (v as any).source_url ?? (v as any).listing_url ?? null;
      const ref = (v as any).fingerprint ?? (v as any).dedupe_key ?? entity_key;
      const title = (v as any).title ?? (v as any).area_label ?? null;
      const addr = (v as any).area_label ?? (v as any).area_or_microzone ?? null;
      if (ref) {
        bestRef = typeof ref === "string" ? ref : entity_key;
        bestUrl = typeof u === "string" ? u : null;
        bestTitle = typeof title === "string" ? title : null;
        bestAddress = typeof addr === "string" ? addr : null;
        bestType = "listing";
        break;
      }
    }
  }
  if (bestRef || bestUrl) {
    return {
      ok: true,
      target_type: bestType ?? "listing",
      target_url: bestUrl ?? undefined,
      target_ref: bestRef ?? undefined,
      address: bestAddress ?? undefined,
      title: bestTitle ?? undefined,
    };
  }
  return { ok: false };
}

function evidenceValueAsRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Derive commercial actions from an area insight (microzone / comune). */
export function deriveCommercialActions(
  entity_key: string,
  granularity: EntityGranularity,
  group: EvidenceRow[],
): { action_code: string; label: string; rationale: string }[] {
  const codes = new Set(group.map((r) => r.source_code));
  const actions: { action_code: string; label: string; rationale: string }[] = [];

  if (granularity === "microzone") {
    actions.push({
      action_code: "presidia_microzona",
      label: "Presidia questa microzona",
      rationale: `Segnali multipli (${[...codes].join(", ")}) indicano potenziale operativo.`,
    });
  }
  if (codes.has("F1") || codes.has("F12")) {
    actions.push({
      action_code: "verifica_sotto_benchmark",
      label: "Verifica immobili sotto benchmark OMI",
      rationale: "Disponibili valori OMI di riferimento per confronto prezzi.",
    });
  }
  if (codes.has("F16")) {
    actions.push({
      action_code: "monitora_aste",
      label: "Monitora aste in zona",
      rationale: "Aste PVP rilevate nell'area operativa.",
    });
  }
  if (codes.has("F2") || codes.has("F20")) {
    actions.push({
      action_code: "campagna_proprietari",
      label: "Prepara campagna proprietari",
      rationale: "Profilo demografico favorevole a turnover proprietà.",
    });
  }
  return actions;
}
