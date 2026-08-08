// Determinismo del writer commerciale allineato al contratto quartiere-only.
// Nessuna rete, nessun Deno import runtime.
//
// Il vecchio comportamento (OMI → slug commerciale via civiko_commercial_zones)
// è stato rimosso: `buildOmiToSlugMap` è ora una firma preservata che
// restituisce sempre una mappa vuota. La classificazione commerciale passa
// esclusivamente per il quartiere.
import { describe, it, expect } from "vitest";
import {
  VALID_COMMERCIAL_ZONE_SLUGS,
  isValidCommercialZoneSlug,
  buildOmiToSlugMap,
  assignCommercialZonesBatch,
  type ActiveZoneRow,
} from "../../supabase/functions/_shared/commercialZoneMapping.ts";

const ACTIVE: ActiveZoneRow[] = [
  { slug: "centro-storico", omi_codes: ["B1", "B2"] },
  { slug: "nord-arcella", omi_codes: ["C3"] },
];

describe("commercialZoneMapping — determinismo quartiere-only", () => {
  it("gli 8 slug ufficiali sono esattamente il nuovo set contrattuale", () => {
    expect([...VALID_COMMERCIAL_ZONE_SLUGS].sort()).toEqual([
      "centro-storico",
      "est-brenta",
      "nord-est",
      "nord-arcella",
      "ovest-chiesanuova-brentelle",
      "sud-est-sant-osvaldo",
      "sud-ovest-mandria",
      "sud-voltabarozzo-guizza",
    ]);
  });

  it("buildOmiToSlugMap: firma preservata, restituisce sempre mappa vuota", () => {
    const m = buildOmiToSlugMap(ACTIVE);
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });

  it("codice OMI da solo non produce mai slug (nessun fallback OMI)", async () => {
    const map = buildOmiToSlugMap(ACTIVE);
    const codes = ["B1", "B2", "C3", "D3", "D7", "D8", "E1", "R2"];
    const out = await assignCommercialZonesBatch(
      codes.map((c) => ({ zone_code: c, omi_zone_code: c })),
      map,
      null,
    );
    for (const a of out) {
      expect(a.commercial_zone_slug).toBeNull();
      expect(a.zone_match_method).toBe("unresolved");
    }
  });

  it("slug ufficiale già presente sull'item viene IGNORATO (fonte = quartiere)", async () => {
    const map = buildOmiToSlugMap(ACTIVE);
    // Nessun quartiere → nessuna assegnazione, anche se lo slug preesistente è ufficiale.
    const [a] = await assignCommercialZonesBatch(
      [{ omi_zone_code: "C3", commercial_zone_slug: "sud-voltabarozzo-guizza" }],
      map, null,
    );
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
    // Con quartiere presente, deriva dal quartiere anche se lo slug preesistente è diverso.
    const [b] = await assignCommercialZonesBatch(
      [{ omi_zone_code: "C3", commercial_zone_slug: "sud-voltabarozzo-guizza", quartiere: "Arcella" }],
      map, null,
    );
    expect(b.commercial_zone_slug).toBe("nord-arcella");
    expect(b.zone_match_method).toBe("quartiere_match");
  });


  it("slug legacy sull'item viene ignorato (non è più valido)", async () => {
    const map = buildOmiToSlugMap(ACTIVE);
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "arcella", quartiere: "Arcella" }],
      map,
      null,
    );
    // Legacy scartato → passa al quartiere → nuovo slug ufficiale.
    expect(a.commercial_zone_slug).toBe("nord-arcella");
  });

  it("nessuna inferenza da testo/CAP/indirizzo: quartiere ambiguo o assente → null", async () => {
    const map = buildOmiToSlugMap(ACTIVE);
    const out = await assignCommercialZonesBatch(
      [
        { title: "Via Guizza 12, CAP 35125", zone_code: "D3" },
        { quartiere: "Mortise / Arcella est" },
        {},
      ],
      map,
      null,
    );
    for (const a of out) expect(a.commercial_zone_slug).toBeNull();
  });

  it("isValidCommercialZoneSlug: normalizzazione case-sensitive stretta", () => {
    expect(isValidCommercialZoneSlug("nord-arcella")).toBe(true);
    expect(isValidCommercialZoneSlug(" nord-arcella ")).toBe(false);
    expect(isValidCommercialZoneSlug("Nord-Arcella")).toBe(false);
  });
});
