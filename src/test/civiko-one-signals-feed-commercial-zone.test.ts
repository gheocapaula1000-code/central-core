// Pure static test for commercial_zone_slug propagation in
// civiko-one-signals-feed. No network, no Deno imports.
//
// Replica FEDELE della logica di propagazione finale in index.ts:
//   1) buildItem accetta commercial_zone_slug SOLO se ∈ 8 slug ufficiali.
//   2) Il pass finale mappa zone_code (OMI) → slug via civiko_commercial_zones
//      attive; non tocca item con slug già valido; rimuove slug non ufficiali.
//   3) Non deriva mai da quartiere/zona/CAP/indirizzo/testo.
import { describe, it, expect } from "vitest";
import {
  VALID_COMMERCIAL_ZONE_SLUGS,
  isValidCommercialZoneSlug,
  buildOmiToSlugMap,
  type ActiveZoneRow,
} from "../../supabase/functions/_shared/commercialZoneMapping.ts";

type SignalType = "contendibile" | "multi_portale" | "ribasso" | "privato" | "off_market";

interface FeedItem {
  source_id: string;
  signal_type: SignalType;
  title: string;
  zone_code: string;
  zone_label: string;
  display_zone: string;
  commercial_zone_slug?: string;
}

// Replica minima di buildItem: valida commercial_zone_slug al root.
function buildItem(partial: Partial<FeedItem> & { signal_type: SignalType; source_id: string }): FeedItem {
  const item: FeedItem = {
    source_id: partial.source_id,
    signal_type: partial.signal_type,
    title: partial.title || "(senza titolo)",
    zone_code: partial.zone_code || "OMI_UNRESOLVED",
    zone_label: partial.zone_label || "Zona non risolta",
    display_zone: partial.display_zone || "Zona non risolta",
  };
  if (isValidCommercialZoneSlug(partial.commercial_zone_slug)) {
    item.commercial_zone_slug = partial.commercial_zone_slug;
  }
  return item;
}

// Replica del pass finale di propagazione.
function propagateCommercialZone(items: FeedItem[], omiToSlug: Map<string, string>) {
  for (const it of items) {
    if (isValidCommercialZoneSlug(it.commercial_zone_slug)) continue;
    if (it.commercial_zone_slug && !isValidCommercialZoneSlug(it.commercial_zone_slug)) {
      delete it.commercial_zone_slug;
    }
    const code = (it.zone_code || "").trim().toUpperCase();
    if (!code || code === "OMI_UNRESOLVED") continue;
    const slug = omiToSlug.get(code);
    if (slug) it.commercial_zone_slug = slug;
  }
}

const activeZones: ActiveZoneRow[] = [
  { slug: "arcella", omi_codes: ["D3", "D7"] },
  { slug: "centro-storico", omi_codes: ["B1"] },
  { slug: "sud-voltabarozzo-guizza", omi_codes: ["D2"] },
  { slug: "portello-stazione-stanga", omi_codes: ["D8"] },
];
const omiToSlug = buildOmiToSlugMap(activeZones);

describe("civiko-one-signals-feed — commercial_zone_slug propagation", () => {
  it("propagates slug at ROOT for privato when zone_code maps to an official slug", () => {
    const it = buildItem({ source_id: "pdv:1", signal_type: "privato", zone_code: "D3" });
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("arcella");
    expect(Object.prototype.hasOwnProperty.call(it, "commercial_zone_slug")).toBe(true);
  });

  it("propagates slug at ROOT for contendibile", () => {
    const it = buildItem({ source_id: "cont:9", signal_type: "contendibile", zone_code: "B1" });
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("centro-storico");
  });

  it("propagates slug at ROOT for off_market", () => {
    const it = buildItem({ source_id: "offm:42", signal_type: "off_market", zone_code: "D8" });
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("portello-stazione-stanga");
  });

  it("preserves ribasso slug unchanged when already valid", () => {
    const it = buildItem({ source_id: "drop:1", signal_type: "ribasso", zone_code: "D3", commercial_zone_slug: "sud-voltabarozzo-guizza" });
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
  });

  it("rejects invalid slugs at buildItem stage", () => {
    const it = buildItem({ source_id: "x", signal_type: "privato", zone_code: "D3", commercial_zone_slug: "not-a-slug" });
    expect(it.commercial_zone_slug).toBeUndefined();
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("arcella");
  });

  it("removes non-official slug during propagation and re-derives from zone_code", () => {
    // Costruisci direttamente con slug non valido (bypassando buildItem)
    const it: FeedItem = { source_id: "y", signal_type: "privato", title: "t", zone_code: "B1", zone_label: "B1", display_zone: "B1", commercial_zone_slug: "fake-zone" };
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("centro-storico");
  });

  it("does NOT infer slug from quartiere/zona/CAP/indirizzo/text when zone_code is UNRESOLVED", () => {
    const it: FeedItem = {
      source_id: "z", signal_type: "privato", title: "Via Roma 12, CAP 35125, Guizza",
      zone_code: "OMI_UNRESOLVED", zone_label: "Zona non risolta", display_zone: "Zona non risolta",
    };
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBeUndefined();
  });

  it("leaves commercial_zone_slug undefined when zone_code does not map to any active zone", () => {
    const it = buildItem({ source_id: "u", signal_type: "off_market", zone_code: "ZZ99" });
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBeUndefined();
  });

  it("buildItem always exposes commercial_zone_slug as root property (not nested)", () => {
    const it = buildItem({ source_id: "r", signal_type: "contendibile", zone_code: "D3", commercial_zone_slug: "arcella" });
    expect(it.commercial_zone_slug).toBe("arcella");
    // Nessun campo nested
    expect((it as unknown as Record<string, unknown>).raw_json).toBeUndefined();
    expect((it as unknown as Record<string, unknown>).metadata).toBeUndefined();
    expect((it as unknown as Record<string, unknown>).payload).toBeUndefined();
  });

  it("all 8 official slugs are exactly the expected set", () => {
    expect([...VALID_COMMERCIAL_ZONE_SLUGS].sort()).toEqual([
      "arcella",
      "centro-storico",
      "ovest-sacra-famiglia-chiesanuova",
      "portello-stazione-stanga",
      "san-carlo-san-bellino",
      "sant-osvaldo-facciolati",
      "sud-voltabarozzo-guizza",
      "torre-ponte-brenta-camin",
    ]);
  });

  it("diagnostics count buckets sum to items_received per signal_type", () => {
    const items = [
      buildItem({ source_id: "a", signal_type: "privato", zone_code: "D3" }),
      buildItem({ source_id: "b", signal_type: "privato", zone_code: "OMI_UNRESOLVED" }),
      buildItem({ source_id: "c", signal_type: "contendibile", zone_code: "B1" }),
    ];
    propagateCommercialZone(items, omiToSlug);
    const diag: Record<string, { r: number; w: number; wo: number }> = {};
    for (const it of items) {
      const b = (diag[it.signal_type] ??= { r: 0, w: 0, wo: 0 });
      b.r++;
      if (isValidCommercialZoneSlug(it.commercial_zone_slug)) b.w++;
      else b.wo++;
    }
    expect(diag.privato).toEqual({ r: 2, w: 1, wo: 1 });
    expect(diag.contendibile).toEqual({ r: 1, w: 1, wo: 0 });
  });
});
