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
import {
  applyPadovaPilotZoneGate,
  isCivikoPilotSourceApp,
  normalizeSourceApp,
  PADOVA_PILOT_ALLOWED_ZONE_SLUG,
  PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS,
  isPadovaPilotAllowedZoneSlug,
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
      "est-forcellini-camin",
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

  it("solo Centro Storico è pilot_reservable", () => {
    expect(isPadovaPilotAllowedZoneSlug("centro-storico")).toBe(true);
    for (const slug of ALL_SLUGS.filter((s) => s !== "centro-storico")) {
      expect(isPadovaPilotAllowedZoneSlug(slug)).toBe(false);
    }
  });

  it("civiko-zones-reserve rifiuta gli altri 7 slug prima del DB", () => {
    const src = fn("civiko-zones-reserve/index.ts");
    expect(src).toMatch(/pilot_zone_locked/);
    expect(src).toMatch(/isPadovaPilotAllowedZoneSlug/);
  });
});

describe("3A — Stazione / Fiera", () => {
  it("Stazione → centro-storico", () => {
    expect(commercialZoneForQuartiere("Stazione")).toBe("centro-storico");
    expect(commercialZoneForQuartiere("Stazione Ferroviaria")).toBe("centro-storico");
  });

  it("Fiera → est-brenta (fuori pilot)", () => {
    expect(commercialZoneForQuartiere("Fiera")).toBe("est-brenta");
    expect(isPadovaPilotAllowedZoneSlug(commercialZoneForQuartiere("Fiera"))).toBe(false);
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

  it("Civiko admin full-city → solo centro-storico", () => {
    const g = applyPadovaPilotZoneGate("civiko-one", ALL_SLUGS);
    expect(g.pilot).toBe(true);
    expect(g.slugs).toEqual([PADOVA_PILOT_ALLOWED_ZONE_SLUG]);
  });

  it("Civiko non-admin su centro-storico → consentito", () => {
    expect(applyPadovaPilotZoneGate("civiko", ["centro-storico"]).slugs).toEqual(["centro-storico"]);
  });

  it("Civiko assegnato ad altra zona → insieme vuoto (fail-closed)", () => {
    for (const slug of ALL_SLUGS.filter((s) => s !== "centro-storico")) {
      expect(applyPadovaPilotZoneGate("civiko-one", [slug]).slugs).toEqual([]);
    }
  });

  it("source-app non Civiko conserva il perimetro preesistente", () => {
    const g = applyPadovaPilotZoneGate("acquisitionradar", ALL_SLUGS);
    expect(g.pilot).toBe(false);
    expect(g.slugs).toEqual(ALL_SLUGS);
  });

  it("nessuno slug fuori contratto può essere restituito", () => {
    expect(applyPadovaPilotZoneGate("civiko-one", ["fiera"]).slugs).toEqual([]);
    expect(applyPadovaPilotZoneGate("civiko-one", ALL_SLUGS).slugs.every(isCivikoCommercialZoneSlug)).toBe(true);
  });
});

describe("3A — handler runtime dei 4 endpoint", () => {
  for (const p of PILOT_ENDPOINTS) {
    it(`${p} applica il gate pilot prima delle query dati`, () => {
      const src = fn(p);
      expect(src).toMatch(/applyPadovaPilotZoneGate/);
      expect(src).toMatch(/PILOT_ZONE_NOT_ASSIGNED/);
      expect(src).toMatch(/x-source-app/);
      // gate applicato prima di qualunque query sui dati
      const gateIdx = src.indexOf("applyPadovaPilotZoneGate(");
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
    expect(src).toMatch(/const totals = isPilot/);
    expect(src).toMatch(/totaliOut = isPilot \? null : totali/);
    expect(src).toMatch(/padova_pilot_v1_centro_storico/);
  });

  it("civiko-one-signals-feed non rinomina record di altra zona", () => {
    const src = fn("civiko-one-signals-feed/index.ts");
    expect(src).toMatch(/actual_commercial_zone_slug/);
    expect(src).toMatch(/const pwaCompatItems = isAdmin/);
  });
});
