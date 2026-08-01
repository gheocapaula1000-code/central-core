import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────────────────────────────────────────────────────────
// CHECKPOINT P1-B FINAL — certificazione multi-portale.
//
// 1. Reimplementazione pura e deterministica del gate SQL
//    public.padova_certify_multi_portale() (stesse regole, stesse soglie).
// 2. Asserzioni statiche sulla migration live.
//
// Regola cardine: un gruppo multi-portale resta pubblico SOLO se rappresenta
// la stessa unità immobiliare. Via, quartiere, coordinate, locali, mq, piano
// o URL di immagini NON costituiscono prova.
// ───────────────────────────────────────────────────────────────────────────

export type MpRow = {
  fonte: string;
  zone: string;
  agency: string | null;
  via: string | null;
  civico: string | null;
  piano: string | null;
  descr_fp: string | null;
  image_refs?: string[] | null;
  tipologia: string | null;
  locali: number;
  mq: number;
  prezzo: number;
  bagni: number | null;
  asta?: boolean;
  mls?: boolean;
};

const normAgency = (a: string | null): string =>
  (a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const distinct = <T,>(v: (T | null)[]): number =>
  new Set(v.filter((x) => x !== null && x !== undefined)).size;
const present = <T,>(v: (T | null)[]): number =>
  v.filter((x) => x !== null && x !== undefined).length;

/** Verdetto identico al SQL live: array di motivi vuoto = certificato. */
export function certifyMultiPortale(rows: MpRow[]): string[] {
  const n = rows.length;
  const motivi: string[] = [];

  if (n < 2 || n > 4) motivi.push("CARDINALITA_NON_VALIDA");
  if (distinct(rows.map((r) => r.fonte)) < 2) motivi.push("PORTALE_SINGOLO");
  if (distinct(rows.map((r) => r.zone)) !== 1) motivi.push("ZONE_DIVERSE");

  const agenzie = new Set(
    rows
      .filter((r) => r.fonte !== "subito" && normAgency(r.agency) !== "")
      .map((r) => normAgency(r.agency)),
  );
  if (agenzie.size > 1) motivi.push("AGENZIE_DIVERSE");

  const vie = rows.map((r) => r.via);
  if (present(vie) < n || distinct(vie) !== 1)
    motivi.push("VIA_ASSENTE_O_DISCORDANTE");

  if (distinct(rows.map((r) => r.locali)) !== 1) motivi.push("LOCALI_DISCORDANTI");
  if (distinct(rows.map((r) => r.tipologia)) > 1) motivi.push("TIPOLOGIA_DISCORDANTE");
  if (distinct(rows.map((r) => r.bagni)) > 1) motivi.push("BAGNI_DISCORDANTI");
  if (distinct(rows.map((r) => r.piano)) > 1) motivi.push("PIANO_DISCORDANTE");

  const mqMin = Math.min(...rows.map((r) => r.mq));
  const mqMax = Math.max(...rows.map((r) => r.mq));
  if (mqMin <= 0 || mqMax > Math.max(mqMin + 5, mqMin * 1.05))
    motivi.push("MQ_INCOMPATIBILI");

  const pzMin = Math.min(...rows.map((r) => r.prezzo));
  const pzMax = Math.max(...rows.map((r) => r.prezzo));
  if (pzMin <= 0 || pzMax > pzMin * 1.1) motivi.push("PREZZO_INCOMPATIBILE");

  if (rows.some((r) => r.asta)) motivi.push("ASTA_O_PROCEDURA");
  if (rows.some((r) => r.mls) && agenzie.size > 1) motivi.push("MLS_INCOMPATIBILE");

  const civici = rows.map((r) => r.civico);
  const fps = rows.map((r) => r.descr_fp);
  const provaCivico = present(civici) === n && distinct(civici) === 1;
  const provaFp = present(fps) === n && distinct(fps) === 1;
  if (!provaCivico && !provaFp) motivi.push("EVIDENZA_UNITA_ASSENTE");

  return motivi;
}

const R = (patch: Partial<MpRow> = {}): MpRow => ({
  fonte: "casa",
  zone: "nord-arcella",
  agency: "Veneto Case - Sede di Camin",
  via: "giulio-zanon",
  civico: "30",
  piano: "p2",
  descr_fp: null,
  tipologia: "appartamento",
  locali: 3,
  mq: 95,
  prezzo: 257000,
  bagni: 1,
  ...patch,
});

describe("P1-B — gate di certificazione multi-portale", () => {
  it("gruppo reale con evidenza forte (stesso civico, stessa agenzia, 2 portali) → certificato", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista" })]),
    ).toEqual([]);
  });

  it("fingerprint di descrizione identico su tutti gli annunci → certificato", () => {
    const fp = "a".repeat(32);
    expect(
      certifyMultiPortale([
        R({ civico: null, descr_fp: fp }),
        R({ fonte: "idealista", civico: null, descr_fp: fp }),
      ]),
    ).toEqual([]);
  });

  it("multi-portale senza civico e senza evidenza forte → escluso", () => {
    expect(
      certifyMultiPortale([
        R({ civico: null }),
        R({ fonte: "idealista", civico: null }),
      ]),
    ).toContain("EVIDENZA_UNITA_ASSENTE");
  });

  it("un quartiere non viene promosso a via: via assente su un annuncio → escluso", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", via: null })]),
    ).toContain("VIA_ASSENTE_O_DISCORDANTE");
  });

  it("stesso stabile ma appartamenti diversi (piano diverso) → non uniti", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", piano: "p5" })]),
    ).toContain("PIANO_DISCORDANTE");
  });

  it("stesso stabile, civici diversi → non uniti", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", civico: "32" })]),
    ).toContain("EVIDENZA_UNITA_ASSENTE");
  });

  it("un URL o path immagine non è un fingerprint e non certifica", () => {
    const img = ["https://cdn.example/foto/123.jpg"];
    const motivi = certifyMultiPortale([
      R({ civico: null, image_refs: img }),
      R({ fonte: "idealista", civico: null, image_refs: img }),
    ]);
    expect(motivi).toContain("EVIDENZA_UNITA_ASSENTE");
  });

  it("evidenza d'asta → gruppo escluso anche con civico concorde", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", asta: true })]),
    ).toContain("ASTA_O_PROCEDURA");
  });

  it("MLS con agenzie diverse → escluso", () => {
    const motivi = certifyMultiPortale([
      R(),
      R({ fonte: "idealista", agency: "Studio Immobiliare Alfa", mls: true }),
    ]);
    expect(motivi).toContain("AGENZIE_DIVERSE");
    expect(motivi).toContain("MLS_INCOMPATIBILE");
  });

  it("nessuna contaminazione tra zone commerciali", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", zone: "est-brenta" })]),
    ).toContain("ZONE_DIVERSE");
  });

  it("prezzo oltre il 10% → escluso", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", prezzo: 300000 })]),
    ).toContain("PREZZO_INCOMPATIBILE");
  });

  it("mq incompatibili → escluso", () => {
    expect(
      certifyMultiPortale([R(), R({ fonte: "idealista", mq: 140 })]),
    ).toContain("MQ_INCOMPATIBILI");
  });

  it("un solo portale → non è multi-portale", () => {
    expect(certifyMultiPortale([R(), R()])).toContain("PORTALE_SINGOLO");
  });

  it("gruppo oltre 4 annunci → escluso", () => {
    const rows = [R(), R({ fonte: "idealista" }), R({ fonte: "immobiliare" }), R({ fonte: "subito" }), R({ fonte: "casa" })];
    expect(certifyMultiPortale(rows)).toContain("CARDINALITA_NON_VALIDA");
  });

  it("idempotenza: stesso input, stesso verdetto", () => {
    const rows = [R(), R({ fonte: "idealista" })];
    expect(certifyMultiPortale(rows)).toEqual(certifyMultiPortale(rows));
  });
});

describe("P1-B — migration live del gate multi-portale", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .filter((s) => s.includes("padova_certify_multi_portale"))
    .join("\n");

  it("la funzione di certificazione esiste", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.padova_certify_multi_portale()",
    );
  });

  it("i gruppi non certificati finiscono in quarantena, non vengono cancellati dalla sorgente", () => {
    expect(sql).toContain("public.padova_multi_portale_quarantena");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.padova_listings/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it("richiede prova forte di unità (civico esatto oppure fingerprint descrizione)", () => {
    expect(sql).toContain("EVIDENZA_UNITA_ASSENTE");
    expect(sql).toContain("e.n_civico = e.n_rows AND e.d_civico = 1");
    expect(sql).toContain("e.n_fp    = e.n_rows AND e.d_fp    = 1");
  });

  it("nessuna prova basata su immagini", () => {
    expect(sql).not.toMatch(/ev_image_refs/);
  });

  it("esclude aste e MLS incompatibile", () => {
    expect(sql).toContain("ASTA_O_PROCEDURA");
    expect(sql).toContain("MLS_INCOMPATIBILE");
    expect(sql).toContain("padova_listing_has_auction_evidence");
  });

  it("mantiene le soglie (mq 5%, prezzo 10%, 2..4 righe, zona unica)", () => {
    expect(sql).toContain("e.mq_min::numeric * 1.05");
    expect(sql).toContain("e.pz_min::numeric * 1.10");
    expect(sql).toContain("e.n_rows < 2 OR e.n_rows > 4");
    expect(sql).toContain("ZONE_DIVERSE");
  });

  it("non modifica le regole dei contendibili (P0 / P0-B)", () => {
    expect(sql).not.toContain("recompute_padova_listings_contendibili");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.padova_contendibili\b/i);
  });

  it("è fail-closed con eccezione se restano gruppi non certificati pubblici", () => {
    expect(sql).toContain("QA multi-portale fallita");
  });

  it("resta SECURITY DEFINER con search_path fissato ed EXECUTE ristretto", () => {
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path TO 'public'");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.padova_certify_multi_portale() TO service_role",
    );
  });
});
