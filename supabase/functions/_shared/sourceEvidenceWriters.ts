// _shared/sourceEvidenceWriters.ts
// After a scheduled source endpoint completes successfully, the matching
// writer here reads the source's normalised table(s) and upserts evidence
// rows into civiko_evidence. Idempotent — relies on the unique index on
// (entity_type, entity_key, source_code, evidence_type).
//
// Only attached for F-codes with a real ingestion path but no inline
// evidence-writer step: F7, F10, F13, F16, F21.
//
// Deal-eligible writers (F13/F16/F21) emit DEAL-LEVEL keys:
//   - op:<comune>:<listing_id>     for normalized_opportunities with source_url
//   - auct:<comune>:<fingerprint>  for auction_signals
// Evidence_value carries the actionable target (url, title, price, address)
// so extractActionableTarget can promote them into deal_opportunities.
//
// - No fabricated rows.
// - No person-level data.
// - compliance_visibility from evidenceLedger defaults.

import { buildEvidenceRow, upsertEvidenceRows, type EvidenceInput } from "./evidenceLedger.ts";
import { microzoneKey, comuneKey } from "./entityKey.ts";
import {
  mapAreaScore,
  mapDealFromNormalized,
  mapDealFromAuction,
  type AreaScoreRow,
  type NormalizedDealRow,
  type AuctionDealRow,
} from "./evidenceBackfill.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

interface WriterResult {
  rows_written: number;
  reason?: string;
}

async function paged<T>(supabase: Sb, table: string, cols: string, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    if (out.length > 20_000) break;
  }
  return out;
}

function clampConfidence(q: string | null | undefined): "low" | "medium" | "high" {
  const s = String(q ?? "").toLowerCase();
  if (s === "alta" || s === "high" || s === "completa") return "high";
  if (s === "media" || s === "medium" || s === "parziale") return "medium";
  return "low";
}

// ─── F7 ARPAV (microzone_sentiment env score) ─────────────────────────
interface SentimentRow {
  comune: string; area_label: string | null; area_type: string | null;
  environment_score: number | null; air_quality_score: number | null;
  noise_score: number | null; green_score: number | null;
  quality: string | null;
}
async function writeF7(supabase: Sb): Promise<WriterResult> {
  const rows = await paged<SentimentRow>(
    supabase, "microzone_sentiment",
    "comune,area_label,area_type,environment_score,air_quality_score,noise_score,green_score,quality",
  );
  const inputs: EvidenceInput[] = [];
  for (const r of rows) {
    if (!r.comune) continue;
    if (r.environment_score == null && r.air_quality_score == null) continue;
    const isMz = (r.area_type === "microzone" || r.area_type === "microzona") && !!r.area_label;
    const key = isMz
      ? microzoneKey({ comune: r.comune, microzona: r.area_label! })
      : comuneKey({ comune: r.comune });
    inputs.push({
      entity_type: isMz ? "microzone" : "comune",
      entity_key: key,
      source_code: "F7",
      evidence_type: "environment_quality",
      evidence_value: {
        environment_score: r.environment_score,
        air_quality_score: r.air_quality_score,
        noise_score: r.noise_score,
        green_score: r.green_score,
      },
      confidence: clampConfidence(r.quality),
      explanation: `ARPAV environment score ${r.environment_score ?? "?"} for ${r.comune}${isMz ? ` / ${r.area_label}` : ""}`,
    });
  }
  return { rows_written: await upsertEvidenceRows(supabase, inputs.map(buildEvidenceRow)) };
}

// ─── Generic deal-level writer from normalized_opportunities ──────────
async function writeDealsFromNormalized(
  supabase: Sb, sourceCode: string, matchTokens: string[],
): Promise<WriterResult> {
  const rows = await paged<NormalizedDealRow>(
    supabase, "normalized_opportunities",
    "id,municipality,microzone,source_name,category,title,source_url,ask_price,surface_mq,address_text,freshness_days,priority_score,last_seen_at",
  );
  const lcTokens = matchTokens.map((t) => t.toLowerCase());
  const inputs: EvidenceInput[] = [];
  for (const r of rows) {
    const sig = `${r.source_name ?? ""} ${r.category ?? ""}`.toLowerCase();
    if (lcTokens.length > 0 && !lcTokens.some((t) => sig.includes(t))) continue;
    const mapped = mapDealFromNormalized(r, sourceCode);
    if (!mapped) continue;
    inputs.push(mapped);
  }
  return { rows_written: await upsertEvidenceRows(supabase, inputs.map(buildEvidenceRow)) };
}

// ─── F10 ANAC CKAN open-data (still area-level, no deal target) ─────
async function writeF10(supabase: Sb): Promise<WriterResult> {
  // ANAC opens are not deal-targets — keep as area-level signals only.
  return { rows_written: 0, reason: "anac_area_level_only" };
}

// ─── F13 Immobiliare portal listings ─────
const writeF13 = (s: Sb) => writeDealsFromNormalized(s, "F13", ["immobiliare", "quotation", "quotazion"]);
// ─── F21 Generic portals (idealista/casa.it/portal/ribasso/osm cantieri) ─────
const writeF21 = (s: Sb) => writeDealsFromNormalized(s, "F21", ["idealista", "casa.it", "portal", "ribasso", "ribassi", "osm"]);

// ─── F16 PVP auctions (auction_signals → auct:<comune>:<fp>) ─────
async function writeF16(supabase: Sb): Promise<WriterResult> {
  const rows = await paged<AuctionDealRow>(
    supabase, "auction_signals",
    "fingerprint,province,municipality,source_url,source_name,base_price_eur,minimum_offer_eur,sale_date,status,quality,is_active",
  );
  const inputs: EvidenceInput[] = [];
  for (const r of rows) {
    if (r.is_active === false) continue;
    const mapped = mapDealFromAuction(r);
    if (!mapped) continue;
    inputs.push(mapped);
  }
  return { rows_written: await upsertEvidenceRows(supabase, inputs.map(buildEvidenceRow)) };
}

const WRITERS: Record<string, (s: Sb) => Promise<WriterResult>> = {
  F7: writeF7,
  F10: writeF10,
  F13: writeF13,
  F16: writeF16,
  F21: writeF21,
};

export function hasEvidenceWriter(sourceCode: string): boolean {
  return Boolean(WRITERS[sourceCode]);
}

export async function runEvidenceWriter(supabase: Sb, sourceCode: string): Promise<WriterResult> {
  const fn = WRITERS[sourceCode];
  if (!fn) return { rows_written: 0, reason: "no_writer_for_source" };
  return await fn(supabase);
}

// Exposed for tests
export const __testing = { writeDealsFromNormalized, mapAreaScoreForTest: mapAreaScore };
void mapAreaScore;
export type { AreaScoreRow };
