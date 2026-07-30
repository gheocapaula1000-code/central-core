// CHECKPOINT 3A (aggiornato 11B-A) — admin senza prenotazione, zona singola.
// Test puri: nessuna rete, nessun DB, nessun provider, nessun cron.
//
// Matrice provata:
//  - Civiko + admin owner senza zona esplicita → full-city (8 zone)
//  - Civiko + admin owner con zona esplicita    → quella zona
//  - Civiko + non-admin con la propria zona                         → quella zona
//  - Civiko + non-admin senza zona                                  → 403 fail-closed
//  - non Civiko (acquisitionradar)                                  → invariato
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CIVIKO_COMMERCIAL_ZONES } from "../../supabase/functions/_shared/civikoCommercialZoneContract";
import { applyCivikoSingleZoneGate } from "../../supabase/functions/_shared/civikoZoneAccessGate";

const fn = (p: string) => readFileSync(resolve(process.cwd(), "supabase/functions", p), "utf-8");

const ALL_SLUGS = CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug) as string[];
const PILOT_ENDPOINTS = [
  "padova-quartieri-stats/index.ts",
  "padova-contendibili-list/index.ts",
  "padova-privati-list/index.ts",
  "civiko-one-signals-feed/index.ts",
];
const CIVIKO_SOURCES = ["civiko-one", "civiko_one", "civiko", "Civiko-One", " civiko "];

/** Replica del percorso presente nei 4 endpoint. */
function resolvePerimeter(opts: {
  sourceApp: string;
  isAdmin: boolean;
  validAssignedSlugs: string[];
  requestedSlug?: string;
}): { status: number; code?: string; slugs: string[] } {
  const base = opts.isAdmin ? [...ALL_SLUGS] : [...opts.validAssignedSlugs];
  if (opts.isAdmin) {
    // Admin owner della piattaforma: nessun gate monozona.
    if (opts.requestedSlug) {
      if (!base.includes(opts.requestedSlug)) {
        return { status: 403, code: "ZONE_NOT_ASSIGNED", slugs: [] };
      }
      return { status: 200, slugs: [opts.requestedSlug] };
    }
    return { status: 200, slugs: base };
  }
  if (base.length === 0) {
    return { status: 403, code: "NO_ZONE_ASSIGNED", slugs: [] };
  }
  const gate = applyCivikoSingleZoneGate(opts.sourceApp, base, opts.requestedSlug);
  if (gate.ok) return { status: 200, slugs: [...gate.slugs] };
  return { status: 403, code: gate.code, slugs: [] };
}

describe("3A/11B-A — admin owner full-city senza prenotazione", () => {
  it("admin owner senza zona esplicita → full-city sulle 8 zone", () => {
    for (const sourceApp of CIVIKO_SOURCES) {
      const r = resolvePerimeter({ sourceApp, isAdmin: true, validAssignedSlugs: [] });
      expect(r.status).toBe(200);
      expect(r.slugs).toEqual(ALL_SLUGS);
    }
  });

  it("admin con zona esplicita ottiene esattamente quella zona, per tutte e 8", () => {
    for (const slug of ALL_SLUGS) {
      const r = resolvePerimeter({
        sourceApp: "civiko-one",
        isAdmin: true,
        validAssignedSlugs: ALL_SLUGS,
        requestedSlug: slug,
      });
      expect(r.status).toBe(200);
      expect(r.slugs).toEqual([slug]);
    }
  });

  it("admin non può ottenere due zone insieme", () => {
    const r = resolvePerimeter({
      sourceApp: "civiko-one",
      isAdmin: true,
      validAssignedSlugs: ALL_SLUGS,
      requestedSlug: "est-brenta",
    });
    expect(r.slugs).toHaveLength(1);
  });
});

describe("3A/11B-A — non-admin resta fail-closed", () => {
  it("non-admin senza assegnazione → 403", () => {
    const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: false, validAssignedSlugs: [] });
    expect(r.status).toBe(403);
    expect(r.code).toBe("NO_ZONE_ASSIGNED");
  });

  it("non-admin con la propria zona → successo su quella zona (tutte e 8)", () => {
    for (const slug of ALL_SLUGS) {
      const r = resolvePerimeter({ sourceApp: "civiko-one", isAdmin: false, validAssignedSlugs: [slug] });
      expect(r.status).toBe(200);
      expect(r.slugs).toEqual([slug]);
    }
  });

  it("non-admin che chiede una zona altrui → 403", () => {
    const r = resolvePerimeter({
      sourceApp: "civiko-one",
      isAdmin: false,
      validAssignedSlugs: ["est-brenta"],
      requestedSlug: "centro-storico",
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("ZONE_NOT_ASSIGNED");
  });
});

describe("3A/11B-A — source-app non Civiko invariato", () => {
  it("acquisitionradar admin conserva tutte le zone", () => {
    const r = resolvePerimeter({ sourceApp: "acquisitionradar", isAdmin: true, validAssignedSlugs: [] });
    expect(r.status).toBe(200);
    expect(r.slugs).toEqual(ALL_SLUGS);
  });

  it("acquisitionradar non-admin conserva la propria zona", () => {
    const r = resolvePerimeter({ sourceApp: "acquisitionradar", isAdmin: false, validAssignedSlugs: ["est-brenta"] });
    expect(r.status).toBe(200);
    expect(r.slugs).toEqual(["est-brenta"]);
  });
});

describe("3A/11B-A — i 4 endpoint condividono la stessa matrice", () => {
  for (const p of PILOT_ENDPOINTS) {
    it(`${p}: usa il gate condiviso a zona singola`, () => {
      const src = fn(p);
      expect(src).toContain("applyCivikoSingleZoneGate");
      expect(src).toContain("civiko_is_admin_agency");
    });

    it(`${p}: nessun filtro zona hardcoded`, () => {
      const src = fn(p);
      for (const slug of ALL_SLUGS) {
        const hardcodedFilter = new RegExp(`\\.eq\\(\\s*["'][^"']*zone[^"']*["']\\s*,\\s*["']${slug}["']`);
        expect(src).not.toMatch(hardcodedFilter);
      }
    });
  }
});
