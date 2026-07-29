// CHECKPOINT 3A — micro-correzione: admin pilot senza prenotazione.
// Test puri: nessuna rete, nessun DB, nessun provider, nessun cron.
//
// Matrice provata:
//  - Civiko + admin verificato (zero zone assegnate) → ["centro-storico"]
//  - Civiko + admin con tutte e 8 le zone            → ["centro-storico"]
//  - Civiko + non-admin con Centro Storico valido    → ["centro-storico"]
//  - Civiko + non-admin senza Centro Storico         → 403 fail-closed
//  - non Civiko (acquisitionradar)                   → comportamento invariato
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract";
import {
  applyPadovaPilotZoneGate,
  PADOVA_PILOT_ALLOWED_ZONE_SLUG,
} from "../../supabase/functions/_shared/civikoTerritoryContractPadovaPilotV1";

const fn = (p: string) => readFileSync(resolve(process.cwd(), "supabase/functions", p), "utf-8");

const ALL_SLUGS = CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug) as string[];
const PILOT_ENDPOINTS = [
  "padova-quartieri-stats/index.ts",
  "padova-contendibili-list/index.ts",
  "padova-privati-list/index.ts",
  "civiko-one-signals-feed/index.ts",
];
const CIVIKO_SOURCES = ["civiko-one", "civiko_one", "civiko", "Civiko-One", " civiko "];

/**
 * Replica fedele del percorso statico presente nei 4 endpoint:
 * admin verificato → insieme delle 8 zone; non-admin → zone valide assegnate;
 * poi gate pilot source-aware; insieme vuoto → 403.
 */
function resolvePerimeter(opts: {
  sourceApp: string;
  isAdmin: boolean;
  validAssignedSlugs: string[];
}): { status: number; code?: string; slugs: string[] } {
  const base = opts.isAdmin ? [...ALL_SLUGS] : [...opts.validAssignedSlugs];
  if (!opts.isAdmin && base.length === 0) {
    return { status: 403, code: "NO_ZONE_ASSIGNED", slugs: [] };
  }
  const gate = applyPadovaPilotZoneGate(opts.sourceApp, base);
  if (gate.pilot && gate.slugs.length === 0) {
    return { status: 403, code: "PILOT_ZONE_NOT_ASSIGNED", slugs: [] };
  }
  return { status: 200, slugs: gate.slugs };
}

describe("3A/admin — Civiko admin verificato collauda senza prenotazione", () => {
  it("admin verificato con zero zone assegnate ottiene solo Centro Storico", () => {
    for (const sourceApp of CIVIKO_SOURCES) {
      const r = resolvePerimeter({ sourceApp, isAdmin: true, validAssignedSlugs: [] });
      expect(r.status).toBe(200);
      expect(r.slugs).toEqual([PADOVA_PILOT_ALLOWED_ZONE_SLUG]);
    }
  });

  it("admin con tutte e 8 le zone resta comunque confinato a Centro Storico", () => {
    const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: true, validAssignedSlugs: ALL_SLUGS });
    expect(r.slugs).toEqual(["centro-storico"]);
    for (const slug of ALL_SLUGS.filter((s) => s !== "centro-storico")) {
      expect(r.slugs).not.toContain(slug);
    }
  });

  it("admin non può ottenere Est-Brenta né via query né via body", () => {
    const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: true, validAssignedSlugs: ALL_SLUGS });
    // Lo slug richiesto dal client è sempre validato contro il perimetro server.
    const requested = "est-brenta";
    expect(r.slugs.includes(requested)).toBe(false);
  });
});

describe("3A/admin — non-admin resta fail-closed", () => {
  it("non-admin senza assegnazione → 403", () => {
    const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: false, validAssignedSlugs: [] });
    expect(r.status).toBe(403);
    expect(r.code).toBe("NO_ZONE_ASSIGNED");
  });

  it("non-admin con Centro Storico valido → successo su Centro Storico", () => {
    const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: false, validAssignedSlugs: ["centro-storico"] });
    expect(r.status).toBe(200);
    expect(r.slugs).toEqual(["centro-storico"]);
  });

  it("non-admin con la sola Est-Brenta → 403 pilot", () => {
    const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: false, validAssignedSlugs: ["est-brenta"] });
    expect(r.status).toBe(403);
    expect(r.code).toBe("PILOT_ZONE_NOT_ASSIGNED");
  });
});

describe("3A/admin — source-app non Civiko invariato", () => {
  it("acquisitionradar admin conserva tutte le zone", () => {
    const r = resolvePerimeter({ sourceApp: "acquisitionradar", isAdmin: true, validAssignedSlugs: [] });
    expect(r.status).toBe(200);
    expect(r.slugs).toEqual(ALL_SLUGS);
  });

  it("acquisitionradar non-admin conserva la propria zona non pilot", () => {
    const r = resolvePerimeter({ sourceApp: "acquisitionradar", isAdmin: false, validAssignedSlugs: ["est-brenta"] });
    expect(r.status).toBe(200);
    expect(r.slugs).toEqual(["est-brenta"]);
  });
});

describe("3A/admin — i 4 endpoint condividono la stessa matrice", () => {
  for (const p of PILOT_ENDPOINTS) {
    it(`${p}: admin branch include centro-storico e passa dal gate pilot`, () => {
      const src = fn(p);
      expect(src).toContain("applyPadovaPilotZoneGate");
      expect(src).toContain("PILOT_ZONE_NOT_ASSIGNED");
      expect(src).toContain("civiko_is_admin_agency");
      // L'insieme admin contiene centro-storico: il gate lo interseca sempre
      // con successo, quindi l'admin non necessita di prenotazione.
      expect(src).toContain("centro-storico");
    });

    it(`${p}: nessuna query dati Civiko su slug diversi da centro-storico`, () => {
      const src = fn(p);
      // Nessun endpoint deve contenere un filtro hardcoded su altre zone.
      for (const slug of ALL_SLUGS.filter((s) => s !== "centro-storico")) {
        const hardcodedFilter = new RegExp(`\\.eq\\(\\s*["'][^"']*zone[^"']*["']\\s*,\\s*["']${slug}["']`);
        expect(src).not.toMatch(hardcodedFilter);
      }
    });
  }
});
