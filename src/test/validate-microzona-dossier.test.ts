import { describe, it, expect } from "vitest";
import { normalizeMicrozona } from "@/lib/normalizeMicrozona";
import { validateMicrozonaDossier } from "@/lib/validateMicrozonaDossier";

describe("validateMicrozonaDossier (Step 3 — pilota Arcella)", () => {
  it("caso valido: tutti i blocchi popolati e livelli affidabili", () => {
    const dossier = normalizeMicrozona({
      segnali_territoriali: [{ nome: "Domanda", stato: "verificato" }],
      opportunita_candidate: [{ titolo: "Famiglie", stato: "verificata" }],
      asset_osservati: [{ etichetta: "Appartamento", stato: "osservato" }],
      servizi_prossimita: [{ categoria: "Trasporti", stato: "verificato" }],
      note_interne: "Base pilota interna.",
    });
    const out = validateMicrozonaDossier(dossier);
    expect(out.isValid).toBe(true);
    expect(out.result).toBe("valid");
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.stats.totale_elementi).toBe(4);
    expect(out.stats.certo).toBe(4);
  });

  it("warning: rapporto da_testare > 0.5 ma struttura valida", () => {
    const dossier = normalizeMicrozona({
      segnali_territoriali: [{ nome: "x" }, { nome: "y" }],
      opportunita_candidate: [{ titolo: "a" }, { titolo: "b" }],
      asset_osservati: [{ etichetta: "z", stato: "verificato" }],
      servizi_prossimita: [{ categoria: "k", stato: "verificato" }],
    });
    const out = validateMicrozonaDossier(dossier);
    expect(out.isValid).toBe(true);
    expect(out.result).toBe("valid_with_warnings");
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.stats.rapporto_da_testare).toBeGreaterThan(0.5);
  });

  it("invalid: blocco vuoto", () => {
    const dossier = normalizeMicrozona({
      segnali_territoriali: [{ nome: "x", stato: "verificato" }],
      opportunita_candidate: [{ titolo: "a", stato: "verificata" }],
      asset_osservati: [{ etichetta: "z", stato: "osservato" }],
      servizi_prossimita: [],
    });
    const out = validateMicrozonaDossier(dossier);
    expect(out.isValid).toBe(false);
    expect(out.result).toBe("invalid");
    expect(out.errors.some((e) => e.includes("servizi_prossimita"))).toBe(true);
  });

  it("invalid: livello mancante o non ammesso", () => {
    const dossier = {
      microzona_id: "arcella",
      versione: new Date().toISOString(),
      stato: "approvata_interna" as const,
      servizi_prossimita: [{ categoria: "k", livello: "certo" as const }],
      segnali_territoriali: [{ nome: "x" } as unknown as { livello: "certo" }],
      opportunita_candidate: [{ titolo: "a", livello: "boh" as unknown as "certo" }],
      asset_osservati: [{ etichetta: "z", livello: "certo" as const }],
      note_interne: "",
    };
    const out = validateMicrozonaDossier(dossier);
    expect(out.isValid).toBe(false);
    expect(out.result).toBe("invalid");
    expect(out.errors.some((e) => e.includes("livello"))).toBe(true);
  });

  it("invalid: microzona_id diverso da arcella", () => {
    const dossier = normalizeMicrozona({
      segnali_territoriali: [{ nome: "x", stato: "verificato" }],
      opportunita_candidate: [{ titolo: "a", stato: "verificata" }],
      asset_osservati: [{ etichetta: "z", stato: "osservato" }],
      servizi_prossimita: [{ categoria: "k", stato: "verificato" }],
    });
    const out = validateMicrozonaDossier({ ...dossier, microzona_id: "altro" });
    expect(out.isValid).toBe(false);
    expect(out.errors.some((e) => e.includes("arcella"))).toBe(true);
  });

  it("invalid: note_interne contiene URL/email", () => {
    const dossier = normalizeMicrozona({
      segnali_territoriali: [{ nome: "x", stato: "verificato" }],
      opportunita_candidate: [{ titolo: "a", stato: "verificata" }],
      asset_osservati: [{ etichetta: "z", stato: "osservato" }],
      servizi_prossimita: [{ categoria: "k", stato: "verificato" }],
      note_interne: "vedi https://example.com e scrivi a foo@bar.com",
    });
    const out = validateMicrozonaDossier(dossier);
    expect(out.isValid).toBe(false);
    expect(out.errors.some((e) => e.toLowerCase().includes("url"))).toBe(true);
    expect(out.errors.some((e) => e.toLowerCase().includes("email"))).toBe(true);
  });
});
