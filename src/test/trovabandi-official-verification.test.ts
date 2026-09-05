import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXPIRE_VERIFICATION_STATUSES,
  OPEN_VERIFICATION_STATUSES,
  hasAttestedAmount,
  hasAttestedTiming,
  hasSubmissionChannel,
  isFeedComplete,
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
const CHANNEL = {
  application_url: "https://www.regione.veneto.it/sportello-domanda",
} as const;

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
  it("promuove VERIFICATO solo con scadenza attestata, contributo massimo e canale", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
        ...CHANNEL,
      }),
    ).toBe("VERIFICATO");
  });

  it("resta PARZIALE se manca il canale di presentazione", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
      }),
    ).toBe("PARZIALE");
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
        application_url: "  ",
        forms_url: null,
        protocol_email: "",
      }),
    ).toBe("PARZIALE");
  });

  it("accetta forms_url o PEC come canale per VERIFICATO", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
        forms_url: "https://www.pd.camcom.it/bandi/modulo.pdf",
      }),
    ).toBe("VERIFICATO");
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
        maxGrantAmount: 50000,
        now: NOW,
        protocol_email: "protocollo@regione.veneto.it",
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
        ...CHANNEL,
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

describe("gate scheda completa / feed-complete", () => {
  it("importo = min/max grant, intensità o budget; mai un valore assente", () => {
    expect(hasAttestedAmount({ max_grant_amount: 50000 })).toBe(true);
    expect(hasAttestedAmount({ min_grant_amount: 1000 })).toBe(true);
    expect(hasAttestedAmount({ aid_intensity_percent: 40 })).toBe(true);
    expect(hasAttestedAmount({ total_budget: 2_000_000 })).toBe(true);
    expect(hasAttestedAmount({})).toBe(false);
    expect(hasAttestedAmount({ max_grant_amount: 0 })).toBe(false);
  });

  it("timing = scadenza attestata, apertura o sportello", () => {
    expect(
      hasAttestedTiming({
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
      }),
    ).toBe(true);
    expect(hasAttestedTiming({ opens_at: "2026-03-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(hasAttestedTiming({ sportelloSenzaScadenza: true })).toBe(true);
    expect(
      hasAttestedTiming({
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: false,
      }),
    ).toBe(false);
  });

  it("canale = application_url, forms_url o PEC", () => {
    expect(hasSubmissionChannel(CHANNEL)).toBe(true);
    expect(
      hasSubmissionChannel({ protocol_email: "protocollo@regione.veneto.it" }),
    ).toBe(true);
    expect(hasSubmissionChannel({})).toBe(false);
  });

  it("isFeedComplete richiede le tre assi; non promuove VERIFICATO da sola", () => {
    expect(
      isFeedComplete({
        total_budget: 1_000_000,
        opens_at: "2026-03-01T00:00:00.000Z",
        ...CHANNEL,
      }),
    ).toBe(true);
    expect(
      isFeedComplete({
        max_grant_amount: 50000,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: true,
      }),
    ).toBe(false);
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: null,
        deadlineProven: false,
        maxGrantAmount: null,
        now: NOW,
        ...CHANNEL,
      }),
    ).not.toBe("VERIFICATO");
  });
});

describe("extract/backfill wiring", () => {
  it("usa officialVerificationStatus e non inventa COMPATIBILE né ATECO 62", () => {
    expect(ENGINE).toContain("officialVerificationStatus");
    expect(ENGINE).toContain("application_url: applyUrls.application_url");
    expect(ENGINE).toContain("forms_url: applyUrls.forms_url");
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
    expect(OPEN_VERIFICATION_STATUSES).toContain("SPORTELLO");
    expect(EXPIRE_VERIFICATION_STATUSES).toContain("SPORTELLO");
    expect(EXPIRE_VERIFICATION_STATUSES).not.toContain("RITIRATO");
  });
});
