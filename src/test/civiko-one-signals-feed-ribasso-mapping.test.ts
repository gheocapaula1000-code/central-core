// Pure static test for the ribasso mapping produced by
// supabase/functions/civiko-one-signals-feed/index.ts (ramo RPC).
// Nessuna rete, nessun import di edge function Deno.
// Il helper `buildItem` sotto replica ESATTAMENTE la validazione
// dei nuovi campi additive in index.ts (observations_count, first_seen_at)
// e viene invocato con la stessa forma di partial usata nel ramo RPC.
import { describe, it, expect } from "vitest";

type SignalType = "contendibile" | "multi_portale" | "ribasso" | "privato" | "off_market";

interface FeedItem {
  source_id: string;
  signal_type: SignalType;
  title: string;
  city: string;
  province: string;
  zone_code: string;
  zone_label: string;
  display_zone: string;
  price: number | null;
  price_label: string;
  url: string;
  status: string;
  score: number;
  last_seen_at: string;
  raw_ref: string;
  data_quality: { score: number; flags: string[]; needs_review: boolean };
  lat: number | null;
  lng: number | null;
  ribasso_pct?: number;
  initial_price_eur?: number;
  current_price_eur?: number;
  drops_count?: number;
  observations_count?: number;
  first_seen_at?: string;
  commercial_zone_slug?: string;
  omi_zone_code?: string;
}

// Replica FEDELE dei blocchi di validazione additivi in buildItem (index.ts).
function buildItemMirror(partial: Partial<FeedItem> & {
  signal_type: SignalType;
  source_id: string;
  price_raw?: unknown;
}): FeedItem {
  const item: FeedItem = {
    source_id: partial.source_id,
    signal_type: partial.signal_type,
    title: partial.title || "(senza titolo)",
    city: partial.city || "Padova",
    province: partial.province || "PD",
    zone_code: partial.zone_code || "OMI_UNRESOLVED",
    zone_label: partial.zone_label || "Zona non risolta",
    display_zone: partial.display_zone || "Zona non risolta",
    price: typeof partial.price_raw === "number" ? partial.price_raw : null,
    price_label: "",
    url: partial.url || "",
    status: partial.status || "active",
    score: partial.score ?? 0,
    last_seen_at: partial.last_seen_at || new Date().toISOString(),
    raw_ref: partial.raw_ref || "",
    data_quality: { score: 100, flags: [], needs_review: false },
    lat: null,
    lng: null,
  };
  if (typeof partial.ribasso_pct === "number") item.ribasso_pct = partial.ribasso_pct;
  if (typeof partial.initial_price_eur === "number") item.initial_price_eur = partial.initial_price_eur;
  if (typeof partial.current_price_eur === "number") item.current_price_eur = partial.current_price_eur;
  if (typeof partial.drops_count === "number") item.drops_count = partial.drops_count;
  if (
    typeof partial.observations_count === "number" &&
    Number.isFinite(partial.observations_count) &&
    Number.isInteger(partial.observations_count) &&
    partial.observations_count >= 0
  ) {
    item.observations_count = partial.observations_count;
  }
  if (typeof partial.first_seen_at === "string" && partial.first_seen_at.trim() !== "") {
    const t = Date.parse(partial.first_seen_at);
    if (Number.isFinite(t)) item.first_seen_at = partial.first_seen_at;
  }
  if (partial.commercial_zone_slug) item.commercial_zone_slug = partial.commercial_zone_slug;
  if (partial.omi_zone_code) item.omi_zone_code = partial.omi_zone_code;
  return item;
}

// Replica ESATTA del mapping RPC → buildItem del ramo ribassi in index.ts.
function mapRpcRowToItem(row: Record<string, unknown>): FeedItem {
  const initial = Number(row.initial_price_eur);
  const current = Number(row.current_price_eur);
  const dropPct = Number(row.total_drop_pct);
  const url = String(row.url ?? "");
  const omiCode = (row.omi_zone as string) || "";
  const slug = (row.commercial_zone_slug as string) || undefined;
  const title = (row.title as string) || `Ribasso ${row.listing_id ?? ""}`;
  return buildItemMirror({
    source_id: `drop:${row.source_id ?? row.listing_id ?? url}`,
    signal_type: "ribasso",
    title: `${title} — ribasso ${dropPct}%`,
    city: "Padova",
    province: "PD",
    zone_code: omiCode || "OMI_UNRESOLVED",
    zone_label: omiCode || "Zona non risolta",
    display_zone: omiCode || "Zona non risolta",
    price_raw: current,
    url,
    status: "active",
    score: 80,
    last_seen_at: row.last_seen_at as string,
    raw_ref: `listing_price_snapshots:${row.source_id ?? ""}`,
    ribasso_pct: Math.round(dropPct * 10) / 10,
    initial_price_eur: initial,
    current_price_eur: current,
    drops_count: Number(row.drops_count) || 0,
    observations_count: Number.isFinite(Number(row.observations_count))
      ? Number(row.observations_count)
      : undefined,
    first_seen_at: typeof row.first_seen_at === "string" ? row.first_seen_at : undefined,
    commercial_zone_slug: slug,
    omi_zone_code: omiCode || undefined,
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
  it("preserves observations_count and first_seen_at at the ROOT of the item", () => {
    const item = mapRpcRowToItem(validRow) as unknown as Record<string, unknown>;
    expect(item.observations_count).toBe(10);
    expect(item.first_seen_at).toBe("2026-06-01T10:00:00.000Z");
    expect(Object.prototype.hasOwnProperty.call(item, "observations_count")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(item, "first_seen_at")).toBe(true);
    expect(item.raw_payload).toBeUndefined();
  });

  it("keeps drops_count distinct from observations_count", () => {
    const item = mapRpcRowToItem(validRow);
    expect(item.drops_count).toBe(2);
    expect(item.observations_count).toBe(10);
    expect(item.drops_count).not.toBe(item.observations_count);
  });

  it("preserves all other ribasso fields unchanged", () => {
    const item = mapRpcRowToItem(validRow);
    expect(item.last_seen_at).toBe(validRow.last_seen_at);
    expect(item.initial_price_eur).toBe(200000);
    expect(item.current_price_eur).toBe(180000);
    expect(item.ribasso_pct).toBe(10);
    expect(item.commercial_zone_slug).toBe("arcella");
    expect(item.url).toBe(validRow.url);
    expect(item.omi_zone_code).toBe("D3");
  });

  it("does NOT invent observations_count when missing/invalid", () => {
    expect(mapRpcRowToItem({ ...validRow, observations_count: undefined }).observations_count).toBeUndefined();
    expect(mapRpcRowToItem({ ...validRow, observations_count: -1 }).observations_count).toBeUndefined();
    expect(mapRpcRowToItem({ ...validRow, observations_count: 3.5 }).observations_count).toBeUndefined();
    expect(mapRpcRowToItem({ ...validRow, observations_count: null }).observations_count).toBeUndefined();
  });

  it("does NOT substitute first_seen_at with last_seen_at when missing/invalid", () => {
    expect(mapRpcRowToItem({ ...validRow, first_seen_at: undefined }).first_seen_at).toBeUndefined();
    expect(mapRpcRowToItem({ ...validRow, first_seen_at: "not-a-date" }).first_seen_at).toBeUndefined();
    expect(mapRpcRowToItem({ ...validRow, first_seen_at: "" }).first_seen_at).toBeUndefined();
    expect(mapRpcRowToItem({ ...validRow, first_seen_at: 12345 }).first_seen_at).toBeUndefined();
  });
});
