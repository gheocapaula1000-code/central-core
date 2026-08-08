// Pure static test allineato al contratto quartiere-only.
// Il feed civiko-one-signals-feed continua a usare buildOmiToSlugMap
// per retro-compatibilità di firma, ma la mappa è ora sempre vuota:
// nessuno slug commerciale viene più propagato via zone_code (OMI).
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

// Replica del pass finale di propagazione del feed.
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
  { slug: "centro-storico", omi_codes: ["B1"] },
  { slug: "nord-arcella", omi_codes: ["C3"] },
];
const omiToSlug = buildOmiToSlugMap(activeZones);

describe("civiko-one-signals-feed — commercial_zone_slug (quartiere-only)", () => {
  it("gli 8 slug ufficiali sono il nuovo set contrattuale", () => {
    expect([...VALID_COMMERCIAL_ZONE_SLUGS].sort()).toEqual([
      "centro-storico",
      "est-brenta",
      "nord-arcella",
      "nord-est",
      "ovest-chiesanuova-brentelle",
      "sud-est-sant-osvaldo",
      "sud-ovest-mandria",
      "sud-voltabarozzo-guizza",
    ]);
  });

  it("preserva slug ufficiale già valido al buildItem", () => {
    const it = buildItem({ source_id: "drop:1", signal_type: "ribasso", zone_code: "B1", commercial_zone_slug: "centro-storico" });
    expect(it.commercial_zone_slug).toBe("centro-storico");
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBe("centro-storico");
  });

  it("scarta slug legacy al buildItem e non li reintroduce via propagazione OMI", () => {
    const legacy = ["arcella", "san-carlo-san-bellino", "portello-stazione-stanga", "torre-ponte-brenta-camin", "sant-osvaldo-facciolati", "ovest-sacra-famiglia-chiesanuova"];
    for (const l of legacy) {
      const it = buildItem({ source_id: "x", signal_type: "privato", zone_code: "C3", commercial_zone_slug: l });
      expect(it.commercial_zone_slug).toBeUndefined();
      propagateCommercialZone([it], omiToSlug);
      // Mappa OMI vuota → nessuna re-derivazione.
      expect(it.commercial_zone_slug).toBeUndefined();
    }
  });

  it("zone_code (OMI) non produce mai slug commerciale (mappa vuota)", () => {
    const items: FeedItem[] = [
      buildItem({ source_id: "a", signal_type: "privato", zone_code: "B1" }),
      buildItem({ source_id: "b", signal_type: "contendibile", zone_code: "C3" }),
      buildItem({ source_id: "c", signal_type: "off_market", zone_code: "D8" }),
    ];
    propagateCommercialZone(items, omiToSlug);
    for (const it of items) expect(it.commercial_zone_slug).toBeUndefined();
  });

  it("non inferisce slug da quartiere/CAP/indirizzo se zone_code è UNRESOLVED", () => {
    const it: FeedItem = {
      source_id: "z", signal_type: "privato", title: "Via Roma 12, CAP 35125, Guizza",
      zone_code: "OMI_UNRESOLVED", zone_label: "Zona non risolta", display_zone: "Zona non risolta",
    };
    propagateCommercialZone([it], omiToSlug);
    expect(it.commercial_zone_slug).toBeUndefined();
  });

  it("commercial_zone_slug è sempre esposto come proprietà root", () => {
    const it = buildItem({ source_id: "r", signal_type: "contendibile", zone_code: "B1", commercial_zone_slug: "centro-storico" });
    expect(it.commercial_zone_slug).toBe("centro-storico");
    expect((it as unknown as Record<string, unknown>).raw_json).toBeUndefined();
    expect((it as unknown as Record<string, unknown>).metadata).toBeUndefined();
    expect((it as unknown as Record<string, unknown>).payload).toBeUndefined();
  });
});
