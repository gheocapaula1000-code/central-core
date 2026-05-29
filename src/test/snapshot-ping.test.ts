// Pure-logic tests for the Padova snapshot ping helpers.
import { describe, expect, it } from "vitest";
import {
  parseFirecrawlPing,
  shouldConfirmDelisted,
  utcDateKey,
} from "../../supabase/functions/_shared/snapshotPing.ts";

describe("parseFirecrawlPing", () => {
  it("treats portal 404 as removed", () => {
    const r = parseFirecrawlPing({ data: { metadata: { statusCode: 404 } } });
    expect(r.outcome).toBe("removed");
    expect(r.http_status).toBe(404);
    expect(r.price_eur).toBeNull();
  });

  it("treats explicit 'annuncio non disponibile' markdown as removed", () => {
    const r = parseFirecrawlPing({
      data: { metadata: { statusCode: 200 }, markdown: "Spiacenti, l'annuncio non è più disponibile." },
    });
    expect(r.outcome).toBe("removed");
  });

  it("returns ok with numeric price from json payload", () => {
    const r = parseFirecrawlPing({
      data: {
        metadata: { statusCode: 200 },
        json: { price: "€ 350.000", surface_sqm: "95" },
      },
    });
    expect(r.outcome).toBe("ok");
    expect(r.price_eur).toBe(350000);
    expect(r.surface_sqm).toBe(95);
  });

  it("falls back to markdown regex when json is missing", () => {
    const r = parseFirecrawlPing({
      data: { metadata: { statusCode: 200 }, markdown: "Prezzo richiesto: € 199.000" },
    });
    expect(r.outcome).toBe("ok");
    expect(r.price_eur).toBe(199000);
  });

  it("returns error when no price can be extracted", () => {
    const r = parseFirecrawlPing({ data: { metadata: { statusCode: 200 }, markdown: "no prices here" } });
    expect(r.outcome).toBe("error");
    expect(r.price_eur).toBeNull();
  });
});

describe("shouldConfirmDelisted", () => {
  it("does NOT confirm delisting on the first failure", () => {
    const today = new Date("2026-05-29T03:00:00Z");
    expect(shouldConfirmDelisted([], today)).toBe(false);
  });

  it("does NOT confirm if both failures fall on the same UTC day", () => {
    const today = new Date("2026-05-29T23:30:00Z");
    const earlier = new Date("2026-05-29T01:00:00Z");
    expect(shouldConfirmDelisted([earlier.toISOString()], today)).toBe(false);
  });

  it("confirms delisting when a failure already exists on a different UTC day", () => {
    const today = new Date("2026-05-29T03:00:00Z");
    const yesterday = new Date("2026-05-28T03:00:00Z");
    expect(shouldConfirmDelisted([yesterday.toISOString()], today)).toBe(true);
  });
});

describe("utcDateKey", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    expect(utcDateKey("2026-05-29T03:00:00Z")).toBe("2026-05-29");
  });
});
