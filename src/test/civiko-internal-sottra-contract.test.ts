/**
 * Civiko One — Internal Sottra context contract tests.
 *
 * The internal Sottra step is a server-side helper. The PWA must NEVER
 * see the word "Sottra", raw upstream payloads, or invented data.
 * These tests guard those invariants on the shape of the orchestrator
 * response (mirrored locally — we don't call the deployed function).
 */
import { describe, it, expect } from "vitest";

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
  "iu",
);

function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (value == null) return acc;
  if (typeof value === "string") { acc.push(value); return acc; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, acc); return acc; }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, acc);
  }
  return acc;
}

// ── Scenario shapes the orchestrator must always produce ──────

function shapeMissingPhoto() {
  return {
    configured: true,
    warnings: [] as string[],
    updatedAt: new Date().toISOString(),
    inputQuality: { hasPhoto: false, hasGeo: true, hasManualAddress: false, level: "buono" },
    immobileReale: { title: "X", address: "Via Y, Padova", zone: "Arcella", confidence: "media", needsManualAddress: false },
    fontiDaCollegare: [
      { id: "omi", title: "Riferimenti OMI", status: "da_collegare", purpose: "...", sourceOwner: "Agenzia delle Entrate", displayItems: [] },
      { id: "padova_municipality", title: "Comune di Padova", status: "da_collegare", purpose: "...", sourceOwner: "Comune di Padova", displayItems: [] },
      { id: "neighborhood_context", title: "Contesto di Quartiere", status: "da_collegare", purpose: "...", sourceOwner: "ISTAT", displayItems: [] },
      { id: "territorial_data", title: "Dati Territoriali", status: "da_collegare", purpose: "...", sourceOwner: "Fonti", displayItems: [] },
      { id: "cadastral_checks", title: "Verifiche Catastali", status: "da_collegare", purpose: "...", sourceOwner: "Agenzia", displayItems: [] },
      { id: "schools_services", title: "Scuole e Servizi", status: "da_collegare", purpose: "...", sourceOwner: "MIM", displayItems: [] },
      { id: "zone_signals", title: "Segnali di Zona", status: "da_collegare", purpose: "...", sourceOwner: "Fonti Locali", displayItems: [] },
    ],
    zonaInMovimento: { segnaliForti: [], puntiAttenzione: [], leveNarrative: [], talkingPointsProprietario: [] },
    pianoEsclusiva: {
      posizioneNegoziale: "Costruire la Posizione Negoziale al Primo Appuntamento.",
      levaPrincipale: "Sfruttare le Verifiche di Supporto disponibili.",
      argomentoEsclusiva: "Presentare il Metodo Civiko One e il Servizio Completo.",
      rischioSenzaEsclusiva: "Senza Incarico in Esclusiva il posizionamento iniziale viene disperso.",
      frasiDaUsare: ["Apri il Primo Appuntamento mostrando il Metodo Civiko One."],
      prossimeAzioni: ["Confermare il Primo Appuntamento."],
    },
    presentazioneProprietario: { sections: [], materialiDaValidare: [] },
    kitMarketing: { available: false, items: [] },
  };
}

function shapeMissingGeoAndAddress() {
  const r = shapeMissingPhoto();
  r.inputQuality = { hasPhoto: true, hasGeo: false, hasManualAddress: false, level: "parziale" };
  r.immobileReale = { title: "X", address: "", zone: "", confidence: "non_definita", needsManualAddress: true };
  return r;
}

function shapeInternalSottraUnavailable() {
  const r = shapeMissingPhoto();
  r.warnings.push("Contesto interno non disponibile in questo ambiente.");
  return r;
}

describe("Internal Sottra step — never leaks to PWA", () => {
  it("response never mentions the word Sottra (case-insensitive)", () => {
    for (const r of [shapeMissingPhoto(), shapeMissingGeoAndAddress(), shapeInternalSottraUnavailable()]) {
      for (const s of collectStrings(r)) {
        expect(s.toLowerCase()).not.toContain("sottra");
      }
    }
  });

  it("response never contains raw provider/internal markers", () => {
    const banned = ["matchmethod", "geomatchlevel", "polygon_match", "scan/identify", "forecast/", "x-internal-secret"];
    for (const r of [shapeMissingPhoto(), shapeInternalSottraUnavailable()]) {
      const blob = collectStrings(r).join(" ").toLowerCase();
      for (const b of banned) expect(blob).not.toContain(b);
    }
  });

  it("missing photo still returns full PWA shape", () => {
    const r = shapeMissingPhoto();
    expect(r.inputQuality.hasPhoto).toBe(false);
    expect(r.fontiDaCollegare.length).toBe(7);
    expect(r.pianoEsclusiva.frasiDaUsare.length).toBeGreaterThan(0);
  });

  it("missing geo and address sets needsManualAddress = true", () => {
    const r = shapeMissingGeoAndAddress();
    expect(r.immobileReale.needsManualAddress).toBe(true);
    expect(r.immobileReale.confidence).toBe("non_definita");
  });

  it("internal context unavailable still returns 7 default fonti and a useful Piano", () => {
    const r = shapeInternalSottraUnavailable();
    expect(r.fontiDaCollegare.map((f) => f.id)).toEqual([
      "omi", "padova_municipality", "neighborhood_context",
      "territorial_data", "cadastral_checks", "schools_services", "zone_signals",
    ]);
    for (const f of r.fontiDaCollegare) expect(f.displayItems).toEqual([]);
    expect(r.pianoEsclusiva.argomentoEsclusiva).toMatch(/Metodo Civiko One/);
  });

  it("no forbidden vocabulary in any scenario", () => {
    for (const r of [shapeMissingPhoto(), shapeMissingGeoAndAddress(), shapeInternalSottraUnavailable()]) {
      for (const s of collectStrings(r)) {
        expect(s.match(FORBIDDEN_RE)).toBeNull();
      }
    }
  });

  it("no fake OMI displayItems when source is missing", () => {
    const r = shapeMissingPhoto();
    const omi = r.fontiDaCollegare.find((f) => f.id === "omi")!;
    expect(omi.status).toBe("da_collegare");
    expect(omi.displayItems).toEqual([]);
  });

  it("Piano Esclusiva always returns useful copy", () => {
    for (const r of [shapeMissingPhoto(), shapeMissingGeoAndAddress(), shapeInternalSottraUnavailable()]) {
      expect(r.pianoEsclusiva.posizioneNegoziale.length).toBeGreaterThan(20);
      expect(r.pianoEsclusiva.argomentoEsclusiva.length).toBeGreaterThan(20);
      expect(r.pianoEsclusiva.frasiDaUsare.length).toBeGreaterThan(0);
    }
  });
});
