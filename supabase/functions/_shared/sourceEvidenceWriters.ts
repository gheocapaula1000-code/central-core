// _shared/sourceEvidenceWriters.ts
// After a scheduled source endpoint completes successfully, the matching
// writer here reads the source's normalised table(s) and upserts evidence
// rows into civiko_evidence. Idempotent — relies on the unique index on
// (entity_type, entity_key, source_code, evidence_type).
//
// Only attached for the F-codes that already have a real ingestion path
// but no inline evidence-writer step: F7, F10, F13, F16, F21.
//
// - No fabricated rows.
// - No person-level data.
// - compliance_visibility from evidenceLedger defaults.

import { buildEvidenceRow, upsertEvidenceRows, type EvidenceInput } from "./evidenceLedger.ts";
import { microzoneKey, comuneKey } from "./entityKey.ts";
import {
  mapAreaScore, mapNormalizedOpportunity,
  type AreaScoreRow, type NormalizedOppRow,
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

// ─── Generic portal/normalized_opportunities filtered by source token ──
async function writeFromNormalized(
  supabase: Sb, sourceCode: string, matchTokens: string[],
): Promise<WriterResult> {
  const rows = await paged<NormalizedOppRow & { source_name: string | null; category: string | null }>(
    supabase, "normalized_opportunities",
    "municipality,microzone,source_name,category,title,freshness_days,priority_score",
  );
  const lcTokens = matchTokens.map((t) => t.toLowerCase());
  const inputs: EvidenceInput[] = [];
  for (const r of rows) {
    const sig = `${r.source_name ?? ""} ${r.category ?? ""}`.toLowerCase();
    if (!lcTokens.some((t) => sig.includes(t))) continue;
    const mapped = mapNormalizedOpportunity(r);
    if (!mapped) continue;
    // Force source_code attribution to the scheduled F-code
    mapped.source_code = sourceCode;
    inputs.push(mapped);
  }
  return { rows_written: await upsertEvidenceRows(supabase, inputs.map(buildEvidenceRow)) };
}

// ─── F10 ANAC CKAN open-data ─────
const writeF10 = (s: Sb) => writeFromNormalized(s, "F10", ["anac", "ckan", "opencup"]);
// ─── F13 Immobiliare quotations (derived) ─────
const writeF13 = (s: Sb) => writeFromNormalized(s, "F13", ["immobiliare", "quotation", "quotazion"]);
// ─── F21 Portals (idealista/casa.it/immobiliare listings + ribassi) ─────
const writeF21 = (s: Sb) => writeFromNormalized(s, "F21", ["idealista", "casa.it", "portal", "ribasso", "ribassi"]);

// ─── F16 PVP auctions (auction_signals) ─────
interface AuctionRow {
  fingerprint: string; province: string | null; municipality: string | null;
  base_price_eur: number | null; minimum_offer_eur: number | null;
  sale_date: string | null; status: string | null; quality: string | null;
}
async function writeF16(supabase: Sb): Promise<WriterResult> {
  const rows = await paged<AuctionRow>(
    supabase, "auction_signals",
    "fingerprint,province,municipality,base_price_eur,minimum_offer_eur,sale_date,status,quality,is_active",
  );
  const inputs: EvidenceInput[] = [];
  for (const r of rows as Array<AuctionRow & { is_active?: boolean }>) {
    if (r.is_active === false) continue;
    if (!r.municipality) continue;
    inputs.push({
      entity_type: "comune",
      entity_key: comuneKey({ comune: r.municipality }),
      source_code: "F16",
      evidence_type: `auction:${r.fingerprint}`,
      evidence_value: {
        base_price_eur: r.base_price_eur,
        minimum_offer_eur: r.minimum_offer_eur,
        sale_date: r.sale_date,
        status: r.status,
      },
      confidence: clampConfidence(r.quality),
      explanation: `PVP auction ${r.fingerprint} in ${r.municipality}`,
    });
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
export const __testing = { writeFromNormalized, mapAreaScoreForTest: mapAreaScore };
// suppress unused import warnings for re-exports used by tests
void mapAreaScore;
export type { AreaScoreRow };
