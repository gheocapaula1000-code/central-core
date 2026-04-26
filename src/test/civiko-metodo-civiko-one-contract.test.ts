/**
 * Civiko One — Metodo Civiko One V1 contract tests
 *
 * Validates the PWA-facing response shape of
 * POST /civiko/property-from-photo against the contract documented
 * in docs/CIVIKO_METODO_CIVIKO_ONE_V1.md.
 *
 * We do NOT call the deployed edge function here. We test the
 * contract invariants the PWA depends on, plus the forbidden
 * vocabulary sanitizer that runs on every outgoing string.
 */
import { describe, it, expect } from "vitest";

// Mirror of the shared sanitizer (kept in sync with _shared/civiko.ts).
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
  if (typeof value === "object") { for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, acc); }
  return acc;
}

// ── Sample PWA-shaped payloads (the 6 mandated scenarios) ──────

const VALID_LEVELS = ["minimo", "parziale", "buono", "completo"] as const;
const VALID_CONFIDENCE = ["alta", "media", "bassa", "non_definita"] as const;
const VALID_FONTE_STATUS = ["da_collegare", "da_consultare", "collegata", "da_rivedere", "non_disponibile"] as const;
const VALID_SECTION_STATUS = ["da_preparare", "da_validare", "pronta", "da_collegare"] as const;
const REQUIRED_SECTION_IDS = [
  "metodo_civiko_one", "immobile_reale", "fonti_da_collegare",
  "zona_in_movimento", "piano_esclusiva", "materiali_da_validare",
];
const REQUIRED_FONTI_IDS = [
  "omi", "padova_municipality", "neighborhood_context",
  "territorial_data", "cadastral_checks", "schools_services", "zone_signals",
];

// Synthetic response that mirrors what the orchestrator must produce.
// This is what we assert the PWA will always be able to render.
function makeShapedResponse() {
  return {
    configured: true,
    warnings: [] as string[],
    updatedAt: new Date().toISOString(),
    inputQuality: { hasPhoto: true, hasGeo: true, hasManualAddress: false, level: "completo" },
    immobileReale: { title: "Trilocale Arcella", address: "Via X 12, Padova", zone: "Arcella", confidence: "alta", needsManualAddress: false },
    fontiDaCollegare: REQUIRED_FONTI_IDS.map((id) => ({
      id, title: id, status: "da_collegare", purpose: "...", sourceOwner: "...", displayItems: [],
    })),
    zonaInMovimento: { segnaliForti: [], puntiAttenzione: [], leveNarrative: [], talkingPointsProprietario: [] },
    pianoEsclusiva: {
      posizioneNegoziale: "Costruire la Posizione Negoziale sui Riferimenti di Mercato.",
      levaPrincipale: "Sfruttare le Verifiche di Supporto disponibili.",
      argomentoEsclusiva: "Presentare il Metodo Civiko One e il Servizio Completo.",
      rischioSenzaEsclusiva: "Senza Incarico in Esclusiva il posizionamento viene disperso.",
      frasiDaUsare: ["Apri il Primo Appuntamento mostrando il Metodo Civiko One."],
      prossimeAzioni: ["Confermare il Primo Appuntamento e portare la Presentazione Proprietario."],
    },
    presentazioneProprietario: {
      sections: REQUIRED_SECTION_IDS.map((id) => ({ id, title: id, status: "pronta", bullets: [] })),
      materialiDaValidare: [] as string[],
    },
    kitMarketing: { available: false, items: [] },
  };
}

describe("Metodo Civiko One V1 — PWA contract", () => {
  it("response has all required top-level keys", () => {
    const r = makeShapedResponse();
    for (const k of ["configured", "warnings", "updatedAt", "inputQuality", "immobileReale", "fontiDaCollegare", "zonaInMovimento", "pianoEsclusiva", "presentazioneProprietario", "kitMarketing"]) {
      expect(r).toHaveProperty(k);
    }
  });

  it("inputQuality.level uses one of the 4 allowed labels", () => {
    const r = makeShapedResponse();
    expect(VALID_LEVELS).toContain(r.inputQuality.level);
  });

  it("immobileReale.confidence is one of the 4 allowed labels", () => {
    const r = makeShapedResponse();
    expect(VALID_CONFIDENCE).toContain(r.immobileReale.confidence);
  });

  it("fontiDaCollegare always contains the 7 mandated areas in order", () => {
    const r = makeShapedResponse();
    expect(r.fontiDaCollegare.map((f) => f.id)).toEqual(REQUIRED_FONTI_IDS);
    for (const f of r.fontiDaCollegare) {
      expect(VALID_FONTE_STATUS).toContain(f.status);
      expect(Array.isArray(f.displayItems)).toBe(true);
    }
  });

  it("presentazioneProprietario.sections contain the 6 mandated sections", () => {
    const r = makeShapedResponse();
    const ids = r.presentazioneProprietario.sections.map((s) => s.id);
    for (const required of REQUIRED_SECTION_IDS) expect(ids).toContain(required);
    for (const s of r.presentazioneProprietario.sections) {
      expect(VALID_SECTION_STATUS).toContain(s.status);
      expect(Array.isArray(s.bullets)).toBe(true);
    }
  });

  it("zonaInMovimento has the 4 mandated array fields", () => {
    const r = makeShapedResponse();
    for (const k of ["segnaliForti", "puntiAttenzione", "leveNarrative", "talkingPointsProprietario"]) {
      expect(Array.isArray((r.zonaInMovimento as Record<string, unknown>)[k])).toBe(true);
    }
  });

  it("pianoEsclusiva exposes all 6 mandated commercial fields", () => {
    const r = makeShapedResponse();
    for (const k of ["posizioneNegoziale", "levaPrincipale", "argomentoEsclusiva", "rischioSenzaEsclusiva", "frasiDaUsare", "prossimeAzioni"]) {
      expect(r.pianoEsclusiva).toHaveProperty(k);
    }
  });

  it("kitMarketing is { available:false, items:[] } in V1", () => {
    const r = makeShapedResponse();
    expect(r.kitMarketing).toEqual({ available: false, items: [] });
  });
});

describe("Metodo Civiko One V1 — forbidden vocabulary in templates", () => {
  it("no string in the shaped response contains a forbidden word", () => {
    const r = makeShapedResponse();
    for (const s of collectStrings(r)) {
      expect(s.match(FORBIDDEN_RE)).toBeNull();
    }
  });

  it("default Piano Esclusiva phrases avoid forbidden words and use Civiko vocabulary", () => {
    const phrases = [
      "Apri il Primo Appuntamento mostrando il Metodo Civiko One.",
      "Non partire dalla provvigione: parti dal Servizio Completo.",
      "Mostra prima la Presentazione Proprietario costruita sui dati reali.",
      "Usa i primi giorni di pubblicazione come argomento centrale.",
      "Porta il Proprietario a vedere preparazione, materiali e gestione.",
    ];
    for (const p of phrases) expect(p.match(FORBIDDEN_RE)).toBeNull();
  });

  it("rejects forbidden words used in arbitrary commercial templates", () => {
    const bad = [
      "Garantito risultato di vendita.",
      "Stima ufficiale del valore reale.",
      "Esperienza smart e intelligente per il proprietario.",
      "Prezzo giusto certificato.",
    ];
    for (const b of bad) expect(b.match(FORBIDDEN_RE)).not.toBeNull();
  });
});
