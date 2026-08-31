// UEradar — estrattori locali high-confidence dell'azione "backfill_nulls".
// Vivono in supabase/functions/trovabandi-engine/index.ts (runtime Deno):
// li isoliamo dalla sorgente reale per testarne il comportamento effettivo.

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const ENGINE = readFileSync(
  "supabase/functions/trovabandi-engine/index.ts",
  "utf8",
);

const start = ENGINE.indexOf("// BACKFILL_HELPERS_START");
const end = ENGINE.indexOf("// BACKFILL_HELPERS_END");
expect(start).toBeGreaterThan(-1);
expect(end).toBeGreaterThan(start);

// Il modulo temporaneo conserva i tipi originali: la sorgente reale viene
// transpilata da Vitest, senza riscritture manuali che ne altererebbero la logica.
const TMP = "src/test/.trovabandi-backfill-helpers.generated.ts";
writeFileSync(
  TMP,
  `${ENGINE.slice(start, end)}\nexport { localExtractDeadline, localExtractAmounts, isCookieConsentShell };\n`,
);

const helpers = (await import(
  /* @vite-ignore */ `./.trovabandi-backfill-helpers.generated.ts?t=${Date.now()}`
)) as {
  localExtractDeadline: (markdown: string) => string | null;
  localExtractAmounts: (markdown: string) => {
    min_grant_amount?: number;
    max_grant_amount?: number;
    total_budget?: number;
  };
  isCookieConsentShell: (markdown: string) => boolean;
};
rmSync(TMP, { force: true });

const { localExtractDeadline, localExtractAmounts, isCookieConsentShell } = helpers;

describe("localExtractDeadline", () => {
  it("estrae la data italiana in lettere", () => {
    expect(localExtractDeadline("Scadenza: 15 settembre 2026")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("estrae la data inglese ordinale", () => {
    expect(localExtractDeadline("Deadline 15th September 2026")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("estrae la data numerica vicino a keyword", () => {
    expect(localExtractDeadline("Termine: 01/03/2027")).toBe(
      "2027-03-01T00:00:00.000Z",
    );
  });

  it("estrae la data dopo 'termine ultimo'", () => {
    expect(localExtractDeadline("Termine ultimo 30 settembre 2026")).toBe(
      "2026-09-30T00:00:00.000Z",
    );
  });

  it("estrae la data numerica dopo 'scadenza il'", () => {
    expect(localExtractDeadline("scadenza il 15/09/2026")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("estrae la scadenza discorsiva con 'entro e non oltre le ore'", () => {
    expect(
      localExtractDeadline(
        "Le domande devono essere trasmesse entro e non oltre le ore 12:00 del 30 settembre 2026, pena l'esclusione.",
      ),
    ).toBe("2026-09-30T00:00:00.000Z");
  });

  it("estrae la chiusura sportello con data numerica puntata", () => {
    expect(
      localExtractDeadline("Chiusura dello sportello: 15.12.2026 ore 17:00"),
    ).toBe("2026-12-15T00:00:00.000Z");
  });

  it("estrae il termine di presentazione delle domande", () => {
    expect(
      localExtractDeadline(
        "Termine di presentazione delle domande: 7 gennaio 2027",
      ),
    ).toBe("2027-01-07T00:00:00.000Z");
  });

  it("preferisce la scadenza all'apertura quando compaiono entrambe", () => {
    expect(
      localExtractDeadline(
        "Lo sportello apre a partire dal 1 marzo 2026. Le domande si presentano entro il 30 aprile 2026.",
      ),
    ).toBe("2026-04-30T00:00:00.000Z");
  });

  it("estrae il formato inglese 'September 15, 2026'", () => {
    expect(
      localExtractDeadline("Submission deadline: September 15, 2026"),
    ).toBe("2026-09-15T00:00:00.000Z");
  });

  it("ignora una data valida citata come pubblicazione", () => {
    expect(
      localExtractDeadline(
        "Decreto pubblicato il 12/01/2026 sul Bollettino Ufficiale.",
      ),
    ).toBeNull();
  });

  it("restituisce null senza keyword di scadenza", () => {
    expect(
      localExtractDeadline("Il bando è stato pubblicato il 15 settembre 2026"),
    ).toBeNull();
  });

  it("restituisce null su testo cortissimo", () => {
    expect(localExtractDeadline("bando")).toBeNull();
  });

  it("restituisce null su anni fuori finestra", () => {
    expect(localExtractDeadline("Scadenza: 15 settembre 2099")).toBeNull();
  });

  it("non inventa una scadenza su sportello senza chiusura", () => {
    expect(
      localExtractDeadline(
        "Le domande sono valutate a sportello fino a esaurimento delle risorse. Il contributo massimo è pari a 80.000 euro.",
      ),
    ).toBeNull();
    expect(
      localExtractDeadline(
        "L'avviso non ha scadenza e resta aperto alle imprese del territorio.",
      ),
    ).toBeNull();
  });
});

describe("localExtractAmounts", () => {
  it("estrae l'importo massimo con separatore di migliaia", () => {
    expect(localExtractAmounts("Contributo fino a 500.000 euro")).toMatchObject(
      { max_grant_amount: 500000 },
    );
  });

  it("estrae la dotazione espressa in milioni", () => {
    expect(
      localExtractAmounts("Il bando ha una dotazione di 2 milioni di euro"),
    ).toMatchObject({ total_budget: 2000000 });
  });

  it("estrae gli importi espressi in 'mila'", () => {
    expect(localExtractAmounts("Agevolazione fino a 50 mila euro"))
      .toMatchObject({ max_grant_amount: 50000 });
  });

  it("estrae la dotazione finanziaria con virgola italiana", () => {
    expect(
      localExtractAmounts(
        "La dotazione finanziaria è di 356,4 milioni di euro.",
      ),
    ).toMatchObject({ total_budget: 356400000 });
  });

  it("estrae il massimale espresso in milioni con virgola", () => {
    expect(localExtractAmounts("Contributo massimo 2,5 milioni di euro"))
      .toMatchObject({ max_grant_amount: 2500000 });
  });

  it("estrae 'fino a 500 mila euro'", () => {
    expect(localExtractAmounts("Agevolazione fino a 500 mila euro"))
      .toMatchObject({ max_grant_amount: 500000 });
  });

  it("estrae la dotazione finanziaria complessiva discorsiva", () => {
    expect(
      localExtractAmounts(
        "La dotazione finanziaria complessiva è pari a 356,4 milioni di euro a valere sul programma.",
      ),
    ).toMatchObject({ total_budget: 356400000 });
  });

  it("estrae il contributo massimo concedibile con centesimi", () => {
    expect(
      localExtractAmounts(
        "Il contributo massimo concedibile è pari a € 250.000,00 per impresa.",
      ),
    ).toMatchObject({ max_grant_amount: 250000 });
  });

  it("estrae minimo e massimo nella stessa frase", () => {
    expect(
      localExtractAmounts(
        "Investimento non inferiore a 50.000 euro e contributo massimo di 1,5 mln di euro.",
      ),
    ).toMatchObject({ min_grant_amount: 50000, max_grant_amount: 1500000 });
  });

  it("estrae importi scritti a parole", () => {
    expect(
      localExtractAmounts("Lo stanziamento è di cinque milioni di euro."),
    ).toMatchObject({ total_budget: 5000000 });
  });

  it("estrae 'sino a' con simbolo euro anteposto", () => {
    expect(localExtractAmounts("Agevolazione sino a € 80.000")).toMatchObject({
      max_grant_amount: 80000,
    });
  });

  it("non attribuisce importi senza keyword qualificante", () => {
    expect(
      localExtractAmounts("Il decreto n. 120.000 del 2026 approva il bando."),
    ).toEqual({});
  });

  it("non inventa importi su testo senza cifre", () => {
    expect(localExtractAmounts("Bando per imprese del territorio")).toEqual({});
  });
});

describe("backfill_nulls idle budget (source contract)", () => {
  it("caps the loop under the 150s Lovable idle timeout and breaks truncated", () => {
    const start = ENGINE.indexOf('if (action === "backfill_nulls")');
    const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const src = ENGINE.slice(start, end);
    expect(ENGINE).toContain("BACKFILL_BUDGET_MS = 110_000");
    expect(src).toContain("BACKFILL_BUDGET_MS");
    expect(src).toMatch(/Date\.now\(\)\s*>=\s*deadline/);
    expect(src).toContain("truncated = true");
    expect(src).toContain("break");
    expect(src).toContain("remaining: truncated ? rows.length - attempted : 0");
    expect(src).toContain("trigger_source: triggerSource");
    expect(110_000).toBeLessThan(150_000);
  });
});

const COOKIE_BANNER = `
Resto al Sud 2.0 | Invitalia
Questo sito utilizza cookie. Accetta tutti i cookie oppure Rifiuta.
Utilizziamo cookie tecnici e, previo consenso, cookie di profilazione.
Banner cookie: per proseguire scegli Accetta o Rifiuta.
Informativa cookie. Gestisci le preferenze. Cookie policy.
Scadenza: 15 settembre 2026. Contributo fino a 500.000 euro.
`.repeat(3);

describe("cookie consent shells are not official evidence", () => {
  it("riconosce banner Accetta/Rifiuta/cookie tecnici", () => {
    expect(isCookieConsentShell(COOKIE_BANNER)).toBe(true);
    expect(
      isCookieConsentShell(
        "Le domande devono essere trasmesse entro e non oltre le ore 12:00 del 30 settembre 2026. Contributo massimo 80.000 euro.",
      ),
    ).toBe(false);
    expect(
      isCookieConsentShell(
        "Avviso pubblico per la concessione di contributi a fondo perduto. " +
          "Le domande si presentano entro il 30 settembre 2026. Il contributo massimo e pari a 80.000 euro. " +
          "Dotazione finanziaria complessiva di 2 milioni di euro. Requisiti PMI e sede in Italia. ".repeat(8) +
          " Questo sito utilizza cookie. Accetta. Rifiuta.",
      ),
    ).toBe(false);
  });

  it("non estrae date o importi dal markdown del cookie banner", () => {
    expect(localExtractDeadline(COOKIE_BANNER)).toBeNull();
    expect(localExtractAmounts(COOKIE_BANNER)).toEqual({});
  });
});

describe("backfill_nulls rotates empty scrapes (source contract)", () => {
  it("bumps last_seen_at on empty/cookie/BAD_URL/NO_NEW_VALUES without inventing fields", () => {
    const start = ENGINE.indexOf('if (action === "backfill_nulls")');
    const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = ENGINE.slice(start, end);
    expect(body).toContain("rotateQueueCursor");
    expect(body).toContain("isCookieConsentShell");
    expect(body).toContain("last_seen_at: nowIso");
    expect(body).toContain("updated_at: nowIso");
    expect(body).toContain('await rotateQueueCursor(row.id, "SCRAPE_EMPTY")');
    expect(body).toContain('await rotateQueueCursor(row.id, "BAD_URL")');
    expect(body).toContain('await rotateQueueCursor(row.id, "NO_NEW_VALUES")');
    expect(ENGINE).toMatch(/\\baccetta\\b/);
    expect(ENGINE).toMatch(/\\brifiuta\\b/);
    expect(ENGINE).toContain("cookie tecnici");
    expect(ENGINE).toMatch(/\\bbanner\\b/);
    const touchStart = body.indexOf("const touch =");
    const touchEnd = body.indexOf("if (dryRun)");
    expect(touchStart).toBeGreaterThan(-1);
    expect(touchEnd).toBeGreaterThan(touchStart);
    const touch = body.slice(touchStart, touchEnd);
    expect(touch).toContain("last_seen_at");
    expect(touch).toContain("updated_at");
    expect(touch).not.toContain("deadline_at");
    expect(touch).not.toContain("min_grant_amount");
    expect(touch).not.toContain("max_grant_amount");
    expect(touch).not.toContain("region");
  });
});

describe("backfill_nulls 546 memory (source contract)", () => {
  it("keeps BACKFILL_BUDGET_MS and sequential per-row, releases page bodies", () => {
    expect(ENGINE).toContain("BACKFILL_BUDGET_MS = 110_000");
    const start = ENGINE.indexOf('if (action === "backfill_nulls")');
    const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = ENGINE.slice(start, end);
    expect(body).toContain("for (const row of rows)");
    expect(body).not.toContain("Promise.all");
    expect(body).toContain("releaseLoadedPageBodies(page, { markdown: true })");
    expect(body).toContain("delete logged.raw_excerpt");
    expect(ENGINE).toContain("releaseLoadedPageBodies(detail, { markdown: true })");
    expect(ENGINE).toContain("DETAIL_MAX_FETCH_PER_HIT = 20");
    expect(ENGINE).toContain("DETAIL_MAX_HOPS = 6");
    expect(body).not.toContain("scrapePage(");
    expect(body).not.toContain("apifyScrape(");
    expect(body).toContain("directOfficialScrape");
    expect(body).toContain("allow_paid_extract");
    expect(body).toContain("allow_paid_scrape");
    expect(body).toContain("loadPage(");
    expect(body).toContain("createPaidBudget(allowPaidScrape)");
    expect(body).toContain("fallbackPaidOfficialPage");
  });

  it("still fail-closed: rotate only last_seen_at/updated_at, never invent deadline/importo/geo", () => {
    const start = ENGINE.indexOf('if (action === "backfill_nulls")');
    const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
    const body = ENGINE.slice(start, end);
    const touchStart = body.indexOf("const touch =");
    const touchEnd = body.indexOf("if (dryRun)");
    const touch = body.slice(touchStart, touchEnd);
    expect(touch).toContain("last_seen_at");
    expect(touch).toContain("updated_at");
    expect(touch).not.toContain("deadline_at");
    expect(touch).not.toContain("min_grant_amount");
    expect(touch).not.toContain("max_grant_amount");
    expect(touch).not.toContain("region");
    expect(body).toContain("isCookieConsentShell");
    expect(body).toContain('await rotateQueueCursor(row.id, "SCRAPE_EMPTY")');
  });
});

describe("backfill_nulls cookie/empty falls back to paid scrape (source contract)", () => {
  const start = ENGINE.indexOf('if (action === "backfill_nulls")');
  const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
  const body = ENGINE.slice(start, end);

  it("calls loadPage after empty/cookie official fetch, one PaidBudget per row", () => {
    expect(body).toContain("officialPageNeedsPaidScrape(page, isCookieConsentShell)");
    expect(body).toContain("const paidBudget = createPaidBudget(allowPaidScrape)");
    expect(body).toContain("loadPage(row.official_url, domain, paidBudget)");
    expect(body).toContain("allowBackfillPaidScrape");
    expect(body).toContain("body.allow_paid_scrape");
    expect(body).toContain("FIRECRAWL_API_KEY");
    expect(body).toContain("APIFY_TOKEN");
    expect(body).toContain('await rotateQueueCursor(row.id, "SCRAPE_EMPTY")');
    const paidIdx = body.indexOf("fallbackPaidOfficialPage");
    const emptyIdx = body.indexOf('await rotateQueueCursor(row.id, "SCRAPE_EMPTY")');
    expect(paidIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(paidIdx);
  });

  it("does not raise PDF CPU caps or change packet size", () => {
    const scrape = readFileSync("supabase/functions/trovabandi-engine/scrape.ts", "utf8");
    expect(scrape).toContain("PDF_PARSE_MAX_BYTES = 800_000");
    expect(scrape).toContain("PDF_MAX_FLATE_INFLATES = 12");
    expect(scrape).toContain("PDF_EXTRACT_MAX_CHARS = 80_000");
    expect(body).toContain("Math.min(400, Math.max(1, Number(body.max_batch) || 250))");
    expect(ENGINE).toContain("DETAIL_MAX_FETCH_PER_HIT = 20");
    expect(ENGINE).toContain("DETAIL_MAX_HOPS = 6");
  });
});

describe("backfill_nulls never overwrites filled ATECO with empty", () => {
  it("uses shouldPatchEligibleAteco after allegati walk", () => {
    const start = ENGINE.indexOf('if (action === "backfill_nulls")');
    const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
    const body = ENGINE.slice(start, end);
    expect(body).toContain("shouldPatchEligibleAteco(existingAteco, ateco)");
    expect(body).toContain("missingAteco");
    expect(body).toContain("Download?idAllegato=");
    expect(body).not.toContain("if (!sameAteco) patch.eligible_ateco_prefixes = ateco");
  });
});

describe("backfill_nulls missing importo still opens allegati", () => {
  it("walks Download?idAllegato when max_grant is null even if total_budget is set", () => {
    const start = ENGINE.indexOf('if (action === "backfill_nulls")');
    const end = ENGINE.indexOf('if (action === "enrich_apply_urls")');
    const body = ENGINE.slice(start, end);
    expect(body).toContain("const missingAmounts = row.max_grant_amount == null &&");
    expect(body).toContain("patch.max_grant_amount == null;");
    expect(body).not.toContain(
      "const missingAmounts = row.max_grant_amount == null &&\n          patch.max_grant_amount == null &&\n          row.total_budget == null &&\n          patch.total_budget == null;",
    );
    expect(body).toContain("Download?idAllegato=");
  });
});
