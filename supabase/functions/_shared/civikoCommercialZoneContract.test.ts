import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CIVIKO_COMMERCIAL_ZONES,
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
  CONSULTA_TO_COMMERCIAL_ZONE,
  commercialZoneForConsulta,
  isCivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

describe("civikoCommercialZoneContract — struttura", () => {
  it("esattamente 8 zone", () => {
    expect(CIVIKO_COMMERCIAL_ZONES).toHaveLength(8);
    expect(CIVIKO_COMMERCIAL_ZONE_SLUGS.size).toBe(8);
  });
  it("slug univoci", () => {
    const slugs = CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  it("nomi univoci", () => {
    const nomi = CIVIKO_COMMERCIAL_ZONES.map((z) => z.nome);
    expect(new Set(nomi).size).toBe(nomi.length);
  });
  it("esattamente 10 consulte, ciascuna una sola volta, nessuna mancante", () => {
    const all = CIVIKO_COMMERCIAL_ZONES.flatMap((z) => z.consulte);
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
    expect([...all].sort()).toEqual(
      ["1", "2", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B"].sort(),
    );
    expect(CONSULTA_TO_COMMERCIAL_ZONE.size).toBe(10);
  });
});

describe("civikoCommercialZoneContract — mapping consulta → zona", () => {
  const cases: Array<[string, string]> = [
    ["1", "centro-storico"],
    ["2", "nord-arcella"],
    ["3A", "est-brenta"],
    ["3B", "nord-est"],
    ["4A", "sud-est-sant-osvaldo"],
    ["4B", "sud-voltabarozzo-guizza"],
    ["5A", "sud-ovest-mandria"],
    ["5B", "ovest-chiesanuova-brentelle"],
    ["6A", "ovest-chiesanuova-brentelle"],
    ["6B", "ovest-chiesanuova-brentelle"],
  ];
  for (const [c, slug] of cases) {
    it(`${c} → ${slug}`, () => {
      expect(commercialZoneForConsulta(c)).toBe(slug);
    });
  }
});

describe("civikoCommercialZoneContract — fail-closed", () => {
  it("rifiuta slug legacy", () => {
    for (const legacy of ["arcella", "portello-stazione-stanga", "torre-ponte-brenta-camin"]) {
      expect(isCivikoCommercialZoneSlug(legacy)).toBe(false);
    }
  });
  it("rifiuta null, stringa vuota, slug sconosciuti", () => {
    expect(isCivikoCommercialZoneSlug(null)).toBe(false);
    expect(isCivikoCommercialZoneSlug(undefined)).toBe(false);
    expect(isCivikoCommercialZoneSlug("")).toBe(false);
    expect(isCivikoCommercialZoneSlug("padova")).toBe(false);
    expect(isCivikoCommercialZoneSlug(42)).toBe(false);
  });
  it("commercialZoneForConsulta ritorna null per input mancanti/ignoti", () => {
    expect(commercialZoneForConsulta(null)).toBeNull();
    expect(commercialZoneForConsulta(undefined)).toBeNull();
    expect(commercialZoneForConsulta("")).toBeNull();
    expect(commercialZoneForConsulta("7")).toBeNull();
    expect(commercialZoneForConsulta("3")).toBeNull();
    expect(commercialZoneForConsulta("3a")).toBeNull(); // no normalizzazioni silenziose
    expect(commercialZoneForConsulta(1)).toBeNull();
  });
});

describe("civikoCommercialZoneContract — isolamento", () => {
  it("il modulo non contiene riferimenti a OMI, CAP o Supabase", () => {
    const src = readFileSync(
      new URL("./civikoCommercialZoneContract.ts", import.meta.url),
      "utf8",
    );
    // Rimuoviamo i commenti prima di controllare i simboli vietati, così il
    // disclaimer documentale ("non coincidono con le zone OMI") non falsa il test.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bomi\b/i);
    expect(code).not.toMatch(/\bcap\b/i);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/from\s+["'][^"']+["']/); // nessun import
  });
});
