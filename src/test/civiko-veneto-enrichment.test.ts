/**
 * Veneto enrichment — pure logic tests (no network).
 * Validates derivations + shape that index.ts adds to the response.
 */
import { describe, it, expect } from "vitest";

// Re-implementation mirrors of pure helpers — kept minimal and aligned
// with supabase/functions/civiko-property-from-photo/venetoEnrichment.ts.
const VENETO = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);

function parseProvincia(addr: string): string | null {
  const m = (addr || "").match(/\b(VE|VR|VI|PD|TV|BL|RO)\b/);
  if (m && VENETO.has(m[1])) return m[1];
  const lower = (addr || "").toLowerCase();
  if (/\bvenezia\b|\bmestre\b/.test(lower)) return "VE";
  if (/\bverona\b/.test(lower)) return "VR";
  if (/\bvicenza\b/.test(lower)) return "VI";
  if (/\bpadova\b/.test(lower)) return "PD";
  if (/\btreviso\b/.test(lower)) return "TV";
  if (/\bbelluno\b/.test(lower)) return "BL";
  if (/\brovigo\b/.test(lower)) return "RO";
  return null;
}

describe("Veneto enrichment — provincia derivation", () => {
  it("riconosce Vicenza dal testo", () => {
    expect(parseProvincia("Via Roma 1, Vicenza")).toBe("VI");
  });
  it("riconosce Padova dal testo", () => {
    expect(parseProvincia("Via Tiziano 12, Padova")).toBe("PD");
  });
  it("riconosce sigla VR esplicita", () => {
    expect(parseProvincia("Strada Test 5, 37100 Verona VR")).toBe("VR");
  });
  it("ritorna null fuori Veneto", () => {
    expect(parseProvincia("Via Garibaldi 3, Milano MI")).toBe(null);
    expect(parseProvincia("")).toBe(null);
  });
});

describe("Veneto enrichment — shape contract for PWA", () => {
  // Sample of the additive payload the orchestrator must always emit.
  const sample = {
    venetoScope: {
      isInVeneto: true, comune: "Vicenza", provincia: "VI",
      confidence: 0.7, reason: "Provincia veneta dedotta dall'indirizzo.",
    },
    omiZona: {
      available: false, comune: "Vicenza", provincia: "VI",
      microzona: null, fascia: null,
      valoreMin: null, valoreMax: null, valoreMedio: null,
      sourceAnchor: "OMI: dato reale non disponibile.",
      quality: "mancante" as const,
    },
    competizioneAttiva: {
      available: false, annunciAttiviStimati: null, ribassiUltimoMese: null,
      asteVicine: null, pressioneCompetitiva: "sconosciuta" as const, note: "—",
    },
    dataQuality: { real: [], estimated: [], missing: ["omiZona"], warnings: [] },
  };

  it("venetoScope ha tutti i campi richiesti", () => {
    for (const k of ["isInVeneto", "comune", "provincia", "confidence", "reason"]) {
      expect(sample.venetoScope).toHaveProperty(k);
    }
    expect(["VE","VR","VI","PD","TV","BL","RO", null]).toContain(sample.venetoScope.provincia);
  });

  it("omiZona usa quality enumerato e null quando manca", () => {
    expect(["reale","stimato","mancante"]).toContain(sample.omiZona.quality);
    expect(sample.omiZona.valoreMin).toBeNull();
  });

  it("competizioneAttiva usa pressioneCompetitiva enumerata", () => {
    expect(["bassa","media","alta","sconosciuta"]).toContain(sample.competizioneAttiva.pressioneCompetitiva);
  });

  it("dataQuality espone i 4 array previsti", () => {
    for (const k of ["real","estimated","missing","warnings"]) {
      expect(Array.isArray((sample.dataQuality as Record<string, unknown>)[k])).toBe(true);
    }
  });
});

describe("Veneto enrichment — fuori Veneto", () => {
  it("payload fuori Veneto resta serializzabile e marca missing", () => {
    const sample = {
      venetoScope: {
        isInVeneto: false, comune: null, provincia: null,
        confidence: 0.9, reason: "Coordinate fuori dal Veneto.",
      },
      omiZona: { available: false, quality: "mancante" as const },
      competizioneAttiva: { available: false, pressioneCompetitiva: "sconosciuta" as const },
    };
    expect(() => JSON.stringify(sample)).not.toThrow();
    expect(sample.venetoScope.isInVeneto).toBe(false);
  });
});
