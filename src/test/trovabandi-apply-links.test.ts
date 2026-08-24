import { describe, expect, it } from "vitest";
import {
  extractApplyLinks,
  isLandingPageUrl,
  normalizeOfficialApplyUrl,
  resolveOfficialApplyUrls,
  shouldSkipApplyFetch,
  upgradeToHttps,
} from "../../supabase/functions/trovabandi-engine/apply-links.ts";

const OFFICIAL = "https://bandi.regione.veneto.it/avvisi/bando-pmi-2026";
const DOMAIN = "regione.veneto.it";

describe("extractApplyLinks", () => {
  it("page with labeled form and apply links → stored", () => {
    const html = `
      <h2>Modulistica</h2>
      <a href="/allegati/modulo-domanda.pdf">Modulo di domanda</a>
      <a href="https://bandi.regione.veneto.it/sportello/presenta-la-domanda">
        Presenta la domanda
      </a>
    `;
    expect(extractApplyLinks({ html, officialUrl: OFFICIAL, officialDomain: DOMAIN }))
      .toEqual({
        forms_url: "https://bandi.regione.veneto.it/allegati/modulo-domanda.pdf",
        application_url:
          "https://bandi.regione.veneto.it/sportello/presenta-la-domanda",
      });
  });

  it("page without form/apply links → null", () => {
    const html = `
      <p>Avviso pubblico per contributi alle PMI venete.</p>
      <a href="/documenti/decreto-approvazione.pdf">Decreto di approvazione</a>
      <a href="/contatti">Contatti</a>
    `;
    expect(extractApplyLinks({ html, officialUrl: OFFICIAL, officialDomain: DOMAIN }))
      .toEqual({ forms_url: null, application_url: null });
  });

  it("landing-page-only is not stored as modulistica", () => {
    const html = `
      <a href="https://www.invitalia.it/">Invitalia</a>
      <a href="https://www.invitalia.it/chi-siamo">Chi siamo</a>
      <a href="/">Home</a>
    `;
    expect(
      extractApplyLinks({
        html,
        officialUrl: "https://www.invitalia.it/",
        officialDomain: "invitalia.it",
      }),
    ).toEqual({ forms_url: null, application_url: null });
  });

  it("does not copy the official landing page into forms_url", () => {
    const html = `
      <a href="https://www.gse.it/">Modulistica</a>
      <a href="https://www.gse.it/it">Presenta la domanda</a>
    `;
    expect(
      extractApplyLinks({
        html,
        officialUrl: "https://www.gse.it/",
        officialDomain: "gse.it",
      }),
    ).toEqual({ forms_url: null, application_url: null });
  });

  it("resolves relative form URLs against the official page", () => {
    const html =
      '<a href="documenti/modulo-di-domanda.pdf">Modulo di domanda PDF</a>';
    expect(
      extractApplyLinks({ html, officialUrl: OFFICIAL, officialDomain: DOMAIN })
        .forms_url,
    ).toBe("https://bandi.regione.veneto.it/avvisi/documenti/modulo-di-domanda.pdf");
  });

  it("upgrades http apply links to https", () => {
    const html =
      '<a href="http://bandi.regione.veneto.it/sportello/presenta-la-domanda">Presenta la domanda</a>';
    expect(
      extractApplyLinks({ html, officialUrl: OFFICIAL, officialDomain: DOMAIN })
        .application_url,
    ).toBe("https://bandi.regione.veneto.it/sportello/presenta-la-domanda");
  });

  it("keeps only official-domain https links", () => {
    const html = `
      <a href="https://altro.comune.it/modulo-domanda.pdf">Modulo di domanda</a>
      <a href="https://bandi.regione.veneto.it/modulistica/bando-pmi">Modulistica</a>
    `;
    const out = extractApplyLinks({
      html,
      officialUrl: OFFICIAL,
      officialDomain: DOMAIN,
    });
    expect(out.forms_url).toBe(
      "https://bandi.regione.veneto.it/modulistica/bando-pmi",
    );
    expect(out.application_url).toBeNull();
  });

  it("reads markdown labels the same way", () => {
    const markdown = `
Avviso pubblico — bando contributi.
[Modulo di domanda](https://www.regione.veneto.it/bandi/modulo-domanda.pdf)
Presentazione domanda: https://www.regione.veneto.it/sportello-domanda
`;
    expect(
      extractApplyLinks({
        markdown,
        officialUrl: "https://www.regione.veneto.it/bandi/avviso",
        officialDomain: "regione.veneto.it",
      }),
    ).toEqual({
      forms_url: "https://www.regione.veneto.it/bandi/modulo-domanda.pdf",
      application_url: "https://www.regione.veneto.it/sportello-domanda",
    });
  });

  it("prefers a real PDF form over a marketing landing page", () => {
    const html = `
      <a href="https://www.invitalia.it/">Modulistica</a>
      <a href="/on/nuovo-impresa/modulo-domanda.pdf">Modulo di domanda</a>
    `;
    expect(
      extractApplyLinks({
        html,
        officialUrl: "https://www.invitalia.it/on/nuovo-impresa",
        officialDomain: "invitalia.it",
      }).forms_url,
    ).toBe("https://www.invitalia.it/on/nuovo-impresa/modulo-domanda.pdf");
  });
});

describe("resolveOfficialApplyUrls", () => {
  it("drops extracted landing pages and keeps a labeled PDF", () => {
    const resolved = resolveOfficialApplyUrls({
      html: '<a href="/moduli/modulo-domanda.pdf">Modulistica — modulo di domanda</a>',
      officialUrl: "https://www.invitalia.it/on/bando",
      officialDomain: "invitalia.it",
      extractedForms: "https://www.invitalia.it/",
      existingForms: "https://www.gse.it/",
    });
    expect(resolved.forms_url).toBe(
      "https://www.invitalia.it/moduli/modulo-domanda.pdf",
    );
  });

  it("keeps an existing real official form when the page has no new link", () => {
    const resolved = resolveOfficialApplyUrls({
      html: "<p>Avviso senza link di domanda.</p>",
      officialUrl: OFFICIAL,
      officialDomain: DOMAIN,
      existingForms:
        "https://bandi.regione.veneto.it/repository/modulo-partecipazione.pdf",
    });
    expect(resolved.forms_url).toBe(
      "https://bandi.regione.veneto.it/repository/modulo-partecipazione.pdf",
    );
    expect(resolved.application_url).toBeNull();
  });

  it("clears a stored homepage copy of official_url", () => {
    const resolved = resolveOfficialApplyUrls({
      markdown: "Homepage istituzionale Invitalia.",
      officialUrl: "https://www.invitalia.it/",
      officialDomain: "invitalia.it",
      existingForms: "https://www.invitalia.it/",
      extractedForms: "https://www.invitalia.it/",
    });
    expect(resolved).toEqual({ forms_url: null, application_url: null });
  });
});

describe("apply URL helpers", () => {
  it("upgrades http and rejects landing / off-domain", () => {
    expect(upgradeToHttps("http://bandi.regione.veneto.it/x")).toBe(
      "https://bandi.regione.veneto.it/x",
    );
    expect(isLandingPageUrl("https://www.invitalia.it/", "https://www.invitalia.it/"))
      .toBe(true);
    expect(
      normalizeOfficialApplyUrl(
        "https://altroente.it/modulo.pdf",
        DOMAIN,
        OFFICIAL,
      ),
    ).toBeNull();
  });

  it("does not fetch BUR FVG (known hang)", () => {
    expect(shouldSkipApplyFetch("https://bur.regione.fvg.it/newbur/")).toBe(true);
    expect(shouldSkipApplyFetch(OFFICIAL)).toBe(false);
  });

  it("does not fetch Bandiora", () => {
    expect(shouldSkipApplyFetch("https://www.bandiora.it/bando")).toBe(true);
  });
});
