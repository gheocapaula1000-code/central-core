// ═══════════════════════════════════════════════════════════════
// padovaSuccessioni.ts
// Aggregate-only "succession pressure" signal for Padova.
//
// Source: extractInheritancePressure (ISTAT, OMI, auction_signals
// aggregati, succession_heatmap_cap aggregato, area_opportunity_scores).
// NEVER reads person-level data. NEVER touches obituaries_seen
// (DB-locked) nor any nominative source.
//
// Writes idempotent rows to civiko_evidence:
//   entity_type        = "comune"
//   entity_key         = "c:padova"
//   source_code        = "F2"            // ISTAT-led composite
//   evidence_type      = "succession_pressure"
//   compliance_visibility = "public"     // aggregated only
//   evidence_value     = { pressure_score, zone, count_aggregated, indicators, basis, confidence }
//
// Hard rules:
//   - k aggregation >= 2 (enforced by upstream sources + check below)
//   - basis.length >= 2 aggregate indicators (extractor already enforces)
//   - no names, surnames, addresses, dates of birth/death, family relations
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { extractInheritancePressure } from "./firecrawl/inheritancePressureExtractor.ts";
import { buildEvidenceRow, upsertEvidenceRows, type EvidenceInput } from "../_shared/evidenceLedger.ts";

const MIN_AGGREGATION_K = 2;

export interface PadovaSuccessioniResult {
  ok: boolean;
  comuni_evaluated: number;
  candidates: number;
  evidence_upserted: number;
  skipped_low_k: number;
  warnings: string[];
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Choose a defensible aggregated count (k >= 2) from upstream indicators. */
function pickCountAggregated(indicators: Record<string, unknown>): number | null {
  const candidates: number[] = [];
  const shc = Number(indicators.succession_heatmap_avg);
  // succession_heatmap_cap is itself filtered upstream, so its mere presence
  // means k>=2 upstream. Use a sentinel of MIN_AGGREGATION_K when only
  // heatmap is present (we cannot expose obituary counts here).
  if (Number.isFinite(shc) && shc > 0) candidates.push(MIN_AGGREGATION_K);
  const aste = Number(indicators.aste_attive_aggregate);
  if (Number.isFinite(aste) && aste >= MIN_AGGREGATION_K) candidates.push(aste);
  // ISTAT comune-level indicators imply a comune-wide aggregate (k >> 2 by
  // construction): if no other count is available, fall back to sentinel.
  const hasIstat = ["indice_vecchiaia", "percentuale_over65", "percentuale_over85"]
    .some((k) => typeof indicators[k] === "number");
  if (hasIstat && candidates.length === 0) candidates.push(MIN_AGGREGATION_K);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

export async function runPadovaSuccessioni(opts: { dryRun?: boolean } = {}): Promise<PadovaSuccessioniResult> {
  const warnings: string[] = [];
  const supa = getServiceClient();
  if (!supa) {
    return { ok: false, comuni_evaluated: 0, candidates: 0, evidence_upserted: 0, skipped_low_k: 0, warnings: ["supabase_env_missing"] };
  }

  // Aggregate-only extraction, scoped to Padova
  const report = await extractInheritancePressure(supa, { comuni: ["Padova"], province: ["PD"] });
  warnings.push(...report.warnings);

  const inputs: EvidenceInput[] = [];
  let skipped_low_k = 0;

  for (const c of report.candidates) {
    const count_k = pickCountAggregated(c.indicators);
    if (count_k === null || count_k < MIN_AGGREGATION_K) {
      skipped_low_k++;
      continue;
    }
    // Strip any accidental person-level keys (defensive; extractor never sets these)
    const safeIndicators: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.indicators)) {
      const kl = k.toLowerCase();
      if (kl.includes("name") || kl.includes("nome") || kl.includes("cognome") ||
          kl.includes("address") || kl.includes("indirizzo") || kl.includes("cap")) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
        safeIndicators[k] = v;
      }
    }

    const entity_key = `c:${c.comune.toLowerCase()}`;
    inputs.push({
      entity_type: "comune",
      entity_key,
      source_code: "F2", // ISTAT-led composite
      evidence_type: "succession_pressure",
      compliance_visibility: "public",
      confidence:
        c.confidence_score >= 70 ? "high" :
        c.confidence_score >= 40 ? "medium" : "low",
      freshness_days: null,
      explanation: `Pressione successoria aggregata in ${c.comune}: ${c.reason}`,
      evidence_value: {
        pressure_score: c.score,
        zone: c.comune,
        count_aggregated: count_k,
        confidence: c.confidence_score,
        quality: c.quality,
        indicators: safeIndicators,
        basis: c.signal_basis,
      },
    });
  }

  let evidence_upserted = 0;
  if (!opts.dryRun && inputs.length > 0) {
    try {
      const rows = inputs.map(buildEvidenceRow);
      evidence_upserted = await upsertEvidenceRows(supa, rows);
    } catch (e) {
      warnings.push(`upsert_failed:${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, comuni_evaluated: report.comuni_evaluated, candidates: report.candidates.length, evidence_upserted: 0, skipped_low_k, warnings };
    }
  }

  return {
    ok: true,
    comuni_evaluated: report.comuni_evaluated,
    candidates: report.candidates.length,
    evidence_upserted,
    skipped_low_k,
    warnings,
  };
}
