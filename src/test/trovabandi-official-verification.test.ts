import { describe, expect, it } from "vitest";
import { officialVerificationStatus } from "../../supabase/functions/trovabandi-engine/verification.ts";

const NOW = new Date("2026-08-24T12:00:00.000Z");

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

  it("resta PARZIALE se la data non è nel testo ufficiale", () => {
    expect(
      officialVerificationStatus({
        hasEvidence: true,
        deadline: "2026-12-31T00:00:00.000Z",
        deadlineProven: false,
        maxGrantAmount: 50000,
        now: NOW,
      }),
    ).toBe("PARZIALE");
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
