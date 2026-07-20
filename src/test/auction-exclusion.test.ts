import { describe, it, expect } from "vitest";
import {
  normalizeAuctionText,
  isAuctionText,
  isAuctionRecord,
} from "../../supabase/functions/_shared/auctionExclusion.ts";

describe("auction guard — word-boundary detection", () => {
  it("recognizes 'asta immobiliare'", () => {
    expect(isAuctionText("Bell'asta immobiliare a Padova")).toBe(true);
  });
  it("recognizes 'vendita giudiziaria'", () => {
    expect(isAuctionText("Vendita giudiziaria del tribunale")).toBe(true);
  });
  it("recognizes PVP URL", () => {
    expect(isAuctionText("https://pvp.giustizia.it/pvp/it/lista_annunci.wp")).toBe(true);
  });
  it("recognizes astalegale.net URL", () => {
    expect(isAuctionText("https://www.astalegale.net/annuncio/123")).toBe(true);
  });
  it("recognizes 'pignoramento'", () => {
    expect(isAuctionText("procedura di pignoramento immobiliare")).toBe(true);
  });
  it("does NOT flag 'visura catastale'", () => {
    expect(isAuctionText("richiesta visura catastale")).toBe(false);
  });
  it("does NOT flag 'rendita catastale'", () => {
    expect(isAuctionText("rendita catastale aggiornata")).toBe(false);
  });
  it("does NOT flag 'catasto urbano'", () => {
    expect(isAuctionText("dati del catasto urbano")).toBe(false);
  });
  it("does NOT flag 'catastale' inside a longer word", () => {
    expect(isAuctionText("valore catastale immobile")).toBe(false);
  });
  it("does NOT falsely match 'artista' (contains 'asta' substring)", () => {
    // Il matcher usa confini di parola: 'artista' contiene 'asta' ma non è una parola intera.
    expect(isAuctionText("un famoso artista veneto")).toBe(false);
  });

  it("isAuctionRecord scans payload and raw_json", () => {
    expect(isAuctionRecord({ id: 1, payload: { note: "Vendita giudiziaria" } })).toBe(true);
    expect(isAuctionRecord({ id: 2, raw_json: { source: "asteimmobili.it" } })).toBe(true);
    expect(isAuctionRecord({ id: 3, title: "Rendita catastale", payload: { desc: "immobile" } })).toBe(false);
  });

  it("isAuctionRecord flags AUCTION signal_type family", () => {
    expect(isAuctionRecord({ signal_type: "AUCTION_NEW" })).toBe(true);
  });

  it("normalizeAuctionText lowercases, strips accents, collapses whitespace", () => {
    const t = normalizeAuctionText("  ÀSTA  Giudiziaria  ");
    expect(t.includes("asta")).toBe(true);
    expect(t.includes("giudiziaria")).toBe(true);
  });
});
