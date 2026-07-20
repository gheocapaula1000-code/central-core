// Pure tests for commercial-zone assignment used by
// padova-contendibili-list and core-offmarket-list-public.
// Verificano il contratto quartiere-only del writer runtime.
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
  type ActiveZoneRow,
  type CommercialZoneSlug,
} from "../../supabase/functions/_shared/commercialZoneMapping.ts";

const OFFICIAL_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

const LEGACY_SLUGS = [
  "arcella",
  "san-carlo-san-bellino",
  "portello-stazione-stanga",
  "torre-ponte-brenta-camin",
  "sant-osvaldo-facciolati",
  "ovest-sacra-famiglia-chiesanuova",
] as const;

// Firma preservata: ActiveZoneRow è ancora un tipo esportato.
const ACTIVE_ZONES: ActiveZoneRow[] = [
  { slug: "centro-storico", omi_codes: ["B1"] },
  { slug: "nord-arcella", omi_codes: ["C3"] },
];
const omiToSlug = buildOmiToSlugMap(ACTIVE_ZONES);

describe("commercial zone mapping — contratto e superficie API", () => {
  it("espone esattamente 8 slug ufficiali, senza slug legacy", () => {
    expect(VALID_COMMERCIAL_ZONE_SLUGS).toHaveLength(8);
    expect([...VALID_COMMERCIAL_ZONE_SLUGS].sort()).toEqual([...OFFICIAL_SLUGS].sort());
    for (const legacy of LEGACY_SLUGS) {
      expect(VALID_COMMERCIAL_ZONE_SLUGS as readonly string[]).not.toContain(legacy);
      expect(isValidCommercialZoneSlug(legacy)).toBe(false);
    }
  });

  it("isValidCommercialZoneSlug: accetta gli 8 nuovi slug, rifiuta legacy e non stringhe", () => {
    for (const s of OFFICIAL_SLUGS) expect(isValidCommercialZoneSlug(s)).toBe(true);
    expect(isValidCommercialZoneSlug("")).toBe(false);
    expect(isValidCommercialZoneSlug(null)).toBe(false);
    expect(isValidCommercialZoneSlug(undefined)).toBe(false);
    expect(isValidCommercialZoneSlug(42)).toBe(false);
  });

  it("buildOmiToSlugMap: firma preservata, mappa sempre vuota (OMI non produce slug)", () => {
    const m = buildOmiToSlugMap(ACTIVE_ZONES);
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });

  it("hasValidCoords: utility preservata", () => {
    expect(hasValidCoords(45.4, 11.9)).toBe(true);
    expect(hasValidCoords(0, 0)).toBe(false);
    expect(hasValidCoords(null, null)).toBe(false);
    expect(hasValidCoords("x", 11.9)).toBe(false);
  });
});

describe("commercial zone mapping — quartiere è l'unica fonte", () => {
  it("almeno un quartiere per ciascuno degli 8 slug ufficiali", async () => {
    const cases: Array<{ q: string; slug: CommercialZoneSlug }> = [
      { q: "Centro Storico", slug: "centro-storico" },
      { q: "Arcella", slug: "nord-arcella" },
      { q: "Ponte di Brenta", slug: "est-brenta" },
      { q: "Forcellini", slug: "est-forcellini-camin" },
      { q: "Sant'Osvaldo", slug: "sud-est-sant-osvaldo" },
      { q: "Voltabarozzo", slug: "sud-voltabarozzo-guizza" },
      { q: "Mandria", slug: "sud-ovest-mandria" },
      { q: "Chiesanuova", slug: "ovest-chiesanuova-brentelle" },
    ];
    const out = await assignCommercialZonesBatch(
      cases.map((c) => ({ quartiere: c.q })),
      omiToSlug,
      null,
    );
    for (let i = 0; i < cases.length; i++) {
      expect(out[i].commercial_zone_slug).toBe(cases[i].slug);
      expect(out[i].zone_match_method).toBe("quartiere_match");
    }
  });

  it("Crocifisso → sud-voltabarozzo-guizza", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ quartiere: "Crocifisso" }],
      omiToSlug,
      null,
    );
    expect(a.commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
  });

  it("etichetta composita ambigua 'Mortise / Arcella est' → null", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ quartiere: "Mortise / Arcella est" }],
      omiToSlug,
      null,
    );
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
  });

  it("etichetta composita ambigua 'Mandria / Savonarola' → null", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ quartiere: "Mandria / Savonarola" }],
      omiToSlug,
      null,
    );
    expect(a.commercial_zone_slug).toBeNull();
  });

  it("quartiere null / vuoto / assente → null", async () => {
    const out = await assignCommercialZonesBatch(
      [{ quartiere: null }, { quartiere: "" }, {}],
      omiToSlug,
      null,
    );
    for (const a of out) {
      expect(a.commercial_zone_slug).toBeNull();
      expect(a.zone_match_method).toBe("unresolved");
      expect(a.zone_match_confidence).toBeNull();
    }
  });

  it("indirizzo nel campo quartiere → null (nessun fuzzy / includes / split)", async () => {
    const out = await assignCommercialZonesBatch(
      [
        { quartiere: "Via Roma 12, 35100 Padova" },
        { quartiere: "35125 Padova - Guizza (PD)" },
        { quartiere: "Corso del Popolo 3" },
      ],
      omiToSlug,
      null,
    );
    for (const a of out) expect(a.commercial_zone_slug).toBeNull();
  });

  it("codice OMI valido ma quartiere assente → null (OMI non produce slug)", async () => {
    const out = await assignCommercialZonesBatch(
      [
        { omi_zone_code: "B1" },
        { omi_zone_code: "C3", omi_zone: "C3", codice_omi: "C3" },
        { omi_zone_code: "D3", lat: 45.4, lng: 11.9 },
      ],
      omiToSlug,
      null,
    );
    for (const a of out) {
      expect(a.commercial_zone_slug).toBeNull();
      expect(a.zone_match_method).toBe("unresolved");
    }
  });

  it("nessun risultato del writer può essere uno slug legacy", async () => {
    const inputs = [
      { quartiere: "Arcella" },
      { quartiere: "San Bellino" },
      { quartiere: "Portello" },
      { quartiere: "Torre" },
      { quartiere: "Sant'Osvaldo" },
      { quartiere: "Sacra Famiglia" },
      { quartiere: "Chiesanuova" },
      { quartiere: "Centro Storico" },
      { omi_zone_code: "C3" },
      { commercial_zone_slug: "arcella" },
      { commercial_zone_slug: "san-carlo-san-bellino" },
    ];
    const out = await assignCommercialZonesBatch(inputs, omiToSlug, null);
    for (const a of out) {
      if (a.commercial_zone_slug !== null) {
        expect(LEGACY_SLUGS as readonly string[]).not.toContain(a.commercial_zone_slug);
        expect(OFFICIAL_SLUGS as readonly string[]).toContain(a.commercial_zone_slug);
      }
    }
  });
});

describe("commercial zone mapping — helper preservati", () => {
  it("tryExistingSlugOrOmi: accetta slug ufficiale già presente", () => {
    const a = tryExistingSlugOrOmi({ commercial_zone_slug: "nord-arcella" }, omiToSlug);
    expect(a?.commercial_zone_slug).toBe("nord-arcella");
    expect(a?.zone_match_method).toBe("existing_slug");
  });

  it("tryExistingSlugOrOmi: rifiuta slug legacy e codice OMI", () => {
    for (const legacy of LEGACY_SLUGS) {
      const a = tryExistingSlugOrOmi({ commercial_zone_slug: legacy }, omiToSlug);
      expect(a).toBeNull();
    }
    expect(tryExistingSlugOrOmi({ omi_zone_code: "B1" }, omiToSlug)).toBeNull();
    expect(tryExistingSlugOrOmi({ omi_zone_code: "C3" }, omiToSlug)).toBeNull();
    expect(tryExistingSlugOrOmi({ commercial_zone_slug: "Padova" }, omiToSlug)).toBeNull();
  });

  it("assignFromResolution: OMI non produce mai slug", () => {
    const res = { omi_zone_code: "B1", omi_zone_confidence: 0.95, omi_zone_reason: "precomputed_omi" };
    const a = assignFromResolution(res, omiToSlug);
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
    expect(a.zone_match_confidence).toBeNull();
  });

  it("assignFromAliasOnly: risolve dal solo quartiere", () => {
    const a = assignFromAliasOnly({ quartiere: "Guizza" }, omiToSlug);
    expect(a.commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
    const b = assignFromAliasOnly({ area_label: "Padova" }, omiToSlug);
    expect(b.commercial_zone_slug).toBeNull();
  });
});

describe("commercial zone mapping — compatibilità con i chiamanti", () => {
  // I chiamanti runtime (padova-contendibili-list, core-offmarket-list-public,
  // civiko-one-signals-feed) importano questi simboli: la firma deve reggere.
  it("le API esportate esistono con la firma attesa", () => {
    expect(typeof isValidCommercialZoneSlug).toBe("function");
    expect(typeof buildOmiToSlugMap).toBe("function");
    expect(typeof tryExistingSlugOrOmi).toBe("function");
    expect(typeof assignFromResolution).toBe("function");
    expect(typeof assignFromAliasOnly).toBe("function");
    expect(typeof assignCommercialZonesBatch).toBe("function");
    expect(typeof hasValidCoords).toBe("function");
    expect(Array.isArray(VALID_COMMERCIAL_ZONE_SLUGS)).toBe(true);
    // ActiveZoneRow è un tipo; verifichiamo che una struct compatibile passi.
    const rows: ActiveZoneRow[] = [{ slug: "centro-storico", omi_codes: ["B1"] }];
    expect(buildOmiToSlugMap(rows)).toBeInstanceOf(Map);
  });

  it("assignCommercialZonesBatch tollera il vecchio parametro supa (mock rpc)", async () => {
    const supa = { rpc: async () => ({ data: [], error: null }) };
    const out = await assignCommercialZonesBatch(
      [{ quartiere: "Arcella" }, { quartiere: "sconosciuto" }],
      omiToSlug,
      supa,
    );
    expect(out[0].commercial_zone_slug).toBe("nord-arcella");
    expect(out[1].commercial_zone_slug).toBeNull();
  });

  it("filtro esatto delle edge functions: solo slug ufficiali accettati", () => {
    function applyFilter<T extends { commercial_zone_slug: string | null }>(
      list: T[],
      slug: string | null,
    ): T[] {
      if (!slug) return list;
      if (!isValidCommercialZoneSlug(slug)) throw new Error("INVALID_SLUG");
      return list.filter((r) => r.commercial_zone_slug === slug);
    }
    const items = [
      { id: "a", commercial_zone_slug: "nord-arcella" },
      { id: "b", commercial_zone_slug: "centro-storico" },
      { id: "c", commercial_zone_slug: null },
    ];
    expect(applyFilter(items, "nord-arcella").map((r) => r.id)).toEqual(["a"]);
    expect(() => applyFilter(items, "arcella")).toThrow(/INVALID_SLUG/);
    expect(() => applyFilter(items, "padova")).toThrow(/INVALID_SLUG/);
    expect(applyFilter(items, null)).toHaveLength(3);
  });
});
