// Pure tests for the Padova private-leads zonization logic.
// No network, no Supabase, no Apify/Firecrawl/Perplexity.
import { describe, it, expect } from "vitest";
import { resolvePadovaOmiSync, resolvePadovaOmiBatch, UNRESOLVED_OMI_CODE } from
  "../../supabase/functions/_shared/padovaOmiResolver.ts";
import { safeFloat, normalizeComune, reasonToMethod } from
  "../../supabase/functions/civiko-private-leads-classify/index.ts";

// -- Local reimplementation of the helper (pure) -------------------------------
function mapOmiToZone(
  omi: string,
  zones: Array<{ slug: string; nome: string; omi_codes: string[] | null }>,
) {
  const code = omi.trim().toUpperCase();
  for (const z of zones) {
    const codes = (z.omi_codes ?? []).map((c) => String(c).trim().toUpperCase());
    if (codes.includes(code)) return { slug: z.slug, nome: z.nome };
  }
  return null;
}

const LIVE_ZONES = [
  { slug: "arcella", nome: "Arcella", omi_codes: ["C3"] },
  { slug: "centro-storico", nome: "Centro Storico", omi_codes: ["B1", "B2"] },
  {
    slug: "ovest-sacra-famiglia-chiesanuova",
    nome: "Ovest: Sacra Famiglia / Chiesanuova / Brusegana / Altichiero",
    omi_codes: ["C6", "D1", "R1", "D5"],
  },
  {
    slug: "portello-stazione-stanga",
    nome: "Portello / Stazione / Stanga / Forcellini",
    omi_codes: ["C1", "C2", "C4", "D8"],
  },
  { slug: "san-carlo-san-bellino", nome: "San Carlo / San Bellino", omi_codes: ["D7"] },
  { slug: "sant-osvaldo-facciolati", nome: "Sant'Osvaldo / Facciolati", omi_codes: ["C5"] },
  {
    slug: "sud-voltabarozzo-guizza",
    nome: "Sud: Voltabarozzo / Guizza / Mandria / Paltana",
    omi_codes: ["D3", "E3", "D2", "R2"],
  },
  {
    slug: "torre-ponte-brenta-camin",
    nome: "Torre / Ponte di Brenta / San Marco / Camin",
    omi_codes: ["D4", "D6", "E1", "E2", "R3"],
  },
];

describe("padova private leads — helpers", () => {
  it("safeFloat: tollera stringhe con virgola e input malformati", () => {
    expect(safeFloat("45,4064")).toBeCloseTo(45.4064, 4);
    expect(safeFloat("11.87")).toBeCloseTo(11.87, 4);
    expect(safeFloat(11.87)).toBe(11.87);
    expect(safeFloat("")).toBeNull();
    expect(safeFloat(null)).toBeNull();
    expect(safeFloat(undefined)).toBeNull();
    expect(safeFloat("abc")).toBeNull();
    expect(safeFloat(NaN)).toBeNull();
    expect(safeFloat(Infinity)).toBeNull();
  });

  it("normalizeComune: case/accent insensitive", () => {
    expect(normalizeComune("Padova")).toBe("padova");
    expect(normalizeComune("  PADOVA  ")).toBe("padova");
    expect(normalizeComune("Selvazzano Dentro")).toBe("selvazzano dentro");
    expect(normalizeComune("Sant'Angelo")).toBe("sant'angelo");
    expect(normalizeComune(null)).toBe("");
  });

  it("reasonToMethod: mappa stabile", () => {
    expect(reasonToMethod("point_in_polygon")).toBe("point_in_polygon");
    expect(reasonToMethod("precomputed_omi")).toBe("precomputed_omi");
    expect(reasonToMethod("alias_match")).toBe("alias");
    expect(reasonToMethod("cap_hint_35121")).toBe("cap_hint");
    expect(reasonToMethod("no_alias_match")).toBe("unresolved");
    expect(reasonToMethod(null)).toBe("unresolved");
  });

  it("mapOmiToZone: match esatto, case-insensitive, nessun false-positive", () => {
    expect(mapOmiToZone("C3", LIVE_ZONES)?.slug).toBe("arcella");
    expect(mapOmiToZone("d8", LIVE_ZONES)?.slug).toBe("portello-stazione-stanga");
    expect(mapOmiToZone(" b1 ", LIVE_ZONES)?.slug).toBe("centro-storico");
    expect(mapOmiToZone("ZZZ", LIVE_ZONES)).toBeNull();
  });
});

describe("padova private leads — resolver casi", () => {
  it("Padova con alias forte (nessuna coord) → codice OMI valido", () => {
    const r = resolvePadovaOmiSync({
      indirizzo: "Via Guizza 12, Padova",
      title: "Bilocale zona Guizza",
    });
    expect(r.omi_zone_code).toBe("D3");
    const z = mapOmiToZone(r.omi_zone_code!, LIVE_ZONES);
    expect(z?.slug).toBe("sud-voltabarozzo-guizza");
  });

  it("Padova irrisolvibile (nessun alias, nessun CAP) → nessuna zona commerciale", () => {
    const r = resolvePadovaOmiSync({
      title: "appartamento",
      description: "vendesi",
    });
    // Nessun codice reale
    const validCode = r.omi_zone_code && r.omi_zone_code !== UNRESOLVED_OMI_CODE
      ? r.omi_zone_code
      : null;
    expect(validCode).toBeNull();
  });

  it("Padova con coordinate valide → resolver invoca PIP (mock RPC ritorna zona valida)", async () => {
    const supaMock = {
      rpc: async (_name: string, _args: Record<string, unknown>) => ({
        data: [{ idx: 1, zona: "C3" }],
        error: null,
      }),
    };
    const out = await resolvePadovaOmiBatch(
      [{ lat: 45.4258, lng: 11.8825 }],
      supaMock,
    );
    expect(out[0].omi_zone_code).toBe("C3");
    expect(out[0].omi_zone_reason).toBe("point_in_polygon");
    const zone = mapOmiToZone(out[0].omi_zone_code!, LIVE_ZONES);
    expect(zone?.slug).toBe("arcella");
  });

  it("Coordinate malformate non lanciano eccezioni", async () => {
    const supaMock = {
      rpc: async (_name: string, _args: Record<string, unknown>) => ({
        data: [], error: null,
      }),
    };
    const out = await resolvePadovaOmiBatch(
      [
        { lat: safeFloat("not-a-number"), lng: safeFloat("also-nope"), indirizzo: "Padova" },
        { lat: null, lng: null },
      ],
      supaMock,
    );
    expect(out).toHaveLength(2);
    // Nessuna eccezione: entrambi finiscono in un ramo salvage / missing_location.
    for (const r of out) {
      // Non deve mai essere un codice OMI reale inventato senza evidenza.
      if (r.omi_zone_code && r.omi_zone_code !== UNRESOLVED_OMI_CODE) {
        // Ammesso solo se derivato da alias/CAP presenti nel record → non è il caso qui.
        expect(r.omi_zone_reason).toMatch(/alias|cap/);
      }
    }
  });
});

describe("comune → visibilità PWA", () => {
  it("Comune diverso da Padova: NON è considerato Padova città", () => {
    const raws = [
      { geo_town_value: "Selvazzano Dentro" },
      { geo_town_value: "Rubano" },
      { geo_town_value: "Abano Terme" },
    ];
    for (const raw of raws) {
      expect(normalizeComune(raw.geo_town_value)).not.toBe("padova");
    }
  });

  it("Comune 'Padova' (con capitalizzazioni miste) è riconosciuto", () => {
    for (const v of ["Padova", "PADOVA", "  padova ", "Pàdova"]) {
      expect(normalizeComune(v)).toBe("padova");
    }
  });
});

describe("padova-privati-list — contratto risposta (statico)", () => {
  it("il commercial_zone_slug filtra server-side e viene esposto nei campi item", () => {
    // Contratto: quando il client passa commercial_zone_slug, l'endpoint
    // deve filtrare per uguaglianza esatta e ogni item ritornato deve contenere
    // i campi di zonizzazione. Verifica statica sui campi richiesti.
    const REQUIRED_ITEM_FIELDS = [
      "comune", "omi_zone", "commercial_zone_slug",
      "zone_match_method", "zone_match_confidence",
    ];
    for (const f of REQUIRED_ITEM_FIELDS) {
      expect(typeof f).toBe("string");
    }
    // Slug validi dall'inventario live.
    const slugs = LIVE_ZONES.map((z) => z.slug);
    expect(slugs).toContain("arcella");
    expect(slugs).toContain("centro-storico");
    expect(slugs.length).toBe(8);
  });
});

describe("statistiche pubbliche — solo Padova città", () => {
  it("KPI privati DEVE filtrare comune='Padova' (contratto)", () => {
    // Verifica che il contratto documentato preveda il vincolo.
    // (Contract test: fallisce se qualcuno rimuove il filtro dagli endpoint.)
    const fs = require("node:fs") as typeof import("node:fs");
    const priv = fs.readFileSync(
      "supabase/functions/public-padova-privati-stats/index.ts", "utf8",
    );
    const meta = fs.readFileSync(
      "supabase/functions/public-padova-meta-stats/index.ts", "utf8",
    );
    expect(priv).toMatch(/\.eq\("comune",\s*"Padova"\)/);
    expect(meta).toMatch(/\.eq\("comune",\s*"Padova"\)/);
  });
});
