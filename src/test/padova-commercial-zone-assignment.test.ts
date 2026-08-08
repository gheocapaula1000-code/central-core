// Pure tests for commercial-zone assignment.
// Contratto quartiere-only: `commercialZoneForQuartiere(record.quartiere)`
// è l'UNICA fonte di `commercial_zone_slug`. Nessuno slug preesistente,
// nessun codice OMI, nessuna mappa OMI può produrre una classificazione.
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
  "nord-est",
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
      { q: "Forcellini", slug: "nord-est" },
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
      [{ quartiere: "Crocifisso" }], omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
  });

  it("etichette composite ambigue → null", async () => {
    const out = await assignCommercialZonesBatch(
      [{ quartiere: "Mortise / Arcella est" }, { quartiere: "Mandria / Savonarola" }],
      omiToSlug, null,
    );
    for (const a of out) {
      expect(a.commercial_zone_slug).toBeNull();
      expect(a.zone_match_method).toBe("unresolved");
    }
  });

  it("quartiere null / vuoto / assente → null", async () => {
    const out = await assignCommercialZonesBatch(
      [{ quartiere: null }, { quartiere: "" }, {}], omiToSlug, null,
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
      omiToSlug, null,
    );
    for (const a of out) expect(a.commercial_zone_slug).toBeNull();
  });
});

describe("commercial zone mapping — slug preesistente e OMI vengono IGNORATI", () => {
  it("slug ufficiale presente + quartiere assente → null", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "centro-storico" }], omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBeNull();
    expect(a.zone_match_method).toBe("unresolved");
    expect(a.zone_match_confidence).toBeNull();
  });

  it("slug ufficiale presente + quartiere ambiguo → null", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "centro-storico", quartiere: "Mortise / Arcella est" }],
      omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBeNull();
  });

  it("conflitto: slug 'centro-storico' + quartiere 'Arcella' → 'nord-arcella'", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "centro-storico", quartiere: "Arcella" }],
      omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBe("nord-arcella");
    expect(a.zone_match_method).toBe("quartiere_match");
  });

  it("conflitto: slug 'nord-arcella' + quartiere 'Centro Storico' → 'centro-storico'", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "nord-arcella", quartiere: "Centro Storico" }],
      omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBe("centro-storico");
    expect(a.zone_match_method).toBe("quartiere_match");
  });

  it("slug legacy + quartiere valido → zona derivata dal quartiere", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "arcella", quartiere: "Voltabarozzo" }],
      omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
    expect(a.zone_match_method).toBe("quartiere_match");
  });

  it("slug ufficiale coerente + quartiere valido → metodo resta 'quartiere_match'", async () => {
    const [a] = await assignCommercialZonesBatch(
      [{ commercial_zone_slug: "centro-storico", quartiere: "Centro Storico" }],
      omiToSlug, null,
    );
    expect(a.commercial_zone_slug).toBe("centro-storico");
    // Deriva SEMPRE dal quartiere, mai da existing_slug.
    expect(a.zone_match_method).toBe("quartiere_match");
    expect(a.zone_match_confidence).toBe(0.95);
  });

  it("codice OMI valido + quartiere assente → null", async () => {
    const out = await assignCommercialZonesBatch(
      [
        { omi_zone_code: "B1" },
        { omi_zone_code: "C3", omi_zone: "C3", codice_omi: "C3" },
        { omi_zone_code: "D3", lat: 45.4, lng: 11.9 },
      ],
      omiToSlug, null,
    );
    for (const a of out) {
      expect(a.commercial_zone_slug).toBeNull();
      expect(a.zone_match_method).toBe("unresolved");
    }
  });

  it("batch misto: nessun elemento è classificato dalla proprietà slug preesistente", async () => {
    const inputs = [
      { commercial_zone_slug: "centro-storico" },                             // slug only → null
      { commercial_zone_slug: "nord-arcella", quartiere: "Centro Storico" },  // slug ignorato
      { commercial_zone_slug: "arcella", quartiere: "Voltabarozzo" },          // legacy ignorato
      { commercial_zone_slug: "centro-storico", quartiere: "sconosciuto" },   // ambiguo → null
      { omi_zone_code: "B1" },                                                // OMI only → null
      { quartiere: "Chiesanuova" },                                           // quartiere valido
      {},                                                                     // vuoto → null
    ];
    const out = await assignCommercialZonesBatch(inputs, omiToSlug, null);
    // Nessuno slug proviene da existing_slug.
    for (const a of out) expect(a.zone_match_method).not.toBe("existing_slug");
    expect(out[0].commercial_zone_slug).toBeNull();
    expect(out[1].commercial_zone_slug).toBe("centro-storico");
    expect(out[2].commercial_zone_slug).toBe("sud-voltabarozzo-guizza");
    expect(out[3].commercial_zone_slug).toBeNull();
    expect(out[4].commercial_zone_slug).toBeNull();
    expect(out[5].commercial_zone_slug).toBe("ovest-chiesanuova-brentelle");
    expect(out[6].commercial_zone_slug).toBeNull();
  });

  it("nessun risultato del writer può essere uno slug legacy", async () => {
    const inputs = [
      { commercial_zone_slug: "arcella", quartiere: "Arcella" },
      { commercial_zone_slug: "san-carlo-san-bellino", quartiere: "San Bellino" },
      { commercial_zone_slug: "portello-stazione-stanga", quartiere: "Portello" },
      { commercial_zone_slug: "torre-ponte-brenta-camin", quartiere: "Torre" },
      { commercial_zone_slug: "sant-osvaldo-facciolati", quartiere: "Sant'Osvaldo" },
      { commercial_zone_slug: "ovest-sacra-famiglia-chiesanuova", quartiere: "Sacra Famiglia" },
      { omi_zone_code: "C3" },
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
  it("tryExistingSlugOrOmi: firma preservata, NON assegna mai (UNRESOLVED per costruzione)", () => {
    // Slug ufficiale già presente.
    for (const s of OFFICIAL_SLUGS) {
      const a = tryExistingSlugOrOmi({ commercial_zone_slug: s }, omiToSlug);
      expect(a?.commercial_zone_slug).toBeNull();
      expect(a?.zone_match_method).toBe("unresolved");
      expect(a?.zone_match_confidence).toBeNull();
    }
    // Slug legacy.
    for (const legacy of LEGACY_SLUGS) {
      const a = tryExistingSlugOrOmi({ commercial_zone_slug: legacy }, omiToSlug);
      expect(a?.commercial_zone_slug).toBeNull();
    }
    // Codice OMI e mappa OMI: nessuna assegnazione.
    expect(tryExistingSlugOrOmi({ omi_zone_code: "B1" }, omiToSlug)?.commercial_zone_slug).toBeNull();
    expect(tryExistingSlugOrOmi({ omi_zone_code: "C3" }, omiToSlug)?.commercial_zone_slug).toBeNull();
    // Record vuoto.
    expect(tryExistingSlugOrOmi({}, omiToSlug)?.commercial_zone_slug).toBeNull();
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
    // Ignora anche uno slug preesistente sul record.
    const c = assignFromAliasOnly({ commercial_zone_slug: "centro-storico" }, omiToSlug);
    expect(c.commercial_zone_slug).toBeNull();
  });
});

describe("commercial zone mapping — compatibilità con i chiamanti", () => {
  it("le API esportate esistono con la firma attesa", () => {
    expect(typeof isValidCommercialZoneSlug).toBe("function");
    expect(typeof buildOmiToSlugMap).toBe("function");
    expect(typeof tryExistingSlugOrOmi).toBe("function");
    expect(typeof assignFromResolution).toBe("function");
    expect(typeof assignFromAliasOnly).toBe("function");
    expect(typeof assignCommercialZonesBatch).toBe("function");
    expect(typeof hasValidCoords).toBe("function");
    expect(Array.isArray(VALID_COMMERCIAL_ZONE_SLUGS)).toBe(true);
    const rows: ActiveZoneRow[] = [{ slug: "centro-storico", omi_codes: ["B1"] }];
    expect(buildOmiToSlugMap(rows)).toBeInstanceOf(Map);
  });

  it("assignCommercialZonesBatch tollera il parametro supa (mock rpc)", async () => {
    const supa = { rpc: async () => ({ data: [], error: null }) };
    const out = await assignCommercialZonesBatch(
      [{ quartiere: "Arcella" }, { quartiere: "sconosciuto" }],
      omiToSlug, supa,
    );
    expect(out[0].commercial_zone_slug).toBe("nord-arcella");
    expect(out[1].commercial_zone_slug).toBeNull();
  });

  it("filtro esatto delle edge functions: solo slug ufficiali accettati", () => {
    function applyFilter<T extends { commercial_zone_slug: string | null }>(
      list: T[], slug: string | null,
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
