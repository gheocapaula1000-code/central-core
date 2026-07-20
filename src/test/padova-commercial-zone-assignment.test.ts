// Pure tests for commercial-zone assignment used by
// padova-contendibili-list and core-offmarket-list-public.
// No network, no Supabase, no external APIs.
import { describe, it, expect } from "vitest";
import {
  VALID_COMMERCIAL_ZONE_SLUGS,
  isValidCommercialZoneSlug,
  buildOmiToSlugMap,
  hasValidCoords,
  assignFromResolution,
  tryExistingSlugOrOmi,
  assignFromAliasOnly,
  assignCommercialZonesBatch,
} from "../../supabase/functions/_shared/commercialZoneMapping.ts";

const ACTIVE_ZONES = [
  { slug: "arcella", omi_codes: ["C3"] },
  { slug: "centro-storico", omi_codes: ["B1", "B2"] },
  { slug: "ovest-sacra-famiglia-chiesanuova", omi_codes: ["C6", "D1", "R1", "D5"] },
  { slug: "portello-stazione-stanga", omi_codes: ["C1", "C2", "C4", "D8"] },
  { slug: "san-carlo-san-bellino", omi_codes: ["D7"] },
  { slug: "sant-osvaldo-facciolati", omi_codes: ["C5"] },
  { slug: "sud-voltabarozzo-guizza", omi_codes: ["D3", "E3", "D2", "R2"] },
  { slug: "torre-ponte-brenta-camin", omi_codes: ["D4", "D6", "E1", "E2", "R3"] },
];
const omiToSlug = buildOmiToSlugMap(ACTIVE_ZONES);

// Mock Supabase that returns a PIP result table keyed by index.
function mockSupa(zonaByIdx: Record<number, string | null>) {
  return {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      const lats = args.p_lats as number[];
      return {
        data: lats.map((_, i) => ({ idx: i + 1, zona: zonaByIdx[i] ?? null })),
        error: null,
      };
    },
  };
}

describe("commercial zone mapping — validation", () => {
  it("expone esattamente 8 slug ufficiali", () => {
    expect(VALID_COMMERCIAL_ZONE_SLUGS).toHaveLength(8);
    expect(new Set(VALID_COMMERCIAL_ZONE_SLUGS).size).toBe(8);
  });
  it("isValidCommercialZoneSlug accetta/rifiuta correttamente", () => {
    expect(isValidCommercialZoneSlug("arcella")).toBe(true);
    expect(isValidCommercialZoneSlug("padova")).toBe(false);
    expect(isValidCommercialZoneSlug("")).toBe(false);
    expect(isValidCommercialZoneSlug(null)).toBe(false);
  });
  it("hasValidCoords rifiuta (0,0), NaN, null", () => {
    expect(hasValidCoords(45.4, 11.9)).toBe(true);
    expect(hasValidCoords(0, 0)).toBe(false);
    expect(hasValidCoords(null, null)).toBe(false);
    expect(hasValidCoords("x", 11.9)).toBe(false);
  });
});

describe("commercial zone mapping — resolution rules", () => {
  it("PIP prevale su alias in conflitto", async () => {
    // Coords "Arcella" (C3) + testo "Guizza" (D3). PIP deve vincere.
    const supa = mockSupa({ 0: "C3" });
    const [a] = await assignCommercialZonesBatch(
      [{ lat: 45.42, lng: 11.88, title: "zona Guizza", quartiere: "Guizza" }],
      omiToSlug, supa,
    );
    expect(a.commercial_zone_slug).toBe("arcella");
    expect(a.zone_match_method).toBe("point_in_polygon");
    expect(a.zone_match_confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("Codice OMI su riga mappato SOLO tramite zona attiva", () => {
    // C3 → arcella (attivo).
    const a = tryExistingSlugOrOmi({ omi_zone_code: "C3" }, omiToSlug);
    expect(a?.commercial_zone_slug).toBe("arcella");
    expect(a?.zone_match_method).toBe("existing_omi");
    // Codice non presente in nessuna zona attiva → nessun match.
    const b = tryExistingSlugOrOmi({ omi_zone_code: "ZZ" }, omiToSlug);
    expect(b).toBeNull();
  });

  it("Slug esistente sulla riga accettato solo se ∈ 8", () => {
    const a = tryExistingSlugOrOmi({ commercial_zone_slug: "arcella" }, omiToSlug);
    expect(a?.commercial_zone_slug).toBe("arcella");
    const b = tryExistingSlugOrOmi({ commercial_zone_slug: "padova" }, omiToSlug);
    expect(b).toBeNull();
  });

  it("Alias usato SOLO senza coordinate e confidence >= 0.70", async () => {
    // Nessuna coordinata, solo quartiere "Guizza" → D3 → sud-voltabarozzo-guizza.
    const supa = mockSupa({});
    const [a] = await assignCommercialZonesBatch(
      [{ quartiere: "Guizza" }], omiToSlug, supa,
    );
    expect(a.commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
    expect(a.zone_match_method).toBe("alias_match");
    expect(a.zone_match_confidence).toBeGreaterThanOrEqual(0.7);

    // Con coordinate ma PIP fallisce → NON deve degradare ad alias.
    const supa2 = mockSupa({ 0: null });
    const [b] = await assignCommercialZonesBatch(
      [{ lat: 45.42, lng: 11.88, quartiere: "Guizza" }], omiToSlug, supa2,
    );
    expect(b.commercial_zone_slug).toBeNull();
    expect(b.zone_match_method).toBe("unresolved");
  });

  it("CAP hint (confidence 0.40) NON assegna slug", () => {
    const res = { omi_zone_code: "D3", omi_zone_label: "Guizza", omi_zone_confidence: 0.4, omi_zone_reason: "cap_hint_35125" };
    const a = assignFromResolution(res, omiToSlug);
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
    expect(a.zone_match_confidence).toBeNull();
  });

  it("Unresolved non riceve slug (record vuoto)", async () => {
    const supa = mockSupa({});
    const [a] = await assignCommercialZonesBatch([{}], omiToSlug, supa);
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
    expect(a.zone_match_confidence).toBeNull();
  });

  it("Successione aggregata (label comunale, no coords, no alias forte) resta unresolved", () => {
    const a = assignFromAliasOnly({ area_label: "Padova" }, omiToSlug);
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
  });

  it("Nessun fallback generico 'Padova' → 'Padova' non è slug valido", () => {
    const a = tryExistingSlugOrOmi({ commercial_zone_slug: "Padova" }, omiToSlug);
    expect(a).toBeNull();
  });

  it("Batch: risoluzioni miste (existing_slug, PIP, alias, unresolved)", async () => {
    const supa = mockSupa({ 0: "B1" }); // solo il 2° record ha coords, sarà indice PIP 0
    // Records: [existing_slug, alias-only, coords+PIP hit, empty]
    const [a, b, c, d] = await assignCommercialZonesBatch(
      [
        { commercial_zone_slug: "san-carlo-san-bellino" },
        { quartiere: "Arcella" },
        { lat: 45.41, lng: 11.87 },
        {},
      ],
      omiToSlug, supa,
    );
    expect(a.commercial_zone_slug).toBe("san-carlo-san-bellino");
    expect(a.zone_match_method).toBe("existing_slug");
    expect(b.commercial_zone_slug).toBe("arcella");
    expect(b.zone_match_method).toBe("alias_match");
    expect(c.commercial_zone_slug).toBe("centro-storico");
    expect(c.zone_match_method).toBe("point_in_polygon");
    expect(d.commercial_zone_slug).toBeNull();
  });
});

describe("commercial zone mapping — filter semantics contract", () => {
  // Simuliamo la semantica di filtro applicata nelle edge functions.
  type Item = { id: string; commercial_zone_slug: string | null };
  const items: Item[] = [
    { id: "a", commercial_zone_slug: "arcella" },
    { id: "b", commercial_zone_slug: "arcella" },
    { id: "c", commercial_zone_slug: "centro-storico" },
    { id: "d", commercial_zone_slug: null }, // unresolved
    { id: "e", commercial_zone_slug: "san-carlo-san-bellino" },
  ];

  function applyFilter(list: Item[], slug: string | null) {
    if (!slug) return list; // retrocompatibile
    if (!isValidCommercialZoneSlug(slug)) throw new Error("INVALID_SLUG");
    return list.filter((r) => r.commercial_zone_slug === slug);
  }

  it("filtro esatto tra due zone: solo arcella", () => {
    const out = applyFilter(items, "arcella");
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("filtro esatto: centro-storico esclude arcella e null", () => {
    const out = applyFilter(items, "centro-storico");
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("slug invalido → INVALID_SLUG", () => {
    expect(() => applyFilter(items, "padova")).toThrow(/INVALID_SLUG/);
    expect(() => applyFilter(items, "arcella-extra")).toThrow(/INVALID_SLUG/);
  });

  it("filtro presente esclude sempre gli item con slug null", () => {
    const out = applyFilter(items, "arcella");
    expect(out.some((r) => r.commercial_zone_slug === null)).toBe(false);
  });

  it("assenza filtro → comportamento retrocompatibile (include null)", () => {
    const out = applyFilter(items, null);
    expect(out.length).toBe(items.length);
    expect(out.some((r) => r.commercial_zone_slug === null)).toBe(true);
  });

  it("totals ricalcolati dopo il filtro", () => {
    const filtered = applyFilter(items, "arcella");
    const total = filtered.length;
    expect(total).toBe(2);
    const totalUnfiltered = applyFilter(items, null).length;
    expect(totalUnfiltered).toBe(5);
    expect(total).toBeLessThan(totalUnfiltered);
  });
});
