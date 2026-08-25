import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  canonicalizeProvince,
  canonicalizeRegion,
  geoFromOfficialText,
  geoFromOfficialUrl,
  geoFromTerritorialSource,
  resolveOpportunityGeo,
} from "../../supabase/functions/trovabandi-engine/geo.ts";
import { localOpportunityDraft } from "../../supabase/functions/trovabandi-engine/local-fields.ts";

const ENGINE = readFileSync("supabase/functions/trovabandi-engine/index.ts", "utf8");
const LOCAL = readFileSync("supabase/functions/trovabandi-engine/local-fields.ts", "utf8");

const VENETO_BANDO = `
Avviso pubblico — bando contributi a fondo perduto della Regione Veneto.
Le imprese con sede operativa in Veneto possono presentare domanda.
Camera di Commercio di Padova — bandi in corso.
PEC di protocollo: protocollo@regione.veneto.it
Dotazione 2 milioni di euro.
`.repeat(2);

const PADUA_COMUNE = `
Avviso pubblico del Comune di Padova per contributi alle attività economiche.
Le domande vanno presentate all'ufficio protocollo del Comune di Padova.
Scadenza 30 settembre 2026. Dotazione 100.000 euro.
`.repeat(2);

describe("TrovaBandi geo — canonicalize", () => {
  it("normalizza regioni e province note, rifiuta valori inventati", () => {
    expect(canonicalizeRegion("regione veneto")).toBe("Veneto");
    expect(canonicalizeRegion("Friuli Venezia Giulia")).toBe("Friuli-Venezia Giulia");
    expect(canonicalizeRegion("Marte")).toBeNull();
    expect(canonicalizeProvince("PD")).toBe("Padova");
    expect(canonicalizeProvince("provincia di Padova")).toBe("Padova");
    expect(canonicalizeProvince("XYZ")).toBeNull();
  });
});

describe("TrovaBandi geo — URL ufficiale non ambiguo", () => {
  it("riconosce regione / CCIAA / comune / provincia dal host", () => {
    expect(geoFromOfficialUrl("https://bandi.regione.veneto.it/Public/Dettaglio?id=1")).toEqual({
      region: "Veneto",
      province: null,
      municipality: null,
    });
    expect(geoFromOfficialUrl("https://www.pd.camcom.it/it/la-camera/bandi-in-corso")).toEqual({
      region: "Veneto",
      province: "Padova",
      municipality: null,
    });
    expect(
      geoFromOfficialUrl(
        "https://www.comune.padova.it/servizi/giustizia-e-sicurezza-pubblica/albo-pretorio-online",
      ),
    ).toEqual({
      region: "Veneto",
      province: "Padova",
      municipality: "Padova",
    });
    expect(geoFromOfficialUrl("https://www.provincia.pd.it/albo-pretorio")).toEqual({
      region: "Veneto",
      province: "Padova",
      municipality: null,
    });
  });

  it("non inventa geo da portali nazionali o path ambigui", () => {
    expect(geoFromOfficialUrl("https://www.incentivi.gov.it/veneto")).toEqual({
      region: null,
      province: null,
      municipality: null,
    });
    expect(geoFromOfficialUrl("https://www.invitalia.it/bandi")).toEqual({
      region: null,
      province: null,
      municipality: null,
    });
  });
});

describe("TrovaBandi geo — testo ufficiale", () => {
  it("estrae Regione Veneto e Camera di Padova quando qualificati", () => {
    expect(geoFromOfficialText(VENETO_BANDO)).toEqual({
      region: "Veneto",
      province: "Padova",
      municipality: null,
    });
    expect(geoFromOfficialText(PADUA_COMUNE)).toEqual({
      region: "Veneto",
      province: "Padova",
      municipality: "Padova",
    });
  });

  it("resta null senza qualificatore territoriale (non usa ATECO)", () => {
    const atecoOnly =
      "Avviso pubblico. Codice ATECO 62.01 ammissibile. Dotazione 1 milione. ".repeat(3);
    expect(geoFromOfficialText(atecoOnly)).toEqual({
      region: null,
      province: null,
      municipality: null,
    });
    expect(geoFromOfficialText("Homepage. Cookie. Privacy. Contatti.")).toEqual({
      region: null,
      province: null,
      municipality: null,
    });
  });

  it("con due regioni citate resta ambiguo sulla regione", () => {
    const dual = "Avviso interregionale Regione Veneto e Regione Lombardia. ".repeat(4);
    expect(geoFromOfficialText(dual).region).toBeNull();
  });
});

describe("TrovaBandi geo — seed territoriale e resolve", () => {
  it("usa source.region/province solo per livelli territoriali", () => {
    expect(
      geoFromTerritorialSource({
        authority_level: "CAMERALE",
        region: "Veneto",
        province: "PD",
        official_domain: "pd.camcom.it",
        name: "CCIAA Padova - contributi",
      }),
    ).toEqual({
      region: "Veneto",
      province: "Padova",
      municipality: null,
    });
    expect(
      geoFromTerritorialSource({
        authority_level: "NAZIONALE",
        region: "Veneto",
        province: "PD",
        official_domain: "incentivi.gov.it",
      }),
    ).toEqual({
      region: null,
      province: null,
      municipality: null,
    });
  });

  it("resolve preferisce host/seed e lascia null se confliggono", () => {
    expect(
      resolveOpportunityGeo({
        officialUrl: "https://bandi.regione.veneto.it/avviso",
        source: {
          authority_level: "REGIONALE",
          region: "Veneto",
          province: null,
          official_domain: "bandi.regione.veneto.it",
        },
        markdown: "Homepage senza testo territoriale sufficiente.",
      }),
    ).toEqual({ region: "Veneto", province: null, municipality: null });

    expect(
      resolveOpportunityGeo({
        officialUrl: "https://bandi.regione.veneto.it/avviso",
        source: {
          authority_level: "REGIONALE",
          region: "Lombardia",
          province: null,
          official_domain: "bandi.regione.veneto.it",
        },
        markdown: "",
      }).region,
    ).toBeNull();
  });
});

describe("TrovaBandi geo — local draft e wiring", () => {
  it("la bozza locale espone region/province/municipality dal host", () => {
    const draft = localOpportunityDraft({
      markdown: VENETO_BANDO,
      officialUrl: "https://bandi.regione.veneto.it/Public/Dettaglio?id=9",
      officialDomain: "regione.veneto.it",
    });
    expect(draft).toMatchObject({
      region: "Veneto",
      province: "Padova",
    });
  });

  it("collect/backfill usano resolveOpportunityGeo fail-closed", () => {
    expect(LOCAL).toContain("resolveOpportunityGeo");
    expect(ENGINE).toContain('from "./geo.ts"');
    expect(ENGINE).toContain("resolveOpportunityGeo({");
    expect(ENGINE).toContain("matchTerritorialSource");
    expect(ENGINE).toContain("region.is.null,province.is.null,municipality.is.null");
    expect(ENGINE).toContain("patch.region = geo.region");
    expect(ENGINE).toContain("patch.province = geo.province");
    expect(ENGINE).toContain("patch.municipality = geo.municipality");
    expect(ENGINE).not.toContain(
      "region: normalizeText(extracted.region).slice(0, 120) || source.region",
    );
  });
});
