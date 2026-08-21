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
      [
        "dl.camcom.it",
        "https://www.dl.camcom.it/sonoimpresa/cosa-puo-servire-sono/incentivi-ed-agevolazioni",
      ],
      ["tb.camcom.gov.it", "https://www.tb.camcom.gov.it/bandi.asp"],
    ];
    for (const [domain, listing] of samples) {
      expect(seedListingUrls(domain)).toContain(listing);
      expect(isSameDomainHttpsUrl(listing, domain)).toBe(true);
    }
  });

  it("copre ogni Camera Nord-Toscana dell'elenco Unioncamere con almeno un listing", () => {
    const unioncamereNordToscana = [
      "ao.camcom.it",
      "aa.camcom.it",
      "cn.camcom.it",
      "pno.camcom.it",
      "to.camcom.it",
      "bg.camcom.it",
      "bs.camcom.it",
      "comolecco.camcom.it",
      "cmp.camcom.it",
      "milomb.camcom.it",
      "so.camcom.it",
      "va.camcom.it",
      "pd.camcom.it",
      "vi.camcom.it",
      "tb.camcom.gov.it",
      "dl.camcom.it",
      "vr.camcom.it",
      "pnud.camcom.it",
      "vg.camcom.it",
      "camcom.bz.it",
      "tn.camcom.it",
      "ge.camcom.gov.it",
      "rivlig.camcom.gov.it",
      "bo.camcom.gov.it",
      "emilia.camcom.it",
      "fera.camcom.it",
      "mo.camcom.it",
      "romagna.camcom.it",
      "fi.camcom.gov.it",
      "as.camcom.it",
      "ptpo.camcom.it",
      "tno.camcom.it",
      "lg.camcom.it",
    ];
    for (const domain of unioncamereNordToscana) {
      expect(seedListingUrls(domain).length).toBeGreaterThan(0);
    }
  });

  it("espone BUR, provincia/CM e GAL Nord-Toscana sullo stesso dominio ufficiale", () => {
    const samples: Array<[string, string]> = [
      [
        "regione.piemonte.it",
        "https://www.regione.piemonte.it/governo/bollettino/abbonati/2026/corrente",
      ],
      [
        "regione.lombardia.it",
        "https://www.regione.lombardia.it/burl-bollettino-ufficiale-regione-lombardia",
      ],
      ["burl.it", "https://www.burl.it/"],
      ["bur.regione.fvg.it", "https://bur.regione.fvg.it/newbur/"],
      [
        "cittametropolitana.ve.it",
        "https://www.cittametropolitana.ve.it/amministrazione-trasparente/sovvenzioni-contributi-sussidi-vantaggi-economici",
      ],
      [
        "trasparenza.cittametropolitana.torino.it",
        "https://trasparenza.cittametropolitana.torino.it/sovvenzioni-contributi-sussidi-vantaggi-economici",
      ],
      [
        "cittametropolitana.mi.it",
        "https://www.cittametropolitana.mi.it/citta-metropolitana/amministrazione-trasparente/sovvenzioni_contributi_sussidi_vantaggi_economici/",
      ],
      [
        "web.provincia.vr.it",
        "https://web.provincia.vr.it/it/servizi/contributi-e-patrocini",
      ],
      [
        "provincia.como.it",
        "https://www.provincia.como.it/bandi-di-contributi",
      ],
      [
        "amministrazionetrasparente.provincia.pc.it",
        "https://amministrazionetrasparente.provincia.pc.it/L190/?idSezione=20&id=&sort=&activePage=&search=",
      ],
      ["galaltobellunese.com", "https://www.galaltobellunese.com/bandi/"],
      ["galdeltapo.it", "https://galdeltapo.it/bandi/"],
      ["montagnappennino.it", "https://www.montagnappennino.it/bandi/"],
      ["sviluppolunigiana.it", "https://www.sviluppolunigiana.it/bandi/"],
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
