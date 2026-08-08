// CHECKPOINT 3A — Territorio runtime autoritativo Civiko One.
// Test puri: nessuna rete, nessun provider, nessun cron, nessuno scraping.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CIVIKO_COMMERCIAL_ZONES,
  isCivikoCommercialZoneSlug,
} from "../../supabase/functions/_shared/civikoCommercialZoneContract";
import {
  commercialZoneForQuartiere,
} from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere";
import { applyCivikoSingleZoneGate } from "../../supabase/functions/_shared/civikoZoneAccessGate";
import {
  isCivikoPilotSourceApp,
  normalizeSourceApp,
  PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS,
} from "../../supabase/functions/_shared/civikoTerritoryContractPadovaPilotV1";

const fn = (p: string) => readFileSync(resolve(process.cwd(), "supabase/functions", p), "utf-8");

const ALL_SLUGS = CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug);
const PILOT_ENDPOINTS = [
  "padova-quartieri-stats/index.ts",
  "padova-contendibili-list/index.ts",
  "padova-privati-list/index.ts",
  "civiko-one-signals-feed/index.ts",
];

describe("3A — contratto 8 zone invariato", () => {
  it("le 8 zone canoniche restano invariate", () => {
    expect(ALL_SLUGS).toEqual([
      "centro-storico",
      "nord-arcella",
      "est-brenta",
      "nord-est",
      "sud-est-sant-osvaldo",
      "sud-voltabarozzo-guizza",
      "sud-ovest-mandria",
      "ovest-chiesanuova-brentelle",
    ]);
  });

  it("civiko-zones-list continua a esporre tutte le 8 zone", () => {
    const src = fn("civiko-zones-list/index.ts");
    expect(src).not.toMatch(/attiva\s*=\s*false/);
    for (const slug of ALL_SLUGS) {
      expect(src.includes(slug) || src.includes("CIVIKO_COMMERCIAL_ZONES")).toBe(true);
    }
  });

  it("11B-A: tutte e 8 le zone ufficiali sono prenotabili", () => {
    for (const slug of ALL_SLUGS) expect(isCivikoCommercialZoneSlug(slug)).toBe(true);
  });

  it("civiko-zones-reserve rifiuta gli slug fuori contratto prima del DB", () => {
    const src = fn("civiko-zones-reserve/index.ts");
    expect(src).toMatch(/isCivikoCommercialZoneSlug/);
    expect(src).not.toMatch(/pilot_zone_locked/);
  });
});

describe("3A — Stazione / Fiera", () => {
  it("Stazione → centro-storico", () => {
    expect(commercialZoneForQuartiere("Stazione")).toBe("centro-storico");
    expect(commercialZoneForQuartiere("Stazione Ferroviaria")).toBe("centro-storico");
  });

  it("Fiera → est-brenta (fuori pilot)", () => {
    expect(commercialZoneForQuartiere("Fiera")).toBe("est-brenta");
    expect(commercialZoneForQuartiere("Fiera")).not.toBe("centro-storico");
  });

  it("stringhe miste Stazione/Fiera → null", () => {
    const mixed = [
      ...PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS,
      "Stazione / Fiera",
      "Stazione - Fiera",
      "Fiera / Stazione",
      "stazione scrovegni c so del popolo fiera cittadella",
    ];
    for (const k of mixed) expect(commercialZoneForQuartiere(k)).toBeNull();
  });
});

describe("3A — gate pilot puro", () => {
  it("riconosce solo i source-app Civiko", () => {
    for (const s of ["civiko-one", "CIVIKO_ONE", " civiko ", "Civiko-One"]) {
      expect(isCivikoPilotSourceApp(s)).toBe(true);
    }
    for (const s of ["acquisitionradar", "wyloni", "", null, undefined, "sottra"]) {
      expect(isCivikoPilotSourceApp(s)).toBe(false);
    }
    expect(normalizeSourceApp(" Civiko-One ")).toBe("civiko-one");
  });

  it("Civiko full-city senza zona esplicita → fail-closed", () => {
    const g = applyCivikoSingleZoneGate("civiko-one", ALL_SLUGS);
    expect(g).toEqual({ civiko: true, ok: false, code: "MULTIPLE_ZONES_ASSIGNED" });
  });

  it("Civiko non-admin su centro-storico → consentito", () => {
    expect(applyCivikoSingleZoneGate("civiko", ["centro-storico"])).toEqual({
      civiko: true, ok: true, slugs: ["centro-storico"],
    });
  });

  it("Civiko assegnato a una qualunque delle 8 zone → consentito (11B-A)", () => {
    for (const slug of ALL_SLUGS) {
      expect(applyCivikoSingleZoneGate("civiko-one", [slug])).toEqual({
        civiko: true, ok: true, slugs: [slug],
      });
    }
  });

  it("source-app non Civiko conserva il perimetro preesistente", () => {
    const g = applyCivikoSingleZoneGate("acquisitionradar", ALL_SLUGS);
    expect(g.civiko).toBe(false);
    expect(g.ok && g.slugs).toEqual(ALL_SLUGS);
  });

  it("nessuno slug fuori contratto può essere restituito", () => {
    // "fiera" non è uno slug ufficiale: viene scartato → nessuna zona autorizzata.
    expect(applyCivikoSingleZoneGate("civiko-one", ["fiera"])).toEqual({
      civiko: true, ok: false, code: "NO_ZONE_ASSIGNED",
    });
    // slug fuori contratto richiesto dal client → respinto esplicitamente.
    expect(applyCivikoSingleZoneGate("civiko-one", ["est-brenta"], "fiera")).toEqual({
      civiko: true, ok: false, code: "SLUG_OUT_OF_CONTRACT",
    });
  });
});

describe("3A — handler runtime dei 4 endpoint", () => {
  for (const p of PILOT_ENDPOINTS) {
    it(`${p} applica il gate pilot prima delle query dati`, () => {
      const src = fn(p);
      expect(src).toMatch(/applyCivikoSingleZoneGate/);
      expect(src).toMatch(/x-source-app/);
      // gate applicato prima di qualunque query sui dati
      const gateIdx = src.indexOf("applyCivikoSingleZoneGate(");
      const dataIdx = src.indexOf("padova_listings");
      if (dataIdx > -1) expect(gateIdx).toBeLessThan(dataIdx);
      // niente admin full-city per il pilot
      expect(src).toMatch(/isAdmin = false;/);
    });

    it(`${p} filtra la zona nel DB, non solo in memoria`, () => {
      const src = fn(p);
      expect(src).toMatch(/commercial_zone_slug/);
      expect(src).toMatch(/\.(in|eq)\(\s*"commercial_zone_slug"/);
    });

    it(`${p} non chiama provider, cron o scraping`, () => {
      const src = fn(p);
      expect(src).not.toMatch(/apify|firecrawl|perplexity|openai\.com|anthropic|cron\.schedule/i);
    });
  }

  it("padova-quartieri-stats non usa totali globali nella risposta pilot", () => {
    const src = fn("padova-quartieri-stats/index.ts");
    expect(src).toMatch(/const totals = isCivikoScope/);
    expect(src).toMatch(/totaliOut = isCivikoScope \? null : totali/);
    expect(src).toMatch(/civiko_single_zone/);
  });

  it("civiko-one-signals-feed non rinomina record di altra zona", () => {
    const src = fn("civiko-one-signals-feed/index.ts");
    // Nessuna riattribuzione legacy: ogni item conserva il proprio slug ufficiale.
    expect(src).not.toMatch(/actual_commercial_zone_slug/);
    expect(src).not.toMatch(/pwaCompatItems/);
    expect(src).toMatch(/const responseScope = isAdmin \? "admin_full_city"/);
    expect(src).toMatch(/const outItems = trimmed;/);
  });
});
