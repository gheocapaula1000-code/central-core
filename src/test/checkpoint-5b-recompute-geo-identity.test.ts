import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────────────────────────────────────────────────────────
// CHECKPOINT 5B — identità geografica cross-portale nel recompute
// contendibili / multi-portale.
//
// Il file contiene:
//  1. una reimplementazione pura e deterministica delle regole SQL della
//     branca GEO (stessa logica, stesse soglie) esercitata con fixture
//     realistiche;
//  2. asserzioni statiche sulla migration live (nessun TRUNCATE, upsert,
//     soglie, separazione delle due categorie).
// ───────────────────────────────────────────────────────────────────────────

type Listing = {
  id: number;
  zone: string;
  locali: number;
  mq: number;
  prezzo: number;
  bagni: number | null;
  fonte: string;
  agency: string;
  lat: number;
  lng: number;
  url: string;
};

const MAX_DISTANCE_M = 30;
const MAX_MQ_RATIO = 1.02;
const MAX_PRICE_RATIO = 1.05;
const MAX_GROUP_ROWS = 4;
/** Il venditore Subito è un nickname: non prova identità di agenzia. */
const UNTRUSTED_AGENCY_SOURCES = new Set(["subito"]);

function haversineM(a: Listing, b: Listing): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Prime 3 parole alfanumeriche compattate (equivalente SQL agency_k3). */
export function agencyK3(agency: string): string {
  return agency
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("");
}

/** Agenzia canonica: la chiave più corta di cui questa è prefisso. */
export function canonicalAgencies(rows: Listing[]): Set<string> {
  const keys = rows
    .filter((r) => !UNTRUSTED_AGENCY_SOURCES.has(r.fonte))
    .map((r) => agencyK3(r.agency))
    .filter((k) => k !== "");
  const canon = new Set<string>();
  for (const k of keys) {
    const shortest = keys
      .filter((other) => k.startsWith(other))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    canon.add(shortest ?? k);
  }
  return canon;
}

export type Classification =
  | { kind: "contendibile"; agenzie: number; portali: number }
  | { kind: "multi_portale"; agenzie: number; portali: number }
  | { kind: "escluso"; reason: string };

/** Regole della branca GEO, identiche al SQL live. */
export function classifyGeoGroup(rows: Listing[]): Classification {
  if (rows.length < 2) return { kind: "escluso", reason: "gruppo_singolo" };
  if (rows.length > MAX_GROUP_ROWS)
    return { kind: "escluso", reason: "gruppo_troppo_grande" };
  if (new Set(rows.map((r) => r.zone)).size > 1)
    return { kind: "escluso", reason: "cross_zone" };
  if (new Set(rows.map((r) => r.locali)).size > 1)
    return { kind: "escluso", reason: "locali_incompatibili" };

  for (const a of rows) {
    for (const b of rows) {
      if (a.id >= b.id) continue;
      if (haversineM(a, b) > MAX_DISTANCE_M)
        return { kind: "escluso", reason: "distanza" };
    }
  }
  const mq = rows.map((r) => r.mq);
  const pz = rows.map((r) => r.prezzo);
  if (Math.min(...mq) <= 0 || Math.max(...mq) > Math.min(...mq) * MAX_MQ_RATIO)
    return { kind: "escluso", reason: "mq_incompatibili" };
  if (Math.min(...pz) <= 0 || Math.max(...pz) > Math.min(...pz) * MAX_PRICE_RATIO)
    return { kind: "escluso", reason: "prezzo_incompatibile" };
  const bagni = new Set(
    rows.filter((r) => r.bagni !== null).map((r) => r.bagni as number),
  );
  if (bagni.size > 1) return { kind: "escluso", reason: "bagni_incompatibili" };

  const agenzie = canonicalAgencies(rows).size;
  const portali = new Set(rows.map((r) => r.fonte)).size;
  if (agenzie >= 2) return { kind: "contendibile", agenzie, portali };
  if (portali >= 2) return { kind: "multi_portale", agenzie, portali };
  return { kind: "escluso", reason: "evidenza_insufficiente" };
}

const base: Omit<Listing, "id" | "fonte" | "agency" | "url"> = {
  zone: "centro-storico",
  locali: 3,
  mq: 100,
  prezzo: 250000,
  bagni: 1,
  lat: 45.4064,
  lng: 11.8768,
};

const L = (
  id: number,
  fonte: string,
  agency: string,
  patch: Partial<Listing> = {},
): Listing => ({
  ...base,
  id,
  fonte,
  agency,
  url: `https://${fonte}.example/${id}`,
  ...patch,
});

describe("5B — classificazione dei gruppi per identità geografica", () => {
  it("stesso immobile, due agenzie, stesso portale → contendibile", () => {
    const r = classifyGeoGroup([
      L(1, "immobiliare", "Db Immobiliare Di Daniele Benetollo"),
      L(2, "immobiliare", "Immobiliare Duemme S.a.s. - Padova MLS"),
    ]);
    expect(r).toMatchObject({ kind: "contendibile", agenzie: 2, portali: 1 });
  });

  it("stesso immobile, una agenzia, due portali → multi-portale", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Pianeta Casa Immobiliare"),
      L(2, "immobiliare", "Pianeta Casa Immobiliare"),
    ]);
    expect(r).toMatchObject({ kind: "multi_portale", agenzie: 1, portali: 2 });
  });

  it("due agenzie e due portali → contendibile, senza duplicare in multi-portale", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Db Immobiliare Di Daniele Benetollo"),
      L(2, "immobiliare", "Immobiliare Ferrarese"),
    ]);
    expect(r.kind).toBe("contendibile");
    expect(r).not.toMatchObject({ kind: "multi_portale" });
  });

  it("stessa via ma civici diversi (oltre 30 m) → mai fusi", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Alfa Immobiliare"),
      L(2, "immobiliare", "Beta Immobiliare", { lat: 45.4074 }), // ~111 m
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "distanza" });
  });

  it("stessa posizione ma superficie incompatibile → mai fusi", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Alfa Immobiliare"),
      L(2, "immobiliare", "Beta Immobiliare", { mq: 140 }),
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "mq_incompatibili" });
  });

  it("stessa posizione ma prezzo incompatibile → mai fusi", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Alfa Immobiliare"),
      L(2, "immobiliare", "Beta Immobiliare", { prezzo: 330000 }),
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "prezzo_incompatibile" });
  });

  it("stessa posizione ma bagni contraddittori → fail-closed", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Alfa Immobiliare", { bagni: 1 }),
      L(2, "immobiliare", "Alfa Immobiliare", { bagni: 3 }),
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "bagni_incompatibili" });
  });

  it("locali diversi → mai stesso gruppo", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Alfa Immobiliare"),
      L(2, "immobiliare", "Beta Immobiliare", { locali: 5 }),
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "locali_incompatibili" });
  });

  it("zone commerciali diverse → mai stesso gruppo", () => {
    const r = classifyGeoGroup([
      L(1, "idealista", "Alfa Immobiliare", { zone: "centro-storico" }),
      L(2, "immobiliare", "Beta Immobiliare", { zone: "est-brenta" }),
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "cross_zone" });
  });

  it("gruppo con più di 4 annunci → escluso, mai falso positivo", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => L(i, "immobiliare", `Agenzia ${i}`));
    expect(classifyGeoGroup(rows)).toMatchObject({
      kind: "escluso",
      reason: "gruppo_troppo_grande",
    });
  });

  it("dati insufficienti (un solo annuncio) → escluso", () => {
    expect(classifyGeoGroup([L(1, "idealista", "Alfa")])).toMatchObject({
      kind: "escluso",
      reason: "gruppo_singolo",
    });
  });

  it("una sola agenzia e un solo portale → escluso", () => {
    const r = classifyGeoGroup([
      L(1, "immobiliare", "Alfa Immobiliare"),
      L(2, "immobiliare", "Alfa Immobiliare"),
    ]);
    expect(r).toMatchObject({ kind: "escluso", reason: "evidenza_insufficiente" });
  });

  it("ripetizione della classificazione → risultato identico (idempotenza)", () => {
    const rows = [
      L(1, "idealista", "Pianeta Casa Immobiliare"),
      L(2, "immobiliare", "Pianeta Casa Immobiliare"),
    ];
    expect(classifyGeoGroup(rows)).toEqual(classifyGeoGroup(rows));
  });
});

describe("5B — normalizzazione agenzie e portali", () => {
  it.each([
    ["Nova Dream", "Nova Dream | Building Management"],
    ["skyline immobiliare", "SKYLINE Immobiliare di Caterina Priolo"],
    ["GRUPPO VELA", "Gruppo Vela Servizi Immobiliari"],
    ["Casa per Casa - Montegrotto Terme", "Casa per Casa s.r.l."],
    ["Immobiliare La Chiave", "IMMOBILIARE LA CHIAVE"],
    ["L ’Arte di Abitare - Agenzia di Prato Della Valle", "L’Arte di Abitare – Agenzia di Prato della Valle"],
    ["Engel & Völkers Padova", "ENGEL & VÖLKERS PADOVA"],
  ])("varianti equivalenti contano come una sola agenzia: %s / %s", (a, b) => {
    const rows = [L(1, "idealista", a), L(2, "immobiliare", b)];
    expect(canonicalAgencies(rows).size).toBe(1);
    expect(classifyGeoGroup(rows).kind).toBe("multi_portale");
  });

  it.each([
    ["Db Immobiliare Di Daniele Benetollo", "Immobiliare Ferrarese"],
    ["Tecnocasa Studio Arcella", "Tecnocasa Studio Guizza"],
  ])("agenzie realmente diverse restano due: %s / %s", (a, b) => {
    const rows = [L(1, "immobiliare", a), L(2, "immobiliare", b)];
    expect(canonicalAgencies(rows).size).toBe(2);
    expect(classifyGeoGroup(rows).kind).toBe("contendibile");
  });

  it("il venditore Subito non prova un'agenzia distinta ma conta come portale", () => {
    const rows = [
      L(1, "idealista", "PACE DI VISENTIN ANTONELLA & C"),
      L(2, "subito", "Albignasego"),
    ];
    expect(canonicalAgencies(rows).size).toBe(1);
    expect(classifyGeoGroup(rows)).toMatchObject({
      kind: "multi_portale",
      portali: 2,
    });
  });

  it("varianti della stessa fonte non creano due portali", () => {
    const rows = [
      L(1, "immobiliare", "Alfa Immobiliare"),
      L(2, "immobiliare", "Beta Immobiliare"),
    ];
    expect(new Set(rows.map((r) => r.fonte)).size).toBe(1);
  });
});

describe("5B — migration live", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .filter((s) => s.includes("|GEO:"))
    .join("\n");

  it("la branca GEO è presente nelle migration applicate", () => {
    expect(sql).toContain("'|GEO:'");
  });

  it("usa CREATE OR REPLACE FUNCTION e non ricrea lo schema", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.recompute_padova_listings_contendibili()",
    );
    expect(sql).not.toMatch(/DROP\s+TABLE\s+public\./i);
  });

  it("nessun TRUNCATE del dataset", () => {
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it("mantiene le soglie robuste (30 m, mq 2%, prezzo 5%, max 4 righe)", () => {
    expect(sql).toContain("max_d <= 30");
    expect(sql).toContain("mq_min::numeric * 1.02");
    expect(sql).toContain("prezzo_min::numeric * 1.05");
    expect(sql).toContain("n_rows BETWEEN 2 AND 4");
  });

  it("mantiene separazione contendibili / multi-portale", () => {
    expect(sql).toContain("_fg_geo WHERE n_agenzie >= 2");
    expect(sql).toContain("_fg_geo WHERE n_portali >= 2 AND n_agenzie < 2");
  });

  it("usa upsert su chiave_match, non insert distruttivi", () => {
    expect(sql).toContain("ON CONFLICT (chiave_match) DO UPDATE");
  });

  it("raggruppa solo dentro la stessa zona commerciale", () => {
    expect(sql).toContain("GROUP BY czone_slug, locali");
  });

  it("include i gate fail-closed con rollback", () => {
    expect(sql).toContain("GATE chiavi duplicate");
    expect(sql).toContain("GATE zona non ufficiale");
    expect(sql).toContain("GATE url fuori Padova");
  });

  it("resta SECURITY DEFINER con search_path fissato", () => {
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path TO 'public'");
  });
});
