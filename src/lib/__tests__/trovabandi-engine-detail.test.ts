import { describe, expect, it } from "vitest";
import {
  extractDetailLinks,
  mergeDetailIntoExtraction,
  needsDetailEnrichment,
  parseAmounts,
  parseDeadline,
} from "../../../supabase/functions/trovabandi-engine/detail";

const NOW = new Date("2026-08-11T00:00:00Z");

describe("UEradar — selezione dei link di dettaglio", () => {
  const html = `
    <a href="/bandi/avviso-2026/scadenze">Bando 2026 — termini e scadenze</a>
    <a href="/documenti/decreto.pdf">Decreto di approvazione</a>
    <a href="https://www.facebook.com/regione">Seguici su Facebook</a>
    <a href="/privacy">Privacy policy</a>
    <a href="https://altrodominio.it/bando">Bando esterno</a>
    <a href="/contatti">Contatti</a>
  `;

  it("tiene solo link dello stesso dominio ufficiale, ordinati per pertinenza", () => {
    const links = extractDetailLinks(
      html,
      "https://bandi.regione.marche.it/elenco",
      "regione.marche.it",
    );
    expect(links.map((l) => l.url)).toEqual([
      "https://bandi.regione.marche.it/bandi/avviso-2026/scadenze",
      "https://bandi.regione.marche.it/documenti/decreto.pdf",
    ]);
  });

  it("scarta dominio esterno, social, privacy e la pagina di partenza", () => {
    const links = extractDetailLinks(
      html,
      "https://bandi.regione.marche.it/elenco",
      "regione.marche.it",
      { limit: 10 },
    );
    const urls = links.map((l) => l.url).join(" ");
    expect(urls).not.toContain("altrodominio.it");
    expect(urls).not.toContain("facebook");
    expect(urls).not.toContain("/privacy");
    expect(urls).not.toContain("/contatti");
  });

  it("esclude gli URL già letti e rispetta il limite", () => {
    const links = extractDetailLinks(
      html,
      "https://bandi.regione.marche.it/elenco",
      "regione.marche.it",
      {
        limit: 1,
        exclude: ["https://bandi.regione.marche.it/bandi/avviso-2026/scadenze"],
      },
    );
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain("decreto.pdf");
  });

  it("non estrae nulla da HTML vuoto", () => {
    expect(extractDetailLinks("", "https://x.regione.marche.it", "regione.marche.it")).toEqual([]);
  });
});

describe("UEradar — scadenza da testo ufficiale", () => {
  it("accetta una data con contesto esplicito di scadenza", () => {
    const hit = parseDeadline(
      "Le domande devono essere presentate entro il 09 ottobre 2026 ore 17:00 tramite portale.",
      NOW,
    );
    expect(hit?.value).toBe("2026-10-09T17:00:00.000Z");
    expect(hit?.confidence).toBe("alta");
    expect(hit?.evidence).toContain("entro il 09 ottobre 2026");
  });

  it("accetta il formato numerico con la parola scadenza", () => {
    const hit = parseDeadline("Scadenza presentazione domande: 04/10/2026", NOW);
    expect(hit?.value).toBe("2026-10-04T23:59:00.000Z");
  });

  it("rifiuta una data di pubblicazione senza contesto di termine", () => {
    expect(
      parseDeadline("Pubblicato il 30.07.2026 sul BUR regionale n. 55", NOW),
    ).toBeNull();
  });

  it("rifiuta date fuori finestra plausibile", () => {
    expect(parseDeadline("Scadenza: 01/01/2020", NOW)).toBeNull();
    expect(parseDeadline("Scadenza: 01/01/2099", NOW)).toBeNull();
  });

  it("preferisce la scadenza più vicina tra più termini", () => {
    const hit = parseDeadline(
      "Scadenza primo sportello 30/09/2026. Termine ultimo 20/12/2026.",
      NOW,
    );
    expect(hit?.value).toBe("2026-09-30T23:59:00.000Z");
  });
});

describe("UEradar — importi da testo ufficiale", () => {
  it("riconosce il contributo massimo", () => {
    const amounts = parseAmounts(
      "Il contributo massimo concedibile è pari a euro 50.000,00 per impresa.",
    );
    expect(amounts.max_grant_amount?.value).toBe(50000);
    expect(amounts.total_budget).toBeUndefined();
  });

  it("riconosce la dotazione complessiva", () => {
    const amounts = parseAmounts(
      "La dotazione finanziaria complessiva dell'avviso è di 2.500.000 euro.",
    );
    expect(amounts.total_budget?.value).toBe(2500000);
    expect(amounts.max_grant_amount).toBeUndefined();
  });

  it("ignora soglie di ammissibilità e volumi d'affari", () => {
    const amounts = parseAmounts(
      "Sono ammesse imprese con volume d'affari non superiore a 500.000 euro e investimento massimo di 145.000 euro.",
    );
    expect(amounts.max_grant_amount).toBeUndefined();
    expect(amounts.total_budget).toBeUndefined();
  });

  it("scarta valori fuori range", () => {
    expect(parseAmounts("contributo massimo 12 euro").max_grant_amount).toBeUndefined();
  });
});

describe("UEradar — merge fail-closed", () => {
  it("richiede il dettaglio solo se manca scadenza o ogni importo", () => {
    expect(needsDetailEnrichment({ deadline_at: null, max_grant_amount: 1 })).toBe(true);
    expect(
      needsDetailEnrichment({ deadline_at: "2026-10-01T00:00:00Z", max_grant_amount: null, total_budget: null }),
    ).toBe(true);
    expect(
      needsDetailEnrichment({ deadline_at: "2026-10-01T00:00:00Z", total_budget: 1000 }),
    ).toBe(false);
  });

  it("riempie solo i campi nulli e non sovrascrive mai", () => {
    const merged = mergeDetailIntoExtraction(
      { deadline_at: "2026-09-01T00:00:00Z", max_grant_amount: null, total_budget: null },
      {
        deadline: { value: "2026-12-31T23:59:00.000Z", evidence: "x", confidence: "alta" },
        amounts: {
          max_grant_amount: { value: 50000, evidence: "y", confidence: "alta" },
        },
      },
    );
    expect(merged.patch).toEqual({ max_grant_amount: 50000 });
    expect(merged.filled).toEqual(["max_grant_amount"]);
  });

  it("non produce patch senza valori di dettaglio", () => {
    const merged = mergeDetailIntoExtraction(
      { deadline_at: null, max_grant_amount: null, total_budget: null },
      { deadline: null, amounts: {} },
    );
    expect(merged.patch).toEqual({});
    expect(merged.filled).toEqual([]);
  });
});

describe("UEradar — forme inglesi (fonti UE)", () => {
  it("accetta 'deadline' con data ISO", () => {
    const hit = parseDeadline("Submission deadline: 2026-10-09 at 17:00 CET", NOW);
    expect(hit?.value).toBe("2026-10-09T17:00:00.000Z");
    expect(hit?.confidence).toBe("alta");
  });

  it("accetta '9 October 2026' con closing date", () => {
    const hit = parseDeadline("The closing date for applications is 9 October 2026.", NOW);
    expect(hit?.value).toBe("2026-10-09T23:59:00.000Z");
  });

  it("accetta 'October 9, 2026' con no later than", () => {
    const hit = parseDeadline("Proposals must be submitted no later than October 9, 2026.", NOW);
    expect(hit?.value).toBe("2026-10-09T23:59:00.000Z");
  });

  it("rifiuta una data inglese senza contesto di termine", () => {
    expect(parseDeadline("Published on 30 July 2026 in the Official Journal.", NOW)).toBeNull();
  });

  it("riconosce maximum grant in formato inglese", () => {
    const amounts = parseAmounts("The maximum grant per project is EUR 50,000.");
    expect(amounts.max_grant_amount?.value).toBe(50000);
    expect(amounts.total_budget).toBeUndefined();
  });

  it("riconosce total budget e endowment", () => {
    expect(parseAmounts("The total budget of the call is EUR 2,500,000.00.").total_budget?.value).toBe(2500000);
    expect(parseAmounts("The endowment amounts to 1,000,000 EUR.").total_budget?.value).toBe(1000000);
  });

  it("ignora importi inglesi senza contesto qualificante", () => {
    const amounts = parseAmounts("Applicants with a turnover below EUR 500,000 are eligible.");
    expect(amounts.max_grant_amount).toBeUndefined();
    expect(amounts.total_budget).toBeUndefined();
  });
});

describe("importi scritti a parole", () => {
  it("legge la dotazione in milioni (IT)", () => {
    const out = parseAmounts("Dotazione finanziaria complessiva: 5 milioni di euro.");
    expect(out.total_budget?.value).toBe(5_000_000);
  });
  it("legge il budget in million (EN, valuta prefissa)", () => {
    const out = parseAmounts("With a total budget of €197 million, the initiative...");
    expect(out.total_budget?.value).toBe(197_000_000);
  });
  it("legge il contributo massimo con decimale", () => {
    const out = parseAmounts("Il contributo massimo concedibile è pari a 1,5 milioni di euro.");
    expect(out.max_grant_amount?.value).toBe(1_500_000);
  });
  it("legge mld/bn", () => {
    expect(parseAmounts("dotazione: EUR 2 bn").total_budget?.value).toBe(2_000_000_000);
    expect(parseAmounts("risorse stanziate pari a 1,2 mld di euro").total_budget?.value).toBe(1_200_000_000);
  });
  it("ignora numeri a parole senza valuta", () => {
    expect(parseAmounts("dotazione di 5 milioni di ore di formazione")).toEqual({});
  });
  it("legge 4 milioni e 1,5 mln accanto a contributo massimo", () => {
    expect(parseAmounts("Il contributo massimo è pari a 4 milioni.").max_grant_amount?.value)
      .toBe(4_000_000);
    expect(parseAmounts("contributo massimo 1,5 mln").max_grant_amount?.value)
      .toBe(1_500_000);
  });
  it("ignora importi a parole senza contesto qualificante", () => {
    expect(parseAmounts("il fatturato aziendale supera i 10 milioni di euro")).toEqual({});
  });
  it("ignora 'mila' sotto la soglia minima", () => {
    expect(parseAmounts("dotazione di 0,5 mila euro")).toEqual({});
  });
});
