import { describe, expect, it } from "vitest";
import {
  generateDocument,
} from "../../supabase/functions/property-outputs/generators.ts";
import type {
  PropertyDetailIn,
  IdentityIn,
  ValuationIn,
  TerritoryIn,
  SignalItemIn,
} from "../../supabase/functions/property-outputs/types.ts";
import { ALL_FAMILIES } from "../../supabase/functions/property-outputs/types.ts";
import { stripBannedClientPhrases } from "../../supabase/functions/property-outputs/language.ts";

const baseIdentity: IdentityIn = {
  indirizzo: "Via Roma",
  civico: "12",
  comune: "Padova",
  provincia: "PD",
  cap: "35100",
  coordinate: { lat: 45.40, lng: 11.87 },
  precisionLevel: "civic",
  microZona: "B1",
  zonaOmi: "PD-B1",
  tipologia: "Appartamento",
  stato: "buono",
  superficieMq: 95,
  locali: 4,
  piano: "2",
  annoCostruzione: 1985,
  classeEnergetica: "D",
  provenance: {
    source: "nominatim+omi",
    confidence: "alta",
    updatedAt: "2026-04-01",
    precisionLevel: "civic",
    spatialScope: "point",
    radiusMeters: null,
  },
};

const valuationOmi: ValuationIn = {
  prezzoMqStimato: 2100,
  prezzoMqMinimo: 1800,
  prezzoMqMassimo: 2400,
  prezzoTotaleStimato: null,
  prezzoTotaleMinimo: null,
  prezzoTotaleMassimo: null,
  unita: "EUR_per_mq",
  drivers: "OMI Abitazioni civili, micro-zona B1",
  provenance: {
    source: "OMI",
    confidence: "media",
    updatedAt: "2025-07-01",
    precisionLevel: "microzone",
    spatialScope: "microzone",
    radiusMeters: null,
  },
};

const territory: TerritoryIn = {
  microZona: "B1",
  sommario: "Area residenziale consolidata",
  puntiForti: ["servizi di prossimità", "buona accessibilità"],
  criticita: ["traffico nelle ore di punta"],
  indicatori: {
    sicurezzaAmbientale: {
      value: "molto bassa esposizione",
      kind: "environmental_risk_inverse",
      provenance: {
        source: "ISPRA",
        confidence: "alta",
        updatedAt: "2021-01-01",
        precisionLevel: "comune",
        spatialScope: "comune",
        radiusMeters: null,
      },
    },
    pressioneTraffico: {
      value: "media",
      kind: "noise_proxy",
      provenance: {
        source: "ISTAT",
        confidence: "bassa",
        updatedAt: "2024-01-01",
        precisionLevel: "comune",
        spatialScope: "comune",
        radiusMeters: null,
      },
    },
  },
  scenarioFuturo: null,
  provenance: {
    source: "ISTAT+ISPRA",
    confidence: "media",
    updatedAt: "2025-01-01",
    precisionLevel: "comune",
    spatialScope: "comune",
    radiusMeters: null,
  },
};

const signal: SignalItemIn = {
  id: "sig-1",
  tipo: "infrastruttura",
  titolo: "Nuova fermata SFMR",
  descrizione: "Ampliamento del servizio metropolitano regionale",
  impatto: "positivo",
  orizzonte: "24 mesi",
  provenance: {
    source: "Regione Veneto",
    confidence: "media",
    updatedAt: "2026-02-01",
    precisionLevel: "neighborhood",
    spatialScope: "buffer_500m",
    radiusMeters: 500,
  },
};

const fullDetail: PropertyDetailIn = {
  id: "urn:ccv3:property:veneto:abcd1234efgh5678",
  identity: baseIdentity,
  valuation: valuationOmi,
  territory,
  signals: [signal],
};

describe("property-outputs — overclaim guards", () => {
  it("strips banned absolute phrases from client copy", () => {
    const r = stripBannedClientPhrases(
      "Un'area splendida, zona sicurissima e sicura rivalutazione del capitale.",
    );
    expect(r.suppressed.length).toBeGreaterThanOrEqual(2);
    expect(r.text).not.toMatch(/sicurissima/i);
    expect(r.text).not.toMatch(/sicura rivalutazione/i);
  });

  it("never exposes provenance/confidence in client documents", () => {
    for (const family of ALL_FAMILIES) {
      if (family === "report_agenzia") continue;
      const doc = generateDocument(family, "client", fullDetail);
      for (const s of doc.sections) {
        expect(s.caveats).toBeUndefined();
        expect(s.body).not.toMatch(/confidenza\s+(alta|media|bassa)/i);
        expect(s.body).not.toMatch(/fonte\s+(OMI|ISPRA|ISTAT|Nominatim)/i);
      }
    }
  });

  it("forces agency phrasing for report_agenzia even if client requested", () => {
    const doc = generateDocument("report_agenzia", "client", fullDetail);
    expect(doc.audience).toBe("agency");
    const hasCaveats = doc.sections.some((s) => (s.caveats?.length ?? 0) > 0);
    expect(hasCaveats).toBe(true);
  });
});

describe("property-outputs — valuation semantics", () => {
  it("never produces a guaranteed total when only €/m² is available", () => {
    for (const family of ALL_FAMILIES) {
      const doc = generateDocument(family, family === "report_agenzia" ? "agency" : "client", fullDetail);
      const text = doc.sections.map((s) => s.body).join("\n");
      // No "valore totale stimato" claim with a euro figure attached.
      expect(text).not.toMatch(/valore\s+totale\s+stimato\s*[:€]/i);
    }
  });

  it("emits €/m² range for client outputs when available", () => {
    const doc = generateDocument("annuncio_lungo", "client", fullDetail);
    const text = doc.sections.map((s) => s.body).join("\n");
    expect(text).toMatch(/al m²/);
  });
});

describe("property-outputs — spatial precision honesty", () => {
  it("uses 'al civico' wording only when identity precision is civic/building", () => {
    const detailStreet: PropertyDetailIn = {
      ...fullDetail,
      identity: {
        ...baseIdentity,
        precisionLevel: "street",
        provenance: { ...baseIdentity.provenance, precisionLevel: "street" },
      },
    };
    const doc = generateDocument("annuncio_portali", "client", detailStreet);
    const text = doc.sections.map((s) => s.body).join("\n");
    expect(text).not.toMatch(/in Via Roma 12/);
    expect(text).toMatch(/lungo Via Roma/);
  });

  it("downgrades to micro-zona phrasing when address is not resolvable", () => {
    const detailMicro: PropertyDetailIn = {
      ...fullDetail,
      identity: {
        ...baseIdentity,
        indirizzo: null,
        civico: null,
        precisionLevel: "microzone",
        provenance: { ...baseIdentity.provenance, precisionLevel: "microzone" },
      },
    };
    const doc = generateDocument("annuncio_lungo", "client", detailMicro);
    const text = doc.sections.map((s) => s.body).join("\n");
    expect(text).toMatch(/micro-zona OMI/);
  });
});

describe("property-outputs — unavailable handling", () => {
  it("omits territory/valuation/signals sections elegantly when missing", () => {
    const minimal: PropertyDetailIn = {
      id: "urn:ccv3:property:veneto:0000000000000000",
      identity: baseIdentity,
      valuation: null,
      territory: null,
      signals: null,
    };
    const doc = generateDocument("fascicolo_cliente", "client", minimal);
    const headings = doc.sections.map((s) => s.heading);
    expect(headings).toContain("L'immobile");
    expect(headings).not.toContain("Inquadramento di valore");
    expect(headings).not.toContain("Il contesto");
    expect(headings).not.toContain("Prospettive d'area");
    expect(doc.availability).toEqual({
      identity: true,
      territory: false,
      valuation: false,
      signals: false,
    });
  });

  it("agency report exposes 'unavailable' explicitly when identity is missing", () => {
    const noIdentity: PropertyDetailIn = {
      id: "urn:ccv3:property:veneto:0000000000000000",
      identity: null,
      valuation: null,
      territory: null,
      signals: null,
    };
    const doc = generateDocument("report_agenzia", "agency", noIdentity);
    const text = doc.sections.map((s) => s.body).join("\n");
    expect(text).toMatch(/non disponibile/i);
  });
});

describe("property-outputs — applied rules observability", () => {
  it("records which generation rules fired", () => {
    const doc = generateDocument("annuncio_lungo", "client", fullDetail);
    expect(doc.appliedRules).toContain("client.annuncio.opener.precision_aware");
    expect(doc.appliedRules).toContain("client.valuation.sqm_only");
  });
});
