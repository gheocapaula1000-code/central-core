import { describe, expect, it } from "vitest";
import {
  extractSameDomainLinks,
  isSameDomainHttpsUrl,
  seedListingUrls,
} from "../../../supabase/functions/trovabandi-engine/seed.ts";

const DOMAIN = "provincia.pd.it";
const SEED =
  "https://www.provincia.pd.it/sovvenzioni-contributi-sussidi-vantaggi-economici";

describe("trovabandi seed listing", () => {
  it("espone solo pagine seed verificate per i domini ufficiali", () => {
    expect(seedListingUrls(DOMAIN)).toEqual([SEED]);
    expect(seedListingUrls("www.padovanet.it")).toEqual([
      "https://www.padovanet.it",
    ]);
    expect(seedListingUrls("bandi.gov.it")).toEqual([]);
  });

  it("espone listing bandi camerali Nord-Toscana sullo stesso dominio ufficiale", () => {
    const samples: Array<[string, string]> = [
      ["to.camcom.it", "https://www.to.camcom.it/finanziamenti-bandi-e-contributi"],
      ["milomb.camcom.it", "https://www.milomb.camcom.it/contributi-e-finanziamenti"],
      ["bo.camcom.gov.it", "https://www.bo.camcom.gov.it/it/promozione-interna/contributi"],
      ["fi.camcom.gov.it", "https://www.fi.camcom.gov.it/bandi"],
      ["vr.camcom.it", "https://www.vr.camcom.it/promuovere-impresa-e-territorio/contributi-e-patrocini"],
      ["vg.camcom.it", "https://vg.camcom.it/contributi-e-agevolazioni"],
    ];
    for (const [domain, listing] of samples) {
      expect(seedListingUrls(domain)).toContain(listing);
      expect(isSameDomainHttpsUrl(listing, domain)).toBe(true);
    }
  });

  it("scarta URL fuori dominio o non https", () => {
    expect(isSameDomainHttpsUrl(SEED, DOMAIN)).toBe(true);
    expect(
      isSameDomainHttpsUrl("https://sub.provincia.pd.it/bando", DOMAIN),
    ).toBe(true);
    expect(isSameDomainHttpsUrl("https://bandi.gov.it/x", DOMAIN)).toBe(false);
    expect(isSameDomainHttpsUrl("http://www.provincia.pd.it/x", DOMAIN)).toBe(
      false,
    );
    expect(isSameDomainHttpsUrl("non-un-url", DOMAIN)).toBe(false);
  });

  it("estrae dai link solo quelli ufficiali dello stesso dominio", () => {
    const html = `
      <a href="/bandi/contributi-imprese-2026">Contributi</a>
      <a href="https://www.provincia.pd.it/avviso-2026">Avviso</a>
      <a href="https://facebook.com/provinciapd">Social</a>
      <a href="mailto:info@provincia.pd.it">Mail</a>
      <a href="http://www.provincia.pd.it/insicuro">Insicuro</a>
    `;
    const links = extractSameDomainLinks(html, SEED, DOMAIN);
    expect(links).toEqual([
      "https://www.provincia.pd.it/bandi/contributi-imprese-2026",
      "https://www.provincia.pd.it/avviso-2026",
    ]);
  });

  it("estrae anche dai link markdown restituiti da Firecrawl", () => {
    const markdown =
      "[Bando](https://www.provincia.pd.it/bando-a) e [fuori](https://altro.it/b)";
    expect(extractSameDomainLinks(markdown, SEED, DOMAIN)).toEqual([
      "https://www.provincia.pd.it/bando-a",
    ]);
  });

  it("una pagina senza link ufficiali non produce candidati inventati", () => {
    expect(extractSameDomainLinks("<p>nessun link</p>", SEED, DOMAIN)).toEqual(
      [],
    );
    expect(extractSameDomainLinks("", SEED, DOMAIN)).toEqual([]);
  });
});
