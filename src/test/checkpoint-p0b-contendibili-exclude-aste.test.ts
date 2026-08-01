// CHECKPOINT P0-B — Esclusione aste dai Contendibili.
// 1) Contratto statico: la documentazione della correzione applicata.
// 2) Contratto comportamentale: mirror TS della funzione SQL.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  hasAuctionEvidence,
  groupHasAuction,
} from "../../supabase/functions/_shared/contendibiliAuctionGuard.ts";

const DOC = readFileSync(
  "docs/pending-migrations/APPLIED_20260801062000_padova_contendibili_exclude_aste.sql",
  "utf8",
);

describe("contendibili — contratto statico esclusione aste", () => {
  it("non indebolisce la certificazione unità v3", () => {
    expect(DOC).toContain("v3-unit-certified");
    expect(DOC).toMatch(/regole v3 [\s\S]*sono invariate/i);
  });

  it("dichiara la funzione deterministica e il motivo di quarantena", () => {
    expect(DOC).toContain("padova_listing_has_auction_evidence");
    expect(DOC).toContain("ASTA_O_PROCEDURA");
  });

  it("esclude il gruppo integralmente e difende la vista server-only", () => {
    expect(DOC).toMatch(/ALMENO UN annuncio d'asta/);
    expect(DOC).toContain("padova_contendibili_by_zone_v");
    expect(DOC).toContain("QA aste fallita");
  });

  it("il nome agenzia non è prova sufficiente", () => {
    expect(DOC).toMatch(/Da solo NON classifica mai/);
  });
});

describe("guardia aste — casi richiesti", () => {
  it("asta giudiziaria esplicita", () => {
    expect(
      hasAuctionEvidence({ title: "Appartamento", description: "Acquisto Assistito in Asta Giudiziaria" }),
    ).toBe(true);
  });

  it("offerta minima / base d'asta", () => {
    expect(hasAuctionEvidence({ description: "Prezzo base 47.990 €, offerta minima 35.993 €" })).toBe(true);
    expect(hasAuctionEvidence({ description: "Base d'asta pari a 48.000 euro" })).toBe(true);
  });

  it("RGE / tribunale", () => {
    expect(hasAuctionEvidence({ description: "Procedura R.G.E. 123/2024" })).toBe(true);
    expect(hasAuctionEvidence({ description: "Vendita disposta dal Tribunale di Padova" })).toBe(true);
  });

  it("campo strutturato rty=as", () => {
    expect(hasAuctionEvidence({ rty: "as", title: "Appartamento" })).toBe(true);
  });

  it("procedura esecutiva", () => {
    expect(hasAuctionEvidence({ description: "* IMMOBILE IN PROCEDURA ESECUTIVA *" })).toBe(true);
  });

  it("gruppo misto ordinario + asta: escluso integralmente", () => {
    const gruppo = [
      { title: "Appartamento", description: "Trilocale ristrutturato con terrazzo" },
      { title: "Appartamento", description: "Vendita giudiziaria senza incanto" },
    ];
    expect(groupHasAuction(gruppo)).toBe(true);
  });

  it("parole non pertinenti: nessun falso positivo", () => {
    expect(hasAuctionEvidence({ description: "Rendita catastale aggiornata e visura catastale" })).toBe(false);
    expect(hasAuctionEvidence({ description: "Progetto di un famoso artista, basta una visita" })).toBe(false);
    expect(hasAuctionEvidence({ description: "Zona servita, lottizzazione degli anni 70" })).toBe(false);
  });

  it("annuncio ordinario resta eleggibile", () => {
    expect(
      hasAuctionEvidence({
        title: "Appartamento 3 locali",
        description:
          "Appartamento al secondo piano con ascensore, soggiorno, cucina abitabile, due camere e garage.",
        agency: "Studio Immobiliare Padova",
      }),
    ).toBe(false);
  });

  it("il solo nome agenzia non basta a classificare come asta", () => {
    expect(
      hasAuctionEvidence({
        agency: "Aste Florio",
        title: "Appartamento",
        description: "Bilocale luminoso con terrazzino, ottime condizioni.",
      }),
    ).toBe(false);
  });

  it("nome agenzia + riferimento a procedura: classificato asta", () => {
    expect(
      hasAuctionEvidence({
        agency: "Aste Agency SRL",
        description: "Immobile oggetto di procedura, perizia disponibile su richiesta.",
      }),
    ).toBe(true);
  });
});
