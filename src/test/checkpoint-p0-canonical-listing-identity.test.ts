// CHECKPOINT P0 — identità canonica dell'annuncio nel certificatore contendibili.
// Verifica statica della migrazione + verifica funzionale della regola di
// canonicalizzazione replicata fedelmente dal SQL.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  "docs/pending-migrations/20260806003000_padova_contendibili_canonical_listing_identity.sql",
  "utf8",
);

/** Replica esatta della logica SQL di public.padova_listing_canonical_id. */
function canonicalId(url: string | null | undefined): string | null {
  const nu = String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/[#?].*$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  if (nu === "") return null;
  let m = nu.match(/idealista\.[a-z.]+\/immobile\/(\d+)/);
  if (m) return `idealista:${m[1]}`;
  m = nu.match(/casa\.it\/.*immobili\/(\d+)/);
  if (m) return `casa:${m[1]}`;
  m = nu.match(/immobiliare\.it\/annunci\/(\d+)/);
  if (m) return `immobiliare:${m[1]}`;
  if (/subito\.it\/.*[-/]\d{6,}(\.htm)?$/.test(nu)) {
    const s = nu.match(/(\d{6,})(?:\.htm)?$/);
    if (s) return `subito:${s[1]}`;
  }
  return `url:${nu}`;
}

describe("identità canonica annuncio", () => {
  it("slash finale, query, fragment e www non cambiano l'identità", () => {
    const base = canonicalId("https://www.idealista.it/immobile/33268836");
    expect(base).toBe("idealista:33268836");
    for (const v of [
      "https://www.idealista.it/immobile/33268836/",
      "https://idealista.it/immobile/33268836/?utm_source=nl&gclid=x",
      "https://www.idealista.it/immobile/33268836#foto",
    ]) {
      expect(canonicalId(v)).toBe(base);
    }
  });

  it("estrae l'ID stabile dei quattro portali", () => {
    expect(canonicalId("https://www.casa.it/immobili/98765432/")).toBe("casa:98765432");
    expect(canonicalId("https://www.immobiliare.it/annunci/121212121/")).toBe("immobiliare:121212121");
    expect(canonicalId("https://www.subito.it/appartamenti/trilocale-padova-609876543.htm?x=1")).toBe(
      "subito:609876543",
    );
  });

  it("fallback host/path normalizzato e fail-closed su url vuoto", () => {
    expect(canonicalId("https://www.Esempio.it/Annuncio/?a=1#f")).toBe("url:esempio.it/annuncio");
    expect(canonicalId("")).toBeNull();
    expect(canonicalId(null)).toBeNull();
  });

  it("stesso portal ID con forme diverse => 1 sola identità (gruppo NON certificabile)", () => {
    const urls = [
      "https://www.idealista.it/immobile/35780163/",
      "https://www.idealista.it/immobile/35780163",
    ];
    const distinct = new Set(urls.map(canonicalId));
    expect(distinct.size).toBe(1);
    expect(distinct.size >= 2).toBe(false); // n_annunci_canonici >= 2 non soddisfatto
  });

  it("due portal ID realmente distinti => 2 identità (certificabile)", () => {
    const distinct = new Set(
      [
        "https://www.idealista.it/immobile/33268836",
        "https://www.immobiliare.it/annunci/121212121/",
      ].map(canonicalId),
    );
    expect(distinct.size).toBe(2);
  });

  it("idempotenza della canonicalizzazione", () => {
    const u = "https://www.idealista.it/immobile/33268836/?x=1";
    const once = canonicalId(u)!;
    expect(canonicalId(`https://${once.replace("idealista:", "www.idealista.it/immobile/")}/`)).toBe(once);
  });
});

describe("migrazione P0 canonical listing identity", () => {
  it("crea la funzione immutabile con i quattro portali e il fallback", () => {
    expect(SQL).toContain("CREATE OR REPLACE FUNCTION public.padova_listing_canonical_id");
    expect(SQL).toContain("IMMUTABLE");
    for (const p of ["immobile/([0-9]+)", "immobili/([0-9]+)", "annunci/([0-9]+)", "([0-9]{6,})"]) {
      expect(SQL).toContain(p);
    }
    expect(SQL).toContain("'^www\\.'");
    expect(SQL).toContain("'/+$'");
  });

  it("include i test SQL in-transaction che abortiscono la migrazione", () => {
    expect(SQL).toContain("FAIL: slash finale cambia identità canonica");
    expect(SQL).toContain("FAIL: due annunci realmente distinti collassati");
    expect(SQL).toContain("FAIL: url vuoto non fail-closed");
    expect(SQL).toContain("BEGIN;");
    expect(SQL).toContain("COMMIT;");
  });

  it("deduplica per identità canonica prima dei conteggi", () => {
    expect(SQL).toContain("canonical-listing-dedup-v1");
    expect(SQL).toContain("PARTITION BY d.canonical_listing_id");
    expect(SQL).toContain("ORDER BY d.l_last_seen_at DESC NULLS LAST, d.id DESC");
    expect(SQL.indexOf("canonical-listing-dedup-v1")).toBeLessThan(
      SQL.indexOf("count(DISTINCT agency_key) AS n_agenzie"),
    );
  });

  it("richiede >= 2 identità canoniche e >= 2 agenzie nei gruppi certificati", () => {
    expect(SQL).toContain("count(DISTINCT canonical_listing_id) AS n_annunci_canonici");
    expect(SQL).toContain("AND n_annunci_canonici >= 2");
    expect(SQL).toContain("WHERE n_agenzie >= 2");
    expect(SQL).toContain("OR coalesce(n_annunci_canonici, 0) < 2");
  });

  it("QA post-pubblicazione con rollback totale", () => {
    expect(SQL).toContain("QA identita canonica fallita");
    expect(SQL).toContain("count(DISTINCT public.padova_listing_canonical_id(u, NULL))");
    expect(SQL).toMatch(/RAISE EXCEPTION ''QA identita canonica fallita/);
  });

  it("è un patch ancorato fail-closed che non tocca soglie, aste o dati", () => {
    for (const anchor of [
      "anchor v_no_civico non trovato",
      "anchor costruzione _cand non trovato",
      "anchor _unit non trovato",
      "anchor _unit_grp non trovato",
      "anchor _unit_ok non trovato",
      "anchor QA staging non trovato",
      "anchor QA post-pubblicazione non trovato",
      "patch canonical-listing-dedup-v1 non applicata",
    ]) {
      expect(SQL).toContain(anchor);
    }
    expect(SQL).toContain("pg_get_functiondef");
    expect(SQL).not.toMatch(/1\.35|1\.05|greatest\(mq_min/);
    expect(SQL).not.toMatch(/DROP\s+TABLE\s+public\./i);
    expect(SQL).not.toMatch(/TRUNCATE/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+public\./i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.recompute/i);
  });
});
