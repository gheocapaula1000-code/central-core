import { describe, expect, it } from "vitest";
import {
  buildCollectPatch,
  buildQuartiereIndex,
  DETAIL_ENRICH_HARD_CAP,
  isGenericAddress,
  needsDetailEnrichment,
  normalizeDetailPortal,
  parseDetailLocation,
  selectDetailEnrichCandidates,
} from "../../supabase/functions/_shared/padovaDetailEnrich";

const IDX = buildQuartiereIndex(["Arcella", "Stanga", "Città Giardino"]);

describe("padovaDetailEnrich", () => {
  it("riconosce indirizzi generici", () => {
    expect(isGenericAddress("Padova (PD)")).toBe(true);
    expect(isGenericAddress("")).toBe(true);
    expect(isGenericAddress("Via Tiziano Aspetti 12")).toBe(false);
  });

  it("normalizza i portali supportati", () => {
    expect(normalizeDetailPortal("subito")).toBe("subito.it");
    expect(normalizeDetailPortal("idealista.it")).toBe("idealista.it");
    expect(normalizeDetailPortal("casa.it")).toBeNull();
  });

  it("seleziona solo candidati senza quartiere e indirizzo utile, bounded", () => {
    const rows = [
      { id: "1", portal: "subito", url: "https://www.subito.it/a-1.htm", quartiere: null, raw_address: "Padova (PD)" },
      { id: "2", portal: "subito", url: "https://www.subito.it/a-2.htm", quartiere: "Arcella", raw_address: null },
      { id: "3", portal: "casa.it", url: "https://www.casa.it/x", quartiere: null, raw_address: null },
      { id: "4", portal: "idealista", url: "https://www.idealista.it/immobile/9/", quartiere: null, raw_address: "Via Roma 1" },
      { id: "5", portal: "idealista", url: "https://www.idealista.it/immobile/8/", quartiere: null, raw_address: null },
    ];
    const sel = selectDetailEnrichCandidates(rows, 10);
    expect(sel.map((r) => r.id)).toEqual(["1", "5"]);
    expect(selectDetailEnrichCandidates(rows, 1)).toHaveLength(1);
    expect(selectDetailEnrichCandidates(rows, 999).length).toBeLessThanOrEqual(DETAIL_ENRICH_HARD_CAP);
  });

  it("estrae quartiere solo se presente nell'allowlist ufficiale", () => {
    const md = "Case in vendita in Arcella, Padova\nZona: Arcella";
    expect(parseDetailLocation("idealista.it", md, "", IDX).quartiere).toBe("Arcella");
    const md2 = "Zona: Quartiere Inventato";
    expect(parseDetailLocation("idealista.it", md2, "", IDX).quartiere).toBeNull();
  });

  it("estrae l'indirizzo solo da odonimi reali", () => {
    const html = `<script type="application/ld+json">{"address":{"streetAddress":"Via Tiziano Aspetti 45","addressLocality":"Padova"}}</script>`;
    const loc = parseDetailLocation("subito.it", "", html, IDX);
    expect(loc.address).toMatch(/Tiziano Aspetti/i);
    expect(parseDetailLocation("subito.it", "Padova (PD)", "", IDX).address).toBeNull();
  });

  it("non sovrascrive dati già presenti", () => {
    const row = { id: "1", portal: "subito", url: "u", quartiere: "Stanga", raw_address: "Via Roma 1" };
    expect(buildCollectPatch(row, { quartiere: "Arcella", address: "Via Altro 2" })).toBeNull();
    const row2 = { id: "2", portal: "subito", url: "u2", quartiere: null, raw_address: "Padova (PD)" };
    expect(buildCollectPatch(row2, { quartiere: "Arcella", address: "Via Altro 2" })).toEqual({
      quartiere: "Arcella",
      raw_address: "Via Altro 2",
    });
  });

  it("needsDetailEnrichment è fail-closed su portali non supportati", () => {
    expect(needsDetailEnrichment({ id: 1, portal: "immobiliare", url: "https://www.immobiliare.it/annunci/1/" })).toBe(false);
  });
});
