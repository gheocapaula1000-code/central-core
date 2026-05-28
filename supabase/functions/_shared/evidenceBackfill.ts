// _shared/evidenceBackfill.ts
// Lifts pre-existing normalised source rows into civiko_evidence so the
// opportunity engine has something to consume. Pure data mapping — never
// fabricates rows, never touches person-level data, never bypasses
// compliance_visibility defaults.

import { buildEvidenceRow, type EvidenceInput, type EvidenceRow, upsertEvidenceRows } from "./evidenceLedger.ts";
import { microzoneKey, comuneKey } from "./entityKey.ts";

export interface BackfillRowsCounts {
  area_opportunity_scores: number;
  normalized_opportunities: number;
  early_warning_opportunities: number;
  offmarket_opportunity_scores: number;
  deal_listings: number;
  deal_auctions: number;
  total: number;
  by_source_code: Record<string, number>;
}

// ─── attribution helpers ─────────────────────────────────────────────────
/** Map a coarse `data_basis` token to the registry F-code. */
export function sourceCodeFromDataBasis(basis: string | null | undefined): string {
  const s = String(basis ?? "").toLowerCase();
  if (s.includes("omi")) return "F1";
  if (s.includes("istat")) return "F2";
  if (s.includes("anac") || s.includes("pnrr") || s.includes("opencup")) return "F11";
  if (s.includes("osm") || s.includes("overpass")) return "F5";
  if (s.includes("arpav")) return "F7";
  if (s.includes("aste") || s.includes("auction")) return "F16";
  if (s.includes("portal") || s.includes("immobiliare") || s.includes("idealista") || s.includes("casa.it")) return "F13";
  // unknown → conservative weak source so it cannot alone drive a strong score
  return "F5";
}

export function sourceCodeFromPrimarySignal(signal: string | null | undefined, fallback = "F13"): string {
  const s = String(signal ?? "").toLowerCase();
  if (s.includes("asta") || s.includes("auction")) return "F16";
  if (s.includes("pnrr") || s.includes("cantiere_pubblico") || s.includes("public_work")) return "F11";
  if (s.includes("cantiere")) return "F5";
  if (s.includes("ape")) return "F17";
  if (s.includes("sue") || s.includes("permit")) return "F18";
  if (s.includes("istat") || s.includes("demograf")) return "F2";
  if (s.includes("omi")) return "F1";
  return fallback;
}

function clampConfidence(q: string | null | undefined): "low" | "medium" | "high" {
  const s = String(q ?? "").toLowerCase();
  if (s === "alta" || s === "high" || s === "completa") return "high";
  if (s === "media" || s === "medium" || s === "parziale") return "medium";
  return "low";
}

// ─── shape-agnostic row builders (no DB access) ──────────────────────────
export interface AreaScoreRow {
  province: string | null;
  municipality: string;
  microzone: string | null;
  score: number | null;
  data_basis: string | null;
  quality: string | null;
  components?: unknown;
}

export function mapAreaScore(row: AreaScoreRow): EvidenceInput | null {
  if (!row.municipality) return null;
  const code = sourceCodeFromDataBasis(row.data_basis);
  const key = row.microzone
    ? microzoneKey({ comune: row.municipality, microzona: row.microzone })
    : comuneKey({ comune: row.municipality });
  return {
    entity_type: row.microzone ? "microzone" : "comune",
    entity_key: key,
    source_code: code,
    evidence_type: "area_opportunity_score",
    evidence_value: {
      score: row.score,
      data_basis: row.data_basis,
      quality: row.quality,
      // intentionally NOT including raw components (may contain heavy nested data)
    },
    confidence: clampConfidence(row.quality),
    freshness_days: null,
    explanation: `Area score ${row.score ?? "?"} from ${row.data_basis ?? "mixed"} for ${row.municipality}${row.microzone ? ` / ${row.microzone}` : ""}`,
  };
}

export interface NormalizedOppRow {
  municipality: string | null;
  microzone: string | null;
  source_name: string | null;
  category: string | null;
  title: string;
  freshness_days?: number | null;
  priority_score?: number | null;
}

export function mapNormalizedOpportunity(row: NormalizedOppRow): EvidenceInput | null {
  if (!row.municipality) return null;
  const code = sourceCodeFromPrimarySignal(row.category ?? row.source_name ?? "", "F13");
  const key = row.microzone
    ? microzoneKey({ comune: row.municipality, microzona: row.microzone })
    : comuneKey({ comune: row.municipality });
  return {
    entity_type: row.microzone ? "microzone" : "comune",
    entity_key: key,
    source_code: code,
    evidence_type: row.category ?? "portal_listing",
    evidence_value: {
      title: row.title,
      source_name: row.source_name,
      priority_score: row.priority_score ?? null,
    },
    confidence: typeof row.priority_score === "number" && row.priority_score >= 70 ? "medium" : "low",
    freshness_days: typeof row.freshness_days === "number" ? row.freshness_days : null,
    explanation: `Portal/territory signal "${row.title}" from ${row.source_name ?? "unknown"}`,
  };
}

export interface EarlyWarningRow {
  comune: string;
  microzona: string | null;
  primary_signal_type: string;
  early_acquisition_score: number | null;
  confidence: string | null;
  explanation: string | null;
}

export function mapEarlyWarning(row: EarlyWarningRow): EvidenceInput | null {
  if (!row.comune) return null;
  const code = sourceCodeFromPrimarySignal(row.primary_signal_type, "F13");
  const key = row.microzona
    ? microzoneKey({ comune: row.comune, microzona: row.microzona })
    : comuneKey({ comune: row.comune });
  return {
    entity_type: row.microzona ? "microzone" : "comune",
    entity_key: key,
    source_code: code,
    evidence_type: row.primary_signal_type ?? "early_warning",
    evidence_value: {
      early_acquisition_score: row.early_acquisition_score,
    },
    confidence: clampConfidence(row.confidence),
    freshness_days: null,
    explanation: row.explanation ?? `Early warning: ${row.primary_signal_type}`,
  };
}

export interface OffmarketRow {
  comune: string;
  area_label: string;
  area_type: string;
  off_market_potential_score: number | null;
  confidence_score: number | null;
  quality: string | null;
}

export function mapOffmarket(row: OffmarketRow): EvidenceInput | null {
  if (!row.comune) return null;
  const isMicro = row.area_type === "microzone" || row.area_type === "microzona";
  const key = isMicro
    ? microzoneKey({ comune: row.comune, microzona: row.area_label })
    : comuneKey({ comune: row.comune });
  // composite off-market score — attribute to F1 (official_market composite)
  return {
    entity_type: isMicro ? "microzone" : "comune",
    entity_key: key,
    source_code: "F1",
    evidence_type: "offmarket_potential",
    evidence_value: {
      off_market_potential_score: row.off_market_potential_score,
      confidence_score: row.confidence_score,
      quality: row.quality,
    },
    confidence: clampConfidence(row.quality),
    freshness_days: null,
    explanation: `Off-market composite score ${row.off_market_potential_score ?? "?"} for ${row.comune}${isMicro ? ` / ${row.area_label}` : ""}`,
  };
}

// ─── deal-level mappers (op:<comune>:<id> / auct:<comune>:<fp>) ─────────
const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface NormalizedDealRow {
  id: string;
  municipality: string | null;
  microzone: string | null;
  source_name: string | null;
  category: string | null;
  title: string | null;
  source_url: string | null;
  ask_price: number | null;
  surface_mq: number | null;
  address_text: string | null;
  freshness_days?: number | null;
  priority_score?: number | null;
  last_seen_at?: string | null;
}

/** Promote a normalized_opportunity row into a DEAL-LEVEL evidence row.
 *  Returns null when no actionable target (url + id) exists. */
export function mapDealFromNormalized(row: NormalizedDealRow, sourceCode = "F13"): EvidenceInput | null {
  if (!row.municipality || !row.id) return null;
  if (!row.source_url && !row.address_text) return null;
  const comune = slug(row.municipality);
  const key = `op:${comune}:${row.id}`;
  const conf: "low" | "medium" | "high" =
    typeof row.priority_score === "number" && row.priority_score >= 70 ? "medium" : "low";
  return {
    entity_type: "opportunity",
    entity_key: key,
    source_code: sourceCode,
    evidence_type: "deal_listing",
    evidence_value: {
      listing_id: row.id,
      title: row.title ?? null,
      listing_url: row.source_url ?? null,
      address: row.address_text ?? null,
      ask_price: row.ask_price ?? null,
      surface_mq: row.surface_mq ?? null,
      microzone: row.microzone ?? null,
      municipality: row.municipality,
      source_name: row.source_name ?? null,
      last_seen_at: row.last_seen_at ?? null,
    },
    confidence: conf,
    freshness_days: typeof row.freshness_days === "number" ? row.freshness_days : null,
    raw_ref_id: row.id,
    explanation: `Annuncio "${row.title ?? row.id}" da ${row.source_name ?? "portale"}`,
  };
}

export interface AuctionDealRow {
  fingerprint: string;
  municipality: string | null;
  province: string | null;
  source_url: string | null;
  source_name: string | null;
  base_price_eur: number | null;
  minimum_offer_eur: number | null;
  sale_date: string | null;
  status: string | null;
  quality: string | null;
  is_active?: boolean;
}

export function mapDealFromAuction(row: AuctionDealRow): EvidenceInput | null {
  if (!row.municipality || !row.fingerprint) return null;
  if (!row.source_url) return null;
  const comune = slug(row.municipality);
  const key = `auct:${comune}:${row.fingerprint}`;
  return {
    entity_type: "opportunity",
    entity_key: key,
    source_code: "F16",
    evidence_type: "deal_auction",
    evidence_value: {
      auction_id: row.fingerprint,
      listing_url: row.source_url,
      base_price_eur: row.base_price_eur,
      minimum_offer_eur: row.minimum_offer_eur,
      sale_date: row.sale_date,
      status: row.status,
      municipality: row.municipality,
      source_name: row.source_name ?? null,
      title: `Asta ${row.fingerprint}`,
    },
    confidence: clampConfidence(row.quality),
    raw_ref_id: row.fingerprint,
    explanation: `Asta PVP ${row.fingerprint} in ${row.municipality}${row.sale_date ? ` (${row.sale_date})` : ""}`,
  };
}

// ─── runner ──────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
type Sb = any;

async function fetchAll(supabase: Sb, table: string, cols: string, pageSize = 1000): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    if (out.length > 50_000) break; // safety
  }
  return out;
}

export async function backfillEvidence(supabase: Sb, opts: { dry_run?: boolean } = {}): Promise<BackfillRowsCounts> {
  const buckets: Record<string, EvidenceRow[]> = {};

  function push(input: EvidenceInput | null) {
    if (!input) return;
    const row = buildEvidenceRow(input);
    const arr = buckets[row.source_code] ?? [];
    arr.push(row);
    buckets[row.source_code] = arr;
  }

  const counts: BackfillRowsCounts = {
    area_opportunity_scores: 0,
    normalized_opportunities: 0,
    early_warning_opportunities: 0,
    offmarket_opportunity_scores: 0,
    deal_listings: 0,
    deal_auctions: 0,
    total: 0,
    by_source_code: {},
  };

  for (const r of (await fetchAll(supabase, "area_opportunity_scores", "province,municipality,microzone,score,data_basis,quality")) as AreaScoreRow[]) {
    const before = Object.values(buckets).reduce((a, b) => a + b.length, 0);
    push(mapAreaScore(r));
    counts.area_opportunity_scores += Object.values(buckets).reduce((a, b) => a + b.length, 0) - before;
  }
  for (const r of (await fetchAll(supabase, "normalized_opportunities", "municipality,microzone,source_name,category,title,freshness_days,priority_score")) as NormalizedOppRow[]) {
    const before = Object.values(buckets).reduce((a, b) => a + b.length, 0);
    push(mapNormalizedOpportunity(r));
    counts.normalized_opportunities += Object.values(buckets).reduce((a, b) => a + b.length, 0) - before;
  }
  for (const r of (await fetchAll(supabase, "early_warning_opportunities", "comune,microzona,primary_signal_type,early_acquisition_score,confidence,explanation")) as EarlyWarningRow[]) {
    const before = Object.values(buckets).reduce((a, b) => a + b.length, 0);
    push(mapEarlyWarning(r));
    counts.early_warning_opportunities += Object.values(buckets).reduce((a, b) => a + b.length, 0) - before;
  }
  for (const r of (await fetchAll(supabase, "offmarket_opportunity_scores", "comune,area_label,area_type,off_market_potential_score,confidence_score,quality")) as OffmarketRow[]) {
    const before = Object.values(buckets).reduce((a, b) => a + b.length, 0);
    push(mapOffmarket(r));
    counts.offmarket_opportunity_scores += Object.values(buckets).reduce((a, b) => a + b.length, 0) - before;
  }

  for (const [code, rows] of Object.entries(buckets)) {
    counts.by_source_code[code] = rows.length;
    counts.total += rows.length;
  }

  if (opts.dry_run) return counts;

  // Insert in chunks
  for (const rows of Object.values(buckets)) {
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      const { error } = await supabase.from("civiko_evidence").insert(slice);
      if (error) throw error;
    }
  }
  return counts;
}
