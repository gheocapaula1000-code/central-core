import { describe, expect, it } from "vitest";
import {
  localExtractApplicationUrl,
  localExtractAteco,
  localExtractProtocolEmail,
  localGuessCategory,
  localOpportunityDraft,
  looksLikeOpportunity,
} from "../../supabase/functions/trovabandi-engine/local-fields.ts";

const BANDO = `
Avviso pubblico — bando contributi a fondo perduto per le PMI.
Le domande devono essere presentate entro il 30 settembre 2026.
Codice ATECO ammesso 62.01 e 63.11.
PEC di protocollo: protocollo@regione.veneto.it
Presentazione domanda: https://www.regione.veneto.it/sportello-domanda
Dotazione 2 milioni di euro.
`.repeat(2);

describe("local field extractors", () => {
  it("estrae ATECO solo con keyword esplicita", () => {
    expect(localExtractAteco(BANDO)).toEqual(["62", "63"]);
    expect(localExtractAteco("Decreto n. 62.01 del 2026")).toEqual([]);
  });

  it("estrae PEC/protocollo e URL domanda sullo stesso dominio", () => {
    expect(localExtractProtocolEmail(BANDO)).toBe(
      "protocollo@regione.veneto.it",
    );
    expect(
      localExtractApplicationUrl(BANDO, "regione.veneto.it"),
    ).toBe("https://www.regione.veneto.it/sportello-domanda");
    expect(localExtractApplicationUrl(BANDO, "invitalia.it")).toBeNull();
    expect(localExtractProtocolEmail("contatti: info@regione.veneto.it")).toBeNull();
  });

  it("riconosce un bando e resta fail-closed su homepage generiche", () => {
    expect(looksLikeOpportunity(BANDO)).toBe(true);
    expect(looksLikeOpportunity("Chi siamo. Cookie. Privacy.")).toBe(false);
    expect(localGuessCategory(BANDO)).toBe("FONDO_PERDUTO");
  });

  it("la bozza locale non inventa forme/dimensioni e non marca COMPATIBILE", () => {
    const draft = localOpportunityDraft({
      markdown: BANDO,
      officialUrl: "https://www.regione.veneto.it/bando",
      officialDomain: "regione.veneto.it",
      deadline: "2026-09-30T00:00:00.000Z",
      max_grant_amount: 2000000,
    });
    expect(draft).toMatchObject({
      is_opportunity: true,
      official_url: "https://www.regione.veneto.it/bando",
      eligible_legal_forms: [],
      eligible_company_sizes: [],
    });
    expect(draft?.eligible_ateco_prefixes).toEqual(["62", "63"]);
    expect(
      localOpportunityDraft({
        markdown: "Homepage istituzionale",
        officialUrl: "https://www.regione.veneto.it",
        officialDomain: "regione.veneto.it",
      }),
    ).toBeNull();
  });
});
