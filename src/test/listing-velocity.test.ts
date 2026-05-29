// Tests for listing-velocity distress computation + idempotent evidence rows.
// Pure-logic: no DB, no Deno.

import { describe, it, expect } from "vitest";
import {
  aggregateSnapshots,
  buildListingEvidence,
  computeListingDistress,
  sourceCodeForListing,
  type SnapshotRow,
} from "../../supabase/functions/_shared/listingVelocity.ts";
import { buildEvidenceRow } from "../../supabase/functions/_shared/evidenceLedger.ts";

function snap(over: Partial<SnapshotRow>): SnapshotRow {
  return {
    listing_id: "casa-1",
    identity_hash: "h1",
    source: "casa.it",
    url: "https://casa.it/x",
    price_eur: null,
    municipality: "Padova",
    province: "PD",
    property_type: "appartamento",
    raw_title: "Trilocale",
    raw_address: "Via Test 1",
    surface_sqm: 80,
    rooms: 3,
    captured_at: null,
    first_seen_at: null,
    ...over,
  };
}

describe("computeListingDistress", () => {
  const now = new Date("2026-05-29T00:00:00Z");

  it("3 declining snapshots over 120 days → alta, 2 ribassi, ribasso_pct correct", () => {
    const snaps = [
      snap({ price_eur: 200_000, captured_at: "2026-01-29T00:00:00Z", first_seen_at: "2026-01-29T00:00:00Z" }),
      snap({ price_eur: 190_000, captured_at: "2026-03-30T00:00:00Z", first_seen_at: "2026-01-29T00:00:00Z" }),
      snap({ price_eur: 176_000, captured_at: "2026-05-28T00:00:00Z", first_seen_at: "2026-01-29T00:00:00Z" }),
    ];
    const m = computeListingDistress(snaps, now)!;
    expect(m.confidenza).toBe("alta");
    expect(m.numero_ribassi).toBe(2);
    expect(m.giorni_online).toBe(120);
    expect(m.prezzo_iniziale).toBe(200_000);
    expect(m.prezzo_corrente).toBe(176_000);
    expect(m.ribasso_pct).toBeCloseTo(0.12, 2);
    expect(m.ribasso_forte).toBe(true);
    expect(m.fermo).toBe(true);
    expect(m.distress_strength).toBe("forte");
    expect(m.price_gap_label).toMatch(/−12% da gennaio 2026/);
    expect(m.explanation_bullets.length).toBeGreaterThan(0);
  });

  it("single snapshot → bassa, no ribasso, only giorni_online", () => {
    const m = computeListingDistress([
      snap({ price_eur: 250_000, captured_at: "2026-05-15T00:00:00Z", first_seen_at: "2026-05-15T00:00:00Z" }),
    ], now)!;
    expect(m.confidenza).toBe("bassa");
    expect(m.ribasso_pct).toBeNull();
    expect(m.numero_ribassi).toBe(0);
    expect(m.giorni_online).toBe(14);
    expect(m.ribasso).toBe(false);
  });

  it("two distinct first_seen days → ripubblicato=true → distress_strength=forte", () => {
    const m = computeListingDistress([
      snap({ price_eur: 200_000, captured_at: "2026-02-01T00:00:00Z", first_seen_at: "2026-02-01T00:00:00Z" }),
      snap({ price_eur: 200_000, captured_at: "2026-05-01T00:00:00Z", first_seen_at: "2026-04-15T00:00:00Z" }),
    ], now)!;
    expect(m.ripubblicato).toBe(true);
    expect(m.distress_strength).toBe("forte");
  });
});

describe("buildListingEvidence + idempotency", () => {
  const now = new Date("2026-05-29T00:00:00Z");
  const snaps = [
    snap({ listing_id: "casa-42", price_eur: 200_000, captured_at: "2026-01-29T00:00:00Z", first_seen_at: "2026-01-29T00:00:00Z" }),
    snap({ listing_id: "casa-42", price_eur: 190_000, captured_at: "2026-03-30T00:00:00Z", first_seen_at: "2026-01-29T00:00:00Z" }),
    snap({ listing_id: "casa-42", price_eur: 176_000, captured_at: "2026-05-28T00:00:00Z", first_seen_at: "2026-01-29T00:00:00Z" }),
  ];

  it("writes exactly two rows on the same entity_key op:padova:casa-42", () => {
    const aggs = aggregateSnapshots(snaps);
    const agg = [...aggs.values()][0];
    const m = computeListingDistress(agg.snapshots, now)!;
    const inputs = buildListingEvidence(agg, m);
    expect(inputs).toHaveLength(2);
    expect(inputs.every((r) => r.entity_key === "op:padova:casa-42")).toBe(true);
    expect(inputs.map((r) => r.evidence_type).sort()).toEqual(["deal_listing", "listing_velocity"]);
    const vel = inputs.find((r) => r.evidence_type === "listing_velocity")!;
    const vv = vel.evidence_value as Record<string, unknown>;
    expect(vv.distress_strength).toBe("forte");
    expect(vv.ask_price).toBe(176_000);
    expect(vv.price_gap_label).toMatch(/−12%/);
    expect(vv.urgency_hint).toBe("high");
    const deal = inputs.find((r) => r.evidence_type === "deal_listing")!;
    expect((deal.evidence_value as Record<string, unknown>).ask_price).toBe(176_000);
  });

  it("re-running yields rows with the same conflict key (upsert-safe, no duplicates)", () => {
    const aggs = aggregateSnapshots(snaps);
    const agg = [...aggs.values()][0];
    const m = computeListingDistress(agg.snapshots, now)!;
    const first = buildListingEvidence(agg, m).map(buildEvidenceRow);
    const second = buildListingEvidence(agg, m).map(buildEvidenceRow);
    const ck = (r: typeof first[number]) => `${r.entity_type}|${r.entity_key}|${r.source_code}|${r.evidence_type}`;
    expect(first.map(ck).sort()).toEqual(second.map(ck).sort());
    // unique conflict keys across the two rows of the same listing
    expect(new Set(first.map(ck)).size).toBe(2);
  });

  it("sourceCodeForListing maps idealista→F21, others→F13", () => {
    expect(sourceCodeForListing("idealista.it")).toBe("F21");
    expect(sourceCodeForListing("casa.it")).toBe("F13");
    expect(sourceCodeForListing("immobiliare.it")).toBe("F13");
  });
});
