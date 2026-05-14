import { describe, it, expect } from "vitest";
import { normalizeMicrozona } from "@/lib/normalizeMicrozona";

describe("normalizeMicrozona (Step 2 — pilota Arcella)", () => {
  it("produce uno shape coerente con microzona_dossier", () => {
    const out = normalizeMicrozona({
      segnali_territoriali: [
        { nome: "Domanda percepita", livello: "Forte", stato: "verificato" },
        { nome: "Pressione competitiva", stato: "da_confermare" },
      ],
      opportunita_candidate: [
        { titolo: "Famiglie", priorita: "alta", stato: "verificata" },
        { titolo: "Prima casa", stato: "da_confermare" },
      ],
      asset_osservati: [
        { etichetta: "Appartamento", stato: "osservato" },
        { etichetta: "Bilocale", stato: "in_verifica" },
      ],
      servizi_prossimita: [{ categoria: "Trasporti", maturitaDato: "demo" }],
      note_interne: "Prima base pilota interna.",
    });

    expect(out.microzona_id).toBe("arcella");
    expect(out.stato).toBe("approvata_interna");
    expect(typeof out.versione).toBe("string");
    expect(new Date(out.versione).toString()).not.toBe("Invalid Date");

    for (const block of [
      out.servizi_prossimita,
      out.segnali_territoriali,
      out.opportunita_candidate,
      out.asset_osservati,
    ]) {
      expect(Array.isArray(block)).toBe(true);
      for (const item of block) {
        expect(["certo", "probabile", "da_testare"]).toContain(item.livello);
      }
    }

    expect(out.opportunita_candidate[0].livello).toBe("certo");
    expect(out.opportunita_candidate[1].livello).toBe("da_testare");
    expect(out.asset_osservati[0].livello).toBe("certo");
    expect(out.asset_osservati[1].livello).toBe("probabile");
    expect(out.servizi_prossimita[0].livello).toBe("probabile");
  });

  it("è robusta su input vuoto / mancante", () => {
    const out = normalizeMicrozona();
    expect(out.microzona_id).toBe("arcella");
    expect(out.servizi_prossimita).toEqual([]);
    expect(out.segnali_territoriali).toEqual([]);
    expect(out.opportunita_candidate).toEqual([]);
    expect(out.asset_osservati).toEqual([]);
    expect(out.note_interne).toBe("");
  });

  it("è pura (stesso input → stesso output, a parità di versione)", () => {
    const versione = "2026-05-14T00:00:00.000Z";
    const a = normalizeMicrozona({ versione, segnali_territoriali: [{ nome: "x" }] });
    const b = normalizeMicrozona({ versione, segnali_territoriali: [{ nome: "x" }] });
    expect(a).toEqual(b);
  });
});
