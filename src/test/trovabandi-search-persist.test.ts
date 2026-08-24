// TrovaBandi — test comportamentali su policy di ricerca provider e sulla
// persistenza fail-closed (DA_VERIFICARE → evidence → promozione).
// Dominio isolato: non tocca Civiko, Wyloni, Sottra o KeyDraft.

import { describe, expect, it } from "vitest";

import {
  extractSearchRows,
  searchDiagnostics,
  searchFailureFromError,
} from "../../supabase/functions/trovabandi-engine/extraction";
import {
  persistOpportunityFailClosed,
  type PersistClient,
  type PersistRow,
  type PersistVerification,
} from "../../supabase/functions/trovabandi-engine/persist";

type Recorded = { step: string; row: PersistRow };

function makeClient(options: {
  opportunityError?: unknown;
  opportunityId?: string | null;
  evidenceError?: unknown;
  promotionError?: unknown;
}): PersistClient & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    async upsertOpportunity(row) {
      calls.push({ step: "opportunity", row });
      if (options.opportunityError) return { error: options.opportunityError };
      return { id: options.opportunityId === undefined ? "op-1" : options.opportunityId };
    },
    async upsertEvidence(row) {
      calls.push({ step: "evidence", row });
      return { error: options.evidenceError };
    },
    async promote(id, patch) {
      calls.push({ step: "promotion", row: { id, ...patch } });
      return { error: options.promotionError };
    },
  };
}

const NOW = "2026-08-06T12:00:00.000Z";
const BASE = {
  row: { official_url: "https://pd.camcom.it/bando", title: "Bando" } as PersistRow,
  evidence: { source_url: "https://pd.camcom.it/bando" } as PersistRow,
  nowIso: NOW,
};

function run(client: PersistClient, verification: PersistVerification) {
  return persistOpportunityFailClosed(client, { ...BASE, verification });
}

describe("policy di ricerca provider", () => {
  it("una risposta valida con zero risultati non è un guasto", () => {
    const rows = extractSearchRows({ data: [] }, "firecrawl");
    expect(rows).toEqual({ ok: true, rows: [] });
    expect(searchDiagnostics("firecrawl", { ok: true, hits: [] })).toEqual({
      phase: "search_firecrawl",
      code: "OK_EMPTY",
      operational: false,
    });
  });

  it("accetta le forme note dei payload provider", () => {
    expect(extractSearchRows({ data: { web: [{ url: "u" }] } }, "firecrawl")).toEqual({
      ok: true,
      rows: [{ url: "u" }],
    });
    expect(extractSearchRows({ results: [{ url: "u" }] }, "perplexity")).toEqual({
      ok: true,
      rows: [{ url: "u" }],
    });
  });

  it("una risposta di forma inattesa è RESPONSE_INVALID", () => {
    expect(extractSearchRows({ ok: true }, "firecrawl")).toEqual({
      ok: false,
      code: "RESPONSE_INVALID",
    });
    expect(extractSearchRows(null, "perplexity")).toEqual({
      ok: false,
      code: "RESPONSE_INVALID",
    });
    expect(extractSearchRows([{ url: "u" }], "firecrawl")).toEqual({
      ok: false,
      code: "RESPONSE_INVALID",
    });
  });

  it("classifica timeout e rete senza esporre dettagli", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(searchFailureFromError(abort)).toBe("TIMEOUT");
    expect(searchFailureFromError(new Error("socket hang up https://secret"))).toBe("HTTP_ERROR");
  });

  it("ogni guasto provider è operativo e diagnosticato per fase", () => {
    for (const code of ["NO_KEY", "TIMEOUT", "HTTP_401", "HTTP_429", "HTTP_5XX"] as const) {
      const entry = searchDiagnostics("perplexity", { ok: false, code });
      expect(entry).toEqual({ phase: "search_perplexity", code, operational: true });
    }
  });

  it("i risultati validi restano non operativi", () => {
    expect(searchDiagnostics("firecrawl", { ok: true, hits: [1, 2] })).toEqual({
      phase: "search_firecrawl",
      code: "OK",
      operational: false,
    });
  });
});

describe("persistenza fail-closed: ordine e stati", () => {
  it("scrive prima DA_VERIFICARE, poi evidence, poi promuove", async () => {
    const client = makeClient({});
    const result = await run(client, "VERIFICATO");
    expect(client.calls.map((c) => c.step)).toEqual(["opportunity", "evidence", "promotion"]);
    expect(client.calls[0].row.verification_status).toBe("DA_VERIFICARE");
    expect(client.calls[0].row.last_verified_at).toBeNull();
    expect(client.calls[2].row.verification_status).toBe("VERIFICATO");
    expect(client.calls[2].row.last_verified_at).toBe(NOW);
    expect(result).toEqual({ stored: true, verified: true, code: "OK_VERIFICATO" });
  });

  it("last_verified_at resta null per stati non verificati", async () => {
    for (const state of ["PARZIALE", "SCADUTO", "SPORTELLO"] as const) {
      const client = makeClient({});
      const result = await run(client, state);
      expect(client.calls[2].row.last_verified_at).toBeNull();
      expect(result).toEqual({ stored: true, verified: false, code: `OK_${state}` });
    }
  });

  it("DA_VERIFICARE non richiede alcuna promozione", async () => {
    const client = makeClient({});
    const result = await run(client, "DA_VERIFICARE");
    expect(client.calls.map((c) => c.step)).toEqual(["opportunity", "evidence"]);
    expect(result.stored).toBe(true);
    expect(result.verified).toBe(false);
  });

  it("evidence fallita lascia la riga DA_VERIFICARE senza promozione né delete", async () => {
    const client = makeClient({ evidenceError: { code: "23503", message: "segreto" } });
    const result = await run(client, "VERIFICATO");
    expect(client.calls.map((c) => c.step)).toEqual(["opportunity", "evidence"]);
    expect(result).toEqual({
      stored: false,
      verified: false,
      code: "EVIDENCE_WRITE_FAILED_DB_23503",
    });
  });

  it("promozione fallita non produce dati verificati", async () => {
    const client = makeClient({ promotionError: { code: "23514" } });
    const result = await run(client, "VERIFICATO");
    expect(result).toEqual({
      stored: false,
      verified: false,
      code: "PROMOTION_WRITE_FAILED_DB_23514",
    });
  });

  it("opportunity fallita si ferma subito con codice sanificato", async () => {
    const client = makeClient({ opportunityError: { code: "22P02", details: "riga" } });
    const result = await run(client, "VERIFICATO");
    expect(client.calls.map((c) => c.step)).toEqual(["opportunity"]);
    expect(result.code).toBe("OPPORTUNITY_WRITE_FAILED_DB_22P02");
    expect(result.stored).toBe(false);
  });

  it("assenza di id è trattata come scrittura fallita", async () => {
    const client = makeClient({ opportunityId: null });
    const result = await run(client, "PARZIALE");
    expect(result.code).toBe("OPPORTUNITY_WRITE_FAILED_DB_NO_ROW");
  });

  it("nessun codice espone message, details o URL", async () => {
    const client = makeClient({ evidenceError: { code: "23505", message: "https://x/secret" } });
    const result = await run(client, "PARZIALE");
    expect(result.code).not.toContain("https");
    expect(result.code).not.toContain("secret");
  });
});
