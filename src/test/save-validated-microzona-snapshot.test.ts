import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock del client Supabase: cattura le chiamate insert e ritorna ID fittizio.
const insertSpy = vi.fn();
vi.mock("@/integrations/supabase/client", () => {
  const single = vi.fn(async () => ({ data: { id: "snap-test-1" }, error: null }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn((rows: unknown) => {
    insertSpy(rows);
    return { select };
  });
  return { supabase: { from: () => ({ insert }) } };
});

import { saveValidatedMicrozonaSnapshot } from "@/lib/saveValidatedMicrozonaSnapshot";

const baseInput = {
  segnali_territoriali: [{ nome: "Domanda", stato: "verificato" }],
  opportunita_candidate: [{ titolo: "Famiglie", stato: "verificata" }],
  asset_osservati: [{ etichetta: "Appartamento", stato: "osservato" }],
  servizi_prossimita: [{ categoria: "Trasporti", stato: "verificato" }],
  note_interne: "Pilota interna.",
};

describe("saveValidatedMicrozonaSnapshot (Step 4 — pilota Arcella)", () => {
  beforeEach(() => insertSpy.mockClear());

  it("caso valid → insert eseguita, ok=true", async () => {
    const out = await saveValidatedMicrozonaSnapshot(baseInput);
    expect(out.ok).toBe(true);
    expect(out.inserted).toBe(true);
    expect(out.result).toBe("valid");
    expect(out.snapshot_id).toBe("snap-test-1");
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const row = (insertSpy.mock.calls[0][0] as Array<Record<string, unknown>>)[0];
    expect(row.microzona_id).toBe("arcella");
    expect(row.stato).toBe("approvata_interna");
  });

  it("caso valid_with_warnings → insert eseguita, warnings restituiti", async () => {
    const out = await saveValidatedMicrozonaSnapshot({
      segnali_territoriali: [{ nome: "x" }, { nome: "y" }],
      opportunita_candidate: [{ titolo: "a" }, { titolo: "b" }],
      asset_osservati: [{ etichetta: "z", stato: "verificato" }],
      servizi_prossimita: [{ categoria: "k", stato: "verificato" }],
    });
    expect(out.ok).toBe(true);
    expect(out.inserted).toBe(true);
    expect(out.result).toBe("valid_with_warnings");
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("caso invalid → nessuna insert, errors restituiti", async () => {
    const out = await saveValidatedMicrozonaSnapshot({
      segnali_territoriali: [{ nome: "x", stato: "verificato" }],
      opportunita_candidate: [{ titolo: "a", stato: "verificata" }],
      asset_osservati: [{ etichetta: "z", stato: "osservato" }],
      servizi_prossimita: [], // blocco vuoto → invalid
    });
    expect(out.ok).toBe(false);
    expect(out.inserted).toBe(false);
    expect(out.result).toBe("invalid");
    expect(out.errors.length).toBeGreaterThan(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
