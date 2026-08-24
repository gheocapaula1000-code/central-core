import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  isProvenSportelloSenzaScadenza,
  officialVerificationStatus,
} from "../../supabase/functions/trovabandi-engine/verification.ts";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);
const MIGRATION = readFileSync(
  "supabase/migrations/20260824153000_trovabandi_verification_sportello.sql",
  "utf8",
);

const NOW = new Date("2026-08-24T12:00:00.000Z");

describe("isProvenSportelloSenzaScadenza — citazione ufficiale inequivocabile", () => {
  it("riconosce a sportello, fino a esaurimento, senza scadenza, non ha scadenza", () => {
    expect(
      isProvenSportelloSenzaScadenza(
        "Le domande sono valutate a sportello fino a esaurimento delle risorse disponibili.",
      ),
    ).toBe(true);
    expect(
      isProvenSportelloSenzaScadenza(
        "La misura è a sportello. Le risorse sono assegnate in ordine cronologico.",
      ),
    ).toBe(true);
    expect(
      isProvenSportelloSenzaScadenza(
        "Il bando è a sportello fino ad esaurimento della dotazione finanziaria.",
      ),
    ).toBe(true);
    expect(
      isProvenSportelloSenzaScadenza(
        "Le risorse sono assegnate fino all'esaurimento della dotazione.",
      ),
    ).toBe(true);
    expect(
      isProvenSportelloSenzaScadenza(
        "L'avviso non ha scadenza e resta aperto alle imprese del territorio.",
      ),
    ).toBe(true);
    expect(
      isProvenSportelloSenzaScadenza(
        "La presentazione delle domande è senza scadenza, fino a esaurimento fondi.",
      ),
    ).toBe(true);
  });

  it("rifiuta sportello telematico, URL, finestre numerate e chiusure datate", () => {
    expect(
      isProvenSportelloSenzaScadenza(
        "Presentazione domanda: https://www.regione.veneto.it/sportello-domanda",
      ),
    ).toBe(false);
    expect(
      isProvenSportelloSenzaScadenza(
        "Le domande si presentano a sportello telematico sul portale regionale.",
      ),
    ).toBe(false);
    expect(
      isProvenSportelloSenzaScadenza(
        "Chiusura dello sportello: 15.12.2026 ore 17:00. Documentazione ufficiale.",
      ),
    ).toBe(false);
    expect(
      isProvenSportelloSenzaScadenza(
        "Lo sportello apre a partire dal 1 marzo 2026. Le domande si presentano entro il 30 aprile 2026.",
      ),
    ).toBe(false);
    expect(
      isProvenSportelloSenzaScadenza(
        "Fino a esaurimento delle risorse e comunque non oltre il 30 settembre 2026.",
      ),
    ).toBe(false);
    expect(
      isProvenSportelloSenzaScadenza(
        "Scadenza primo sportello 30/09/2026. Termine ultimo 20/12/2026.",
      ),
    ).toBe(false);
    expect(isProvenSportelloSenzaScadenza("sportello")).toBe(false);
    expect(isProvenSportelloSenzaScadenza("")).toBe(false);
  });
});

describe("officialVerificationStatus", () => {
  it("promuove VERIFICATO solo con scadenza attestata e contributo massimo", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
      }),
    ).toBe("VERIFICATO");
  });

  it("resta PARZIALE se manca il contributo massimo", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: null,
        now: NOW,
      }),
    ).toBe("PARZIALE");
  });

  it("marca SPORTELLO se la citazione ufficiale prova l'assenza di chiusura", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: null,
        deadlineProven: false,
        maxGrantAmount: null,
        sportelloSenzaScadenza: true,
        now: NOW,
      }),
    ).toBe("SPORTELLO");
  });

  it("resta SPORTELLO anche con max_grant_amount ufficiale", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: null,
        deadlineProven: false,
        maxGrantAmount: 80000,
        sportelloSenzaScadenza: true,
        now: NOW,
      }),
    ).toBe("SPORTELLO");
  });

  it("non marca PARZIALE né DA_VERIFICARE sul sportello provato", () => {
    const status = officialVerificationStatus({
      hasEvidence: true,
      deadline: null,
      deadlineProven: false,
      maxGrantAmount: 80000,
      sportelloSenzaScadenza: true,
      now: NOW,
    });
    expect(status).not.toBe("PARZIALE");
    expect(status).not.toBe("DA_VERIFICARE");
    expect(status).not.toBe("VERIFICATO");
    expect(status).not.toBe("COMPATIBILE");
  });

  it("ignora una scadenza inventata non attestata se lo sportello è provato", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: false,
        maxGrantAmount: 50000,
        sportelloSenzaScadenza: true,
        now: NOW,
      }),
    ).toBe("SPORTELLO");
  });

  it("preferisce la scadenza ufficiale attestata allo sportello", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        sportelloSenzaScadenza: true,
        now: NOW,
      }),
    ).toBe("VERIFICATO");
  });

  it("marca SCADUTO solo con data attestata già passata", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-01-01T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
      }),
    ).toBe("SCADUTO");
  });

  it("senza evidenza resta DA_VERIFICARE e non inventa COMPATIBILE", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: false,
        deadline: null,
        deadlineProven: false,
        maxGrantAmount: null,
        now: NOW,
      }),
    ).toBe("DA_VERIFICARE");
  });
});

describe("extract/backfill wiring", () => {
  it("usa officialVerificationStatus e non inventa COMPATIBILE né ATECO 62", () => {
    expect(ENGINE).toContain("officialVerificationStatus");
    expect(ENGINE).toContain("isProvenSportelloSenzaScadenza");
    expect(ENGINE).toContain("sportelloSenzaScadenza");
    expect(ENGINE).toContain("OPEN_VERIFICATION_STATUSES");
    expect(ENGINE).toContain("eligible_ateco_prefixes: localExtractAteco(proofText)");
    expect(ENGINE).not.toContain(
      "eligible_ateco_prefixes: safeTextArray(extracted.eligible_ateco_prefixes)",
    );
    expect(ENGINE).not.toMatch(/verification_status:\s*"COMPATIBILE"/);
    expect(MIGRATION).toContain("'SPORTELLO'");
    expect(MIGRATION).toContain("trovabandi_opportunities_verification_status_check");
  });
});
