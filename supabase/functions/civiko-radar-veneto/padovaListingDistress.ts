// civiko-radar-veneto/padovaListingDistress.ts
// Nightly stage: read listing_price_snapshots for Padova, compute distress per
// listing (computeListingDistress), and upsert two evidence rows on the SAME
// entity_key "op:padova:<listing_id>" so the existing agency engine surfaces
// the listing as a deal with the new "Perché ora" bullets and price.
//
// Idempotent — uses upsertEvidenceRows (conflict key entity_type|entity_key|
// source_code|evidence_type). Re-runs update rows, never duplicate.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  aggregateSnapshots,
  buildListingEvidence,
  computeListingDistress,
  type SnapshotRow,
} from "../_shared/listingVelocity.ts";
import { buildEvidenceRow, upsertEvidenceRows, type EvidenceRow } from "../_shared/evidenceLedger.ts";

const COMUNE = "Padova";

export interface PadovaListingDistressResult {
  listings_processed: number;
  evidence_rows_upserted: number;
  fermo: number;
  molto_fermo: number;
  ribasso: number;
  ribasso_forte: number;
  ripubblicato: number;
  forte: number;
  medio: number;
  lieve: number;
  nessuno: number;
  no_distress: number;
  confidenza: Record<"alta" | "media" | "bassa", number>;
}

export async function runPadovaListingDistress(
  sb: SupabaseClient,
  opts: { dryRun?: boolean } = {},
): Promise<PadovaListingDistressResult> {
  const pageSize = 1000;
  const all: SnapshotRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("listing_price_snapshots")
      .select("listing_id, identity_hash, source, url, price_eur, municipality, province, property_type, raw_title, raw_address, surface_sqm, rooms, captured_at, first_seen_at")
      .ilike("municipality", COMUNE)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as SnapshotRow[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    if (all.length > 50_000) break; // safety
  }

  const aggs = aggregateSnapshots(all);
  const out: PadovaListingDistressResult = {
    listings_processed: 0,
    evidence_rows_upserted: 0,
    fermo: 0, molto_fermo: 0, ribasso: 0, ribasso_forte: 0, ripubblicato: 0, no_distress: 0,
    confidenza: { alta: 0, media: 0, bassa: 0 },
  };

  const evidenceRows: EvidenceRow[] = [];
  for (const agg of aggs.values()) {
    const m = computeListingDistress(agg.snapshots);
    if (!m) continue;
    out.listings_processed++;
    out.confidenza[m.confidenza] = (out.confidenza[m.confidenza] ?? 0) + 1;
    if (m.molto_fermo) out.molto_fermo++;
    else if (m.fermo) out.fermo++;
    if (m.ribasso_forte) out.ribasso_forte++;
    else if (m.ribasso) out.ribasso++;
    if (m.ripubblicato) out.ripubblicato++;
    if (m.distress_strength === "nessuno") out.no_distress++;
    for (const input of buildListingEvidence(agg, m)) {
      evidenceRows.push(buildEvidenceRow(input));
    }
  }

  if (!opts.dryRun && evidenceRows.length > 0) {
    out.evidence_rows_upserted = await upsertEvidenceRows(sb, evidenceRows);
  }
  return out;
}
