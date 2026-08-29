import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  allowBackfillPaidScrape,
  atecoPrefixesEmpty,
  backfillPaidAtecoUrls,
  backfillQueueRank,
  createPaidBudget,
  fallbackPaidOfficialPage,
  fallbackPaidWhenAtecoEmpty,
  mergeBackfillPriorityPages,
  officialPageNeedsPaidScrape,
  shouldPatchEligibleAteco,
} from "../../supabase/functions/trovabandi-engine/budget.ts";
import { localExtractAteco } from "../../supabase/functions/trovabandi-engine/local-fields.ts";

const REAL =
  "Avviso pubblico per contributi a fondo perduto. Le domande si presentano entro il 30 settembre 2026. Il contributo massimo e pari a 80.000 euro. ".repeat(
    6,
  );

const COOKIE =
  "Questo sito utilizza cookie. Accetta tutti i cookie oppure Rifiuta. Cookie tecnici e banner. ".repeat(
    8,
  );

describe("allowBackfillPaidScrape", () => {
  it("defaults on unless explicitly false, and needs a scrape key", () => {
    expect(allowBackfillPaidScrape(undefined, true, false)).toBe(true);
    expect(allowBackfillPaidScrape(undefined, false, true)).toBe(true);
    expect(allowBackfillPaidScrape(true, true, false)).toBe(true);
    expect(allowBackfillPaidScrape(undefined, false, false)).toBe(false);
    expect(allowBackfillPaidScrape(false, true, true)).toBe(false);
    expect(allowBackfillPaidScrape("false", true, true)).toBe(false);
  });
});

describe("officialPageNeedsPaidScrape", () => {
  const isCookie = (markdown: string) => markdown.includes("Accetta");
  it("flags missing, short, and cookie-shell pages", () => {
    expect(officialPageNeedsPaidScrape(null, isCookie)).toBe(true);
    expect(officialPageNeedsPaidScrape({ markdown: "Accetta" }, isCookie)).toBe(true);
    expect(officialPageNeedsPaidScrape({ markdown: COOKIE }, isCookie)).toBe(true);
    expect(officialPageNeedsPaidScrape({ markdown: REAL }, isCookie)).toBe(false);
  });
});

describe("cookie/empty -> paid scrape fallback (mocked loadPage)", () => {
  it("calls loadPage on a cookie shell and uses the paid markdown", async () => {
    const loadPage = vi.fn(async () => ({
      markdown: REAL,
      title: "avviso",
      provider: "firecrawl",
    }));
    const page = await fallbackPaidOfficialPage(
      { markdown: COOKIE, title: "", provider: "official-http" },
      { isCookieShell: (md) => md.includes("Accetta"), loadPage },
    );
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(page?.provider).toBe("firecrawl");
    expect(page?.markdown).toBe(REAL);
  });

  it("calls loadPage when the official page is missing", async () => {
    const loadPage = vi.fn(async () => ({
      markdown: REAL,
      title: "avviso",
      provider: "apify",
    }));
    const page = await fallbackPaidOfficialPage(null, {
      isCookieShell: () => false,
      loadPage,
    });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(page?.provider).toBe("apify");
  });

  it("calls loadPage when markdown is under 200 chars", async () => {
    const loadPage = vi.fn(async () => ({
      markdown: REAL,
      title: "",
      provider: "firecrawl",
    }));
    await fallbackPaidOfficialPage(
      { markdown: "short", title: "", provider: "official-http" },
      { isCookieShell: () => false, loadPage },
    );
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("does not call loadPage when the official page is already usable", async () => {
    const loadPage = vi.fn(async () => ({
      markdown: REAL,
      title: "",
      provider: "firecrawl",
    }));
    const original = {
      markdown: REAL,
      title: "ok",
      provider: "official-http",
    };
    const page = await fallbackPaidOfficialPage(original, {
      isCookieShell: () => false,
      loadPage,
    });
    expect(loadPage).not.toHaveBeenCalled();
    expect(page).toBe(original);
  });

  it("keeps the unusable page if paid scrape is still empty so the caller rotates SCRAPE_EMPTY", async () => {
    const loadPage = vi.fn(async () => null);
    const cookie = {
      markdown: COOKIE,
      title: "",
      provider: "official-http",
    };
    const page = await fallbackPaidOfficialPage(cookie, {
      isCookieShell: (md) => md.includes("Accetta"),
      loadPage,
    });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(page).toBe(cookie);
  });

  it("createPaidBudget still caps at one scrape per row", () => {
    const budget = createPaidBudget(true);
    expect(budget.maxPaidScrapes).toBe(1);
    expect(createPaidBudget(false).maxPaidScrapes).toBe(0);
  });
});

const INDEX_NO_ATECO =
  "Avviso pubblico Regione Veneto. Elenco bandi aperti. Consulta il bollettino e scarica l'avviso in PDF. Contributi per le imprese del territorio. ".repeat(
    4,
  );

const AVVISO_ATECO =
  "Avviso pubblico. Codice ATECO 62.10.00 ammissibile per le imprese software. Documentazione ufficiale del bando. ".repeat(
    3,
  );

const INDEX_NO_CODE =
  "Bando per la digitalizzazione delle PMI e l'innovazione digitale. Voucher per transizione digitale. ".repeat(
    4,
  );

describe("atecoPrefixesEmpty / backfillPaidAtecoUrls", () => {
  it("treats null, non-array, and blank entries as empty and never invents", () => {
    expect(atecoPrefixesEmpty(null)).toBe(true);
    expect(atecoPrefixesEmpty([])).toBe(true);
    expect(atecoPrefixesEmpty(["", "  "])).toBe(true);
    expect(atecoPrefixesEmpty(["62"])).toBe(false);
    expect(
      backfillPaidAtecoUrls(
        "https://regione.veneto.it/bandi/index",
        "https://regione.veneto.it/bandi/avviso.pdf",
      ),
    ).toEqual([
      "https://regione.veneto.it/bandi/index",
      "https://regione.veneto.it/bandi/avviso.pdf",
    ]);
    expect(
      backfillPaidAtecoUrls("https://regione.veneto.it/bandi/index", ""),
    ).toEqual(["https://regione.veneto.it/bandi/index"]);
  });
});

describe("backfill queue: Veneto then NAZIONALE/EU then rest", () => {
  it("ranks Veneto ahead of national/EU and does not invent geo", () => {
    expect(backfillQueueRank({ region: "Veneto", authority_level: "REGIONALE" })).toBe(0);
    expect(backfillQueueRank({ region: "VENETO", authority_level: "REGIONALE" })).toBe(0);
    expect(backfillQueueRank({ region: null, authority_level: "NAZIONALE" })).toBe(1);
    expect(backfillQueueRank({ region: null, authority_level: "EU" })).toBe(1);
    expect(backfillQueueRank({ region: "Lombardia", authority_level: "REGIONALE" })).toBe(2);
    expect(backfillQueueRank({ region: null, authority_level: "COMUNALE" })).toBe(2);
  });

  it("merges two-step select pages without duplicating ids, cap maxBatch", () => {
    const veneto = [
      { id: "v1", region: "Veneto", authority_level: "REGIONALE" },
    ];
    const national = [
      { id: "v1", region: "Veneto", authority_level: "NAZIONALE" },
      { id: "n1", region: null, authority_level: "NAZIONALE" },
    ];
    const rest = [
      { id: "r1", region: "Lombardia", authority_level: "REGIONALE" },
    ];
    expect(mergeBackfillPriorityPages([veneto, national, rest], 1)).toEqual([
      veneto[0],
    ]);
    expect(mergeBackfillPriorityPages([veneto, national, rest], 2).map((r) => r.id)).toEqual([
      "v1",
      "n1",
    ]);
  });
});

describe("readable HTML without ATECO still triggers paid scrape", () => {
  it("calls loadPage on official_url even when local HTML was readable and long", async () => {
    const loadPage = vi.fn(async (url: string) => {
      if (url.endsWith(".pdf")) {
        return { markdown: AVVISO_ATECO, title: "avviso", provider: "firecrawl" };
      }
      return { markdown: INDEX_NO_ATECO, title: "index", provider: "firecrawl" };
    });
    const local = localExtractAteco(INDEX_NO_ATECO);
    expect(local).toEqual([]);
    const result = await fallbackPaidWhenAtecoEmpty(local, {
      officialUrl: "https://www.regione.veneto.it/bandi/index",
      noticeUrl: "https://www.regione.veneto.it/bandi/avviso.pdf",
      loadPage,
      extractAteco: localExtractAteco,
      isCookieShell: () => false,
    });
    expect(loadPage).toHaveBeenCalled();
    expect(loadPage.mock.calls[0][0]).toBe(
      "https://www.regione.veneto.it/bandi/index",
    );
    expect(loadPage.mock.calls.map((c) => c[0])).toContain(
      "https://www.regione.veneto.it/bandi/avviso.pdf",
    );
    expect(result.ateco).toEqual(["62"]);
    expect(result.page?.provider).toBe("firecrawl");
  });

  it("still requests notice_url after official markdown without ATECO", async () => {
    const loadPage = vi.fn(async (url: string) => ({
      markdown: url.endsWith(".pdf") ? AVVISO_ATECO : INDEX_NO_ATECO,
      title: "",
      provider: "apify",
    }));
    await fallbackPaidWhenAtecoEmpty([], {
      officialUrl: "https://www.regione.veneto.it/bandi/index",
      noticeUrl: "https://www.regione.veneto.it/bandi/avviso.pdf",
      loadPage,
      extractAteco: localExtractAteco,
    });
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("does not call loadPage when local extract already found prefixes", async () => {
    const loadPage = vi.fn(async () => ({
      markdown: AVVISO_ATECO,
      title: "",
      provider: "firecrawl",
    }));
    const result = await fallbackPaidWhenAtecoEmpty(["62"], {
      officialUrl: "https://www.regione.veneto.it/bandi/index",
      noticeUrl: "https://www.regione.veneto.it/bandi/avviso.pdf",
      loadPage,
      extractAteco: localExtractAteco,
    });
    expect(loadPage).not.toHaveBeenCalled();
    expect(result.ateco).toEqual(["62"]);
    expect(result.page).toBeNull();
  });

  it("does not invent prefixes (not 62, not 62.10.00) when paid markdown has no ATECO", async () => {
    const loadPage = vi.fn(async () => ({
      markdown: INDEX_NO_CODE,
      title: "index",
      provider: "firecrawl",
    }));
    const result = await fallbackPaidWhenAtecoEmpty([], {
      officialUrl: "https://www.mise.gov.it/bandi/index",
      noticeUrl: null,
      loadPage,
      extractAteco: localExtractAteco,
    });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(result.ateco).toEqual([]);
    expect(result.ateco).not.toContain("62");
    expect(result.ateco).not.toContain("62.10.00");
  });
});

describe("engine wiring (no live APIs)", () => {
  const engine = readFileSync(
    "supabase/functions/trovabandi-engine/index.ts",
    "utf8",
  );
  const scrape = readFileSync(
    "supabase/functions/trovabandi-engine/scrape.ts",
    "utf8",
  );

  it("backfill_nulls calls fallbackPaidWhenAtecoEmpty after localExtractAteco", () => {
    const localAt = engine.indexOf("let ateco = localExtractAteco(page.markdown);");
    const paidAt = engine.indexOf("fallbackPaidWhenAtecoEmpty(ateco");
    expect(localAt).toBeGreaterThan(-1);
    expect(paidAt).toBeGreaterThan(localAt);
    expect(engine).toContain("paidProviderScrape(url)");
    expect(engine).toContain('ilike(\n      "region",\n      "%Veneto%",\n    )');
  });

  it("does not raise PDF parse caps or packet default", () => {
    expect(scrape).toContain("const PDF_PARSE_MAX_BYTES = 800_000;");
    expect(scrape).toContain("const PDF_MAX_FLATE_INFLATES = 12;");
    expect(scrape).toContain("const PDF_EXTRACT_MAX_CHARS = 80_000;");
    expect(engine).toContain("Number(body.max_batch) || 250");
    expect(engine).toContain("DETAIL_MAX_FETCH_PER_HIT = 20");
  });
});

describe("shouldPatchEligibleAteco", () => {
  it("never replace a filled array with []", () => {
    expect(shouldPatchEligibleAteco(["58", "59"], [])).toBe(false);
    expect(shouldPatchEligibleAteco(["62"], ["", "  "])).toBe(false);
  });

  it("fills empty existing when extract found prefixes", () => {
    expect(shouldPatchEligibleAteco([], ["58", "59"])).toBe(true);
    expect(shouldPatchEligibleAteco([], [])).toBe(false);
  });

  it("skips a no-op identical set", () => {
    expect(shouldPatchEligibleAteco(["58", "62"], ["62", "58"])).toBe(false);
    expect(shouldPatchEligibleAteco(["58"], ["58", "59"])).toBe(true);
  });
});
