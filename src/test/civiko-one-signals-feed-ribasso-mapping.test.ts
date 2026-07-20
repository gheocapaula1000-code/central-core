import { describe, it, expect } from "vitest";
import { buildItem } from "../../supabase/functions/civiko-one-signals-feed/index.ts";

// Simulate the exact mapping used inside the RPC ribassi branch
function mapRpcRowToItem(row: Record<string, unknown>) {
  return buildItem({
    source_id: `drop:${row.source_id ?? row.listing_id ?? row.url}`,
    signal_type: "ribasso",
    title: `${row.title ?? "Ribasso"} — ribasso ${row.total_drop_pct}%`,
    city: "Padova",
    province: "PD",
    zone_code: (row.omi_zone as string) || "OMI_UNRESOLVED",
    zone_label: (row.omi_zone as string) || "Zona non risolta",
    display_zone: (row.omi_zone as string) || "Zona non risolta",
    price_raw: row.current_price_eur,
    url: row.url as string,
    status: "active",
    score: 80,
    last_seen_at: row.last_seen_at as string,
    raw_ref: `listing_price_snapshots:${row.source_id ?? ""}`,
    ribasso_pct: Number(row.total_drop_pct),
    initial_price_eur: Number(row.initial_price_eur),
    current_price_eur: Number(row.current_price_eur),
    drops_count: Number(row.drops_count) || 0,
    observations_count: Number.isFinite(Number(row.observations_count))
      ? Number(row.observations_count)
      : undefined,
    first_seen_at: typeof row.first_seen_at === "string" ? row.first_seen_at : undefined,
    commercial_zone_slug: (row.commercial_zone_slug as string) || undefined,
    omi_zone_code: (row.omi_zone as string) || undefined,
  });
}

const validRow = {
  source_id: "casa.it::listing::casa-1",
  listing_id: "casa-1",
  url: "https://www.casa.it/annunci/1",
  title: "Trilocale Padova",
  omi_zone: "D3",
  commercial_zone_slug: "arcella",
  initial_price_eur: 200000,
  current_price_eur: 180000,
  total_drop_pct: 10,
  drops_count: 2,
  observations_count: 10,
  first_seen_at: "2026-06-01T10:00:00.000Z",
  last_seen_at: "2026-07-18T12:00:00.000Z",
};

describe("civiko-one-signals-feed — ribasso RPC → feed mapping", () => {
  it("preserves observations_count and first_seen_at at the item root", () => {
    const item = mapRpcRowToItem(validRow);
    expect(item.observations_count).toBe(10);
    expect(item.first_seen_at).toBe("2026-06-01T10:00:00.000Z");
    // At root, not nested
    expect(Object.prototype.hasOwnProperty.call(item, "observations_count")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(item, "first_seen_at")).toBe(true);
    // No raw_payload leak
    expect((item as Record<string, unknown>).raw_payload).toBeUndefined();
  });

  it("keeps drops_count distinct from observations_count", () => {
    const item = mapRpcRowToItem(validRow);
    expect(item.drops_count).toBe(2);
    expect(item.observations_count).toBe(10);
    expect(item.drops_count).not.toBe(item.observations_count);
  });

  it("preserves the other ribasso fields unchanged", () => {
    const item = mapRpcRowToItem(validRow);
    expect(item.last_seen_at).toBe(validRow.last_seen_at);
    expect(item.initial_price_eur).toBe(200000);
    expect(item.current_price_eur).toBe(180000);
    expect(item.ribasso_pct).toBe(10);
    expect(item.commercial_zone_slug).toBe("arcella");
    expect(item.url).toBe(validRow.url);
  });

  it("does not invent observations_count when missing/invalid", () => {
    const bad1 = mapRpcRowToItem({ ...validRow, observations_count: undefined });
    expect(bad1.observations_count).toBeUndefined();
    const bad2 = mapRpcRowToItem({ ...validRow, observations_count: -1 });
    expect(bad2.observations_count).toBeUndefined();
    const bad3 = mapRpcRowToItem({ ...validRow, observations_count: 3.5 });
    expect(bad3.observations_count).toBeUndefined();
    const bad4 = mapRpcRowToItem({ ...validRow, observations_count: "10" });
    // string input becomes NaN via the not-a-number check on typeof
    expect(bad4.observations_count).toBeUndefined();
  });

  it("does not substitute first_seen_at with last_seen_at when missing/invalid", () => {
    const bad1 = mapRpcRowToItem({ ...validRow, first_seen_at: undefined });
    expect(bad1.first_seen_at).toBeUndefined();
    const bad2 = mapRpcRowToItem({ ...validRow, first_seen_at: "not-a-date" });
    expect(bad2.first_seen_at).toBeUndefined();
    const bad3 = mapRpcRowToItem({ ...validRow, first_seen_at: "" });
    expect(bad3.first_seen_at).toBeUndefined();
  });
});
