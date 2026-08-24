import { describe, expect, it } from "vitest";
import { localOpportunityDraft } from "../../supabase/functions/trovabandi-engine/local-fields.ts";
import { validateExtraction } from "../../supabase/functions/trovabandi-engine/extraction.ts";
import {
  classifyOfficialListingUrl,
  isEligibleOfficialOpportunity,
  isIndexOrLandingUrl,
  isJunkOpportunityContent,
} from "../../supabase/functions/trovabandi-engine/opportunity-gate.ts";

const BANDO = `
Avviso pubblico — bando contributi a fondo perduto per le PMI.
Le domande devono essere presentate entro il 30 settembre 2026.
Codice ATECO ammesso 62.01 e 63.11.
PEC di protocollo: protocollo@regione.veneto.it
Presentazione domanda: https://www.regione.veneto.it/sportello-domanda
Dotazione 2 milioni di euro.
`.repeat(2);

const VALID = {
  is_opportunity: true,
  title: "Bando digitalizzazione PMI",
  authority_name: "CCIAA Padova",
  category: "DIGITALIZZAZIONE",
  summary: "Contributo a fondo perduto per progetti di digitalizzazione delle PMI.",
  official_url: "https://www.pd.camcom.it/bandi/digitalizzazione",
  requirements: ["Sede in provincia di Padova"],
};

describe("isIndexOrLandingUrl", () => {
  it("rifiuta homepage, index, FAQ, newsletter e elenco /bandi", () => {
    expect(isIndexOrLandingUrl("https://www.invitalia.it/")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.gse.it/home")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.regione.veneto.it/faq")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.pd.camcom.it/newsletter")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.pd.camcom.it/bandi")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.pd.camcom.it/it/bandi")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.regione.veneto.it/web/attivita/elenco")).toBe(true);
    expect(isIndexOrLandingUrl("https://www.pd.camcom.it/index.php")).toBe(true);
    expect(classifyOfficialListingUrl("https://www.invitalia.it/")).toBe(
      "junk_listing",
    );
  });

  it("accetta una scheda avviso, non un indice", () => {
    expect(
      isIndexOrLandingUrl("https://www.pd.camcom.it/bandi/digitalizzazione-2026"),
    ).toBe(false);
    expect(classifyOfficialListingUrl(
      "https://www.regione.veneto.it/avvisi/bando-pmi-2026",
    )).toBe("candidate");
  });
});

describe("isJunkOpportunityContent", () => {
  it("rifiuta chrome video / newsletter / FAQ senza avviso", () => {
    expect(
      isJunkOpportunityContent(
        "Welcome. Your browser does not support the video tag. Iscriviti alla newsletter. Cookie. Privacy. ".repeat(8),
      ),
    ).toBe(true);
    expect(
      isJunkOpportunityContent(
        "FAQ — domande frequenti. Come iscriversi alla newsletter? Cookie policy. Chi siamo. ".repeat(8),
      ),
    ).toBe(true);
  });

  it("non scarta un avviso vero che incorpora un video", () => {
    expect(isJunkOpportunityContent(BANDO)).toBe(false);
    expect(
      isJunkOpportunityContent(
        `${BANDO}\nYour browser does not support the video tag.`,
      ),
    ).toBe(false);
  });
});

describe("collect gate — non persistire indici come opportunità", () => {
  it("homepage con voce Bandi nel menu non diventa opportunità", () => {
    const homepage = `
      Invitalia — home. Bandi e incentivi nel menu. Your browser does not support the video tag.
      Iscriviti alla newsletter. Cookie. Chi siamo. Contatti.
    `.repeat(6);
    expect(
      isEligibleOfficialOpportunity({
        officialUrl: "https://www.invitalia.it/",
        markdown: homepage,
      }),
    ).toBe(false);
    expect(
      localOpportunityDraft({
        markdown: homepage,
        officialUrl: "https://www.invitalia.it/",
        officialDomain: "invitalia.it",
      }),
    ).toBeNull();
  });

  it("un avviso su scheda dedicata resta ammissibile", () => {
    expect(
      isEligibleOfficialOpportunity({
        officialUrl: "https://www.regione.veneto.it/avvisi/bando-pmi-2026",
        markdown: BANDO,
      }),
    ).toBe(true);
    expect(
      localOpportunityDraft({
        markdown: BANDO,
        officialUrl: "https://www.regione.veneto.it/avvisi/bando-pmi-2026",
        officialDomain: "regione.veneto.it",
      })?.is_opportunity,
    ).toBe(true);
  });

  it("validateExtraction rifiuta evidence su homepage", () => {
    expect(
      validateExtraction(
        { ...VALID },
        "invitalia.it",
        "https://www.invitalia.it/",
      ),
    ).toEqual({ ok: false, code: "NOT_OPPORTUNITY" });
  });
});
