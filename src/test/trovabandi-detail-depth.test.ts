import { describe, expect, it } from "vitest";
import {
  collectDetailTargets,
  extractDetailLinks,
  extractDetailLinksFromMarkdown,
  parseAmounts,
  parseDeadline,
  scoreDetailCandidate,
} from "../../supabase/functions/trovabandi-engine/detail.ts";

const BASE = "https://bandi.regione.veneto.it/elenco";
const DOMAIN = "regione.veneto.it";
const NOW = new Date("2026-08-11T00:00:00Z");

describe("TrovaBandi — ranking dei candidati di dettaglio", () => {
  it("mette il PDF allegato sopra una pagina generica 'approfondisci'", () => {
    const html = `
      <a href="/approfondisci">Approfondisci</a>
      <a href="/docs/allegato-bando.pdf">Allegato PDF del bando</a>
    `;
    const links = extractDetailLinks(html, BASE, DOMAIN);
    expect(links[0]?.url).toBe(
      "https://bandi.regione.veneto.it/docs/allegato-bando.pdf",
    );
    expect(links.map((link) => link.url).join(" ")).toContain("approfondisci");
    expect(links[0]!.score).toBeGreaterThan(
      links.find((link) => link.url.includes("approfondisci"))!.score,
    );
  });
});

describe("TrovaBandi — markdown e path relativi", () => {
  it("scopre un https nudo all'allegato PDF", () => {
    const markdown =
      "Documentazione: https://bandi.regione.veneto.it/allegato-bando.pdf";
    const links = extractDetailLinksFromMarkdown(markdown, BASE, DOMAIN);
    expect(links.map((link) => link.url)).toContain(
      "https://bandi.regione.veneto.it/allegato-bando.pdf",
    );
  });

  it("risolve /docs/avviso.pdf rispetto al baseUrl", () => {
    const markdown = "Il testo ufficiale è pubblicato in /docs/avviso.pdf";
    const links = extractDetailLinksFromMarkdown(markdown, BASE, DOMAIN);
    expect(links.map((link) => link.url)).toContain(
      "https://bandi.regione.veneto.it/docs/avviso.pdf",
    );
  });

  it("esclude privacy e facebook", () => {
    const html = `
      <a href="/privacy">Privacy policy</a>
      <a href="https://www.facebook.com/regione.veneto">Facebook</a>
      <a href="/docs/avviso.pdf">Avviso PDF</a>
    `;
    const markdown =
      "Seguici su https://www.facebook.com/regione.veneto e leggi /privacy";
    const targets = collectDetailTargets({
      html,
      markdown,
      baseUrl: BASE,
      officialDomain: DOMAIN,
    });
    const joined = targets.join(" ");
    expect(joined).not.toContain("privacy");
    expect(joined).not.toContain("facebook");
    expect(targets).toContain("https://bandi.regione.veneto.it/docs/avviso.pdf");
  });
});

describe("TrovaBandi — collectDetailTargets", () => {
  it("preferisce il PDF di avviso dichiarato", () => {
    const html = `
      <a href="/approfondisci">Approfondisci</a>
      <a href="/scheda">Scheda del bando</a>
    `;
    const targets = collectDetailTargets({
      html,
      markdown: "Vedi anche https://bandi.regione.veneto.it/approfondisci",
      baseUrl: BASE,
      officialDomain: DOMAIN,
      declared: ["https://bandi.regione.veneto.it/avviso-2026.pdf"],
    });
    expect(targets[0]).toBe("https://bandi.regione.veneto.it/avviso-2026.pdf");
  });
});

describe("TrovaBandi — parseDeadline fail-closed", () => {
  it("restituisce null senza contesto di scadenza", () => {
    expect(parseDeadline("Pubblicato il 15/09/2026 sul BUR", NOW)).toBeNull();
  });

  it("con 'Scadenza 15/09/2026' restituisce una data ISO", () => {
    const hit = parseDeadline("Scadenza 15/09/2026", NOW);
    expect(hit?.value).toMatch(/^2026-09-15T/);
  });
});

describe("TrovaBandi — parseAmounts distingue contributo e dotazione", () => {
  it("assegna contributo massimo e non la dotazione", () => {
    const amounts = parseAmounts(
      "Il contributo massimo concedibile è pari a 50.000 euro per impresa.",
    );
    expect(amounts.max_grant_amount?.value).toBe(50000);
    expect(amounts.total_budget).toBeUndefined();
  });

  it("assegna la dotazione e non il contributo massimo", () => {
    const amounts = parseAmounts(
      "La dotazione finanziaria complessiva dell'avviso è di 2.500.000 euro.",
    );
    expect(amounts.total_budget?.value).toBe(2500000);
    expect(amounts.max_grant_amount).toBeUndefined();
  });
});

describe("TrovaBandi — allegati Veneto Download?idAllegato=", () => {
  it("mette disposizioni operative prima di moduli e schede sintetiche", () => {
    const html = `
      <a href="/Public/Download?idAllegato=33549">Scheda sintetica Sezione Start Up</a>
      <a href="/Public/Download?idAllegato=31590">Modulo di domanda</a>
      <a href="/Public/Download?idAllegato=31582">Disposizioni operative Start up</a>
    `;
    const links = extractDetailLinks(html, BASE, DOMAIN);
    expect(links[0]?.url).toContain("idAllegato=31582");
    const disp = scoreDetailCandidate(
      "Disposizioni operative Start up https://bandi.regione.veneto.it/Public/Download?idAllegato=31582",
    );
    const modulo = scoreDetailCandidate(
      "Modulo di domanda https://bandi.regione.veneto.it/Public/Download?idAllegato=31590",
    );
    expect(disp).toBeGreaterThan(modulo);
  });
});
