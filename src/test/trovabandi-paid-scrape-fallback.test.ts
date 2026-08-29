import { describe, expect, it, vi } from "vitest";
import {
  allowBackfillPaidScrape,
  createPaidBudget,
  fallbackPaidOfficialPage,
  officialPageNeedsPaidScrape,
} from "../../supabase/functions/trovabandi-engine/budget.ts";

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
