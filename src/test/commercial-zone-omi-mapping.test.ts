// Determinismo del matching OMI → slug commerciale ufficiale.
// Nessuna rete, nessun Deno import runtime.
import { describe, it, expect } from "vitest";
import {
  VALID_COMMERCIAL_ZONE_SLUGS,
  isValidCommercialZoneSlug,
  buildOmiToSlugMap,
  type ActiveZoneRow,
} from "../../supabase/functions/_shared/commercialZoneMapping.ts";

const ACTIVE: ActiveZoneRow[] = [
  { slug: "arcella", omi_codes: ["C3"] },
  { slug: "centro-storico", omi_codes: ["B1", "B2"] },
  { slug: "ovest-sacra-famiglia-chiesanuova", omi_codes: ["C6", "D1", "R1", "D5"] },
  { slug: "portello-stazione-stanga", omi_codes: ["C1", "C2", "C4", "D8"] },
  { slug: "san-carlo-san-bellino", omi_codes: ["D7"] },
  { slug: "sant-osvaldo-facciolati", omi_codes: ["C5"] },
  { slug: "sud-voltabarozzo-guizza", omi_codes: ["D3", "E3", "D2", "R2"] },
  { slug: "torre-ponte-brenta-camin", omi_codes: ["D4", "D6", "E1", "E2", "R3"] },
];

// Replica identica del pass di propagazione del feed civiko-one-signals-feed.
function propagate(items: Array<{ zone_code: string; commercial_zone_slug?: string }>, map: Map<string, string>) {
  for (const it of items) {
    if (isValidCommercialZoneSlug(it.commercial_zone_slug)) continue;
    if (it.commercial_zone_slug && !isValidCommercialZoneSlug(it.commercial_zone_slug)) {
      delete it.commercial_zone_slug;
    }
    const code = (it.zone_code || "").trim().toUpperCase();
    if (!code || code === "UNRESOLVED_ZONE") continue;
    const slug = map.get(code);
    if (slug) it.commercial_zone_slug = slug;
  }
}

describe("OMI → commercial zone slug: mapping determinism", () => {
  const map = buildOmiToSlugMap(ACTIVE);

  it("normalizza spazi e maiuscole: ' c3 ', 'c3', 'C3 ' → arcella", () => {
    const items = [{ zone_code: " c3 " }, { zone_code: "c3" }, { zone_code: "C3 " }];
    propagate(items, map);
    expect(items.map((i) => (i as any).commercial_zone_slug)).toEqual([
      "arcella", "arcella", "arcella",
    ]);
  });

  it("copre TUTTI i 22 codici OMI Padova ufficialmente attivi", () => {
    const codes = ["B1","B2","C1","C2","C3","C4","C5","C6","D1","D2","D3","D4","D5","D6","D7","D8","E1","E2","E3","R1","R2","R3"];
    for (const c of codes) {
      expect(map.get(c)).toBeDefined();
      expect(isValidCommercialZoneSlug(map.get(c)!)).toBe(true);
    }
  });

  it("corrispondenza multipla (stesso codice su più zone attive) → nessun match", () => {
    const rows: ActiveZoneRow[] = [
      { slug: "arcella", omi_codes: ["X9"] },
      { slug: "centro-storico", omi_codes: ["X9"] },
    ];
    const m = buildOmiToSlugMap(rows);
    expect(m.get("X9")).toBeUndefined();
    const items = [{ zone_code: "X9" }];
    propagate(items, m);
    expect((items[0] as any).commercial_zone_slug).toBeUndefined();
  });

  it("nessuna corrispondenza (codice sconosciuto) → resta unresolved", () => {
    const items = [{ zone_code: "Z99" }];
    propagate(items, map);
    expect((items[0] as any).commercial_zone_slug).toBeUndefined();
  });

  it("slug non ufficiale su una zona 'attiva' viene ignorato dalla mappa", () => {
    const rows: ActiveZoneRow[] = [
      { slug: "padova", omi_codes: ["B1"] as any },
      { slug: "arcella", omi_codes: ["B1"] as any },
    ];
    const m = buildOmiToSlugMap(rows);
    // Solo lo slug ufficiale 'arcella' entra in mappa.
    expect(m.get("B1")).toBe("arcella");
  });

  it("zona inattiva: se il chiamante NON passa quella riga, i suoi codici non entrano nella mappa", () => {
    // La funzione riceve già filtrato attiva=true; simuliamo l'assenza di una riga.
    const rowsSenzaArcella = ACTIVE.filter((r) => r.slug !== "arcella");
    const m = buildOmiToSlugMap(rowsSenzaArcella);
    expect(m.get("C3")).toBeUndefined();
  });

  it("ribassi con slug già valido restano invariati (mappa non li tocca)", () => {
    const items = [{ zone_code: "D3", commercial_zone_slug: "sud-voltabarozzo-guizza" }];
    propagate(items, map);
    expect(items[0].commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
  });

  it("nessuna inferenza da testo/quartiere/CAP: solo zone_code alimenta la propagazione", () => {
    // Il pass del feed usa esclusivamente `zone_code`. Simuliamo un item con
    // testo forte ma zone_code UNRESOLVED_ZONE: non deve ricevere slug.
    const items = [{ zone_code: "UNRESOLVED_ZONE", commercial_zone_slug: undefined } as any];
    (items[0] as any).title = "Via Guizza 12, CAP 35125";
    propagate(items, map);
    expect((items[0] as any).commercial_zone_slug).toBeUndefined();
  });

  it("slug non ufficiale già presente sull'item viene rimosso durante la propagazione", () => {
    const items = [{ zone_code: "B1", commercial_zone_slug: "padova" }];
    propagate(items, map);
    expect(items[0].commercial_zone_slug).toBe("centro-storico");
  });

  it("gli 8 slug ufficiali sono esattamente il set atteso", () => {
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
});
