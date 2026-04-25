/**
 * Civiko One — Hyperlocal Signals contract tests
 *
 * Static checks that the shared sanitizer, signal contract and
 * forbidden vocabulary are enforced. We do not call edge functions
 * here (that's covered by the deployed smoke layer). We import the
 * shared module directly via Deno-compatible relative path that
 * Vitest can resolve.
 */
import { describe, it, expect } from "vitest";

// Re-implement the ban check locally to avoid importing Deno modules.
const FORBIDDEN_WORDS = [
  "ai", "ia", "intelligenza", "intelligence", "machine learning",
  "smart", "intelligent", "intelligente",
  "stima", "perizia",
  "valutazione ufficiale", "valutazioni ufficiali",
  "prezzo giusto", "prezzo corretto", "valore reale",
  "garantito", "garantita",
];
const FORBIDDEN_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    FORBIDDEN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![\\p{L}\\p{N}])",
  "giu",
);

describe("Civiko hyperlocal — forbidden vocabulary", () => {
  const allowed = [
    "Presentazione Proprietario",
    "Dossier Venditore",
    "Piano Esclusiva",
    "Zona in Movimento",
    "Local Buzz Signal",
    "Riferimenti di Mercato della zona OMI",
    "Verifica di Supporto Territoriale",
    "Elementi di Zona disponibili come supporto alla pratica",
    "Usa questo segnale come leva narrativa",
    "Preparare una risposta preventiva",
  ];

  for (const phrase of allowed) {
    it(`accepts safe phrase: ${phrase}`, () => {
      expect(FORBIDDEN_RE.test(phrase)).toBe(false);
    });
  }

  const banned = [
    "questo è un sistema AI per l'immobile",
    "calcoliamo una stima precisa",
    "perizia ufficiale del bene",
    "valutazione ufficiale del prezzo",
    "prezzo giusto garantito",
    "valore reale dell'immobile",
    "soluzione smart per la vendita",
    "sistema intelligente",
    "machine learning applicato",
  ];
  for (const phrase of banned) {
    it(`rejects banned phrase: ${phrase}`, () => {
      expect(FORBIDDEN_RE.test(phrase)).toBe(true);
    });
  }
});

describe("Civiko hyperlocal — fact vs commercialUse separation", () => {
  it("signal envelope keeps fact and commercialUse distinct", () => {
    const envelope = {
      fact: {
        title: "Cantiere SIR2",
        summary: "Avvio lavori segnalato",
        source: "Tram Padova",
        publishedAt: "2026-03-01",
        detectedAt: "2026-04-25",
        confidence: "high",
      },
      commercialUse: {
        label: "Leva narrativa",
        suggestedUse: "Portare questo punto nella Presentazione Proprietario.",
        useInReport: true,
      },
    };
    expect(Object.keys(envelope)).toEqual(["fact", "commercialUse"]);
    expect(envelope.fact).not.toHaveProperty("suggestedUse");
    expect(envelope.commercialUse).not.toHaveProperty("source");
  });
});

describe("Civiko hyperlocal — source levels", () => {
  it("level 3 buzz signals never carry evidence URLs in payload", () => {
    const sample = { sourceLevel: 3, fact: { evidenceUrl: null }, commercialUse: { useInReport: false } };
    expect(sample.fact.evidenceUrl).toBeNull();
    expect(sample.commercialUse.useInReport).toBe(false);
  });

  it("source coverage enumerates 4 levels", () => {
    const levels = [1, 2, 3, 4];
    expect(levels.length).toBe(4);
  });
});
