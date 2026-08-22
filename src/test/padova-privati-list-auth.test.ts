// Tests for padova-privati-list — server-side auth + zone authorization contract.
//
// The edge function itself uses Deno-only imports and cannot be executed under
// vitest. Following the pattern used elsewhere in this repo
// (see padova-private-leads-zones.test.ts), we combine:
//   1) static assertions on the source file (grep-style) to guarantee the
//      security-critical guarantees are wired in the actual code shipped;
//   2) behavioural tests for the pure zone-resolution logic that the endpoint
//      relies on (reimplemented here identically to keep test isolation).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  commercialZoneForQuartiere,
} from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere.ts";
import {
  isCivikoCommercialZoneSlug,
} from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/padova-privati-list/index.ts"),
  "utf8",
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────
// Pure reimplementation of the zone-resolution rules used by the endpoint.
// Kept in the test so behaviour is verifiable without booting Deno.
// ─────────────────────────────────────────────────────────────
type ZoneRow = {
  slug: string;
  status: string;
  occupied_agency_id: string | null;
  trial_agency_id: string | null;
  trial_reserved_until: string | null;
};
type Verdict =
  | { ok: true; slug: string }
  | { ok: false; code: "NO_ZONE_ASSIGNED" | "MULTIPLE_ZONES_ASSIGNED" | "SLUG_OUT_OF_CONTRACT" };

function resolveAssignedZone(rows: ZoneRow[], workspaceId: string, now = Date.now()): Verdict {
  const valid = rows.filter((z) => {
    if (z.status === "occupata" && z.occupied_agency_id === workspaceId) return true;
    if (
      z.status === "in_trial" &&
      z.trial_agency_id === workspaceId &&
      typeof z.trial_reserved_until === "string" &&
      new Date(z.trial_reserved_until).getTime() > now
    ) return true;
    return false;
  });
  if (valid.length === 0) return { ok: false, code: "NO_ZONE_ASSIGNED" };
  if (valid.length > 1) return { ok: false, code: "MULTIPLE_ZONES_ASSIGNED" };
  const slug = valid[0].slug;
  if (!isCivikoCommercialZoneSlug(slug)) return { ok: false, code: "SLUG_OUT_OF_CONTRACT" };
  return { ok: true, slug };
}

const WID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IN_FUTURE = new Date(Date.now() + 3600_000).toISOString();
const IN_PAST = new Date(Date.now() - 3600_000).toISOString();

// ─────────────────────────────────────────────────────────────
// STATIC GUARANTEES on the shipped edge function
// ─────────────────────────────────────────────────────────────
describe("padova-privati-list — source guarantees", () => {
  it("verifies the shared secret before any DB client or query", () => {
    const idxSecret = SRC.indexOf("requireSecret(req, debugId)");
    const idxCreate = SRC.indexOf("createClient(");
    const idxFrom = SRC.indexOf(".from(");
    expect(idxSecret).toBeGreaterThan(-1);
    expect(idxCreate).toBeGreaterThan(idxSecret);
    expect(idxFrom).toBeGreaterThan(idxSecret);
  });

  it("reads workspace_id EXCLUSIVELY from x-workspace-id header", () => {
    expect(SRC).toMatch(/req\.headers\.get\(["']x-workspace-id["']\)/);
    // must NOT read workspace_id from body or query string
    expect(SRC).not.toMatch(/bodyPayload\.workspace_id/);
    expect(SRC).not.toMatch(/searchParams\.get\(["']workspace_id["']\)/);
    // UUID validation present
    expect(SRC).toMatch(/UUID_RE\.test\(workspaceId\)/);
  });

  it("resolves zone via civiko_commercial_zones with occupata OR in_trial rules only", () => {
    expect(SRC).toContain('.from("civiko_commercial_zones")');
    expect(SRC).toContain("status.eq.occupata");
    expect(SRC).toContain("status.eq.in_trial");
    expect(SRC).toContain("occupied_agency_id");
    expect(SRC).toContain("trial_agency_id");
    expect(SRC).toContain("trial_reserved_until");
    // NO legacy agency_id fallback in the auth path
    const authSlice = SRC.split(".from(\"padova_listings\")")[0];
    expect(authSlice).not.toMatch(/\bagency_id\.eq\./);
  });

  it("enforces isCivikoCommercialZoneSlug on the resolved slug", () => {
    expect(SRC).toContain("isCivikoCommercialZoneSlug(s)");
  });

  it("filters EVERY padova_listings query by assignedSlug (server-side)", () => {
    // The single source of the zone filter is applyFilters(), which contains
    // the .eq on commercial_zone_slug with the server-resolved assignedSlug.
    expect(SRC).toContain('.eq("commercial_zone_slug", assignedSlug)');
    // applyFilters must be the only wrapper used around padova_listings reads.
    const rawFroms = [...SRC.matchAll(/supabase\.from\("padova_listings"\)/g)];
    expect(rawFroms.length).toBeGreaterThanOrEqual(2);
    // Each padova_listings access is composed inside an applyFilters(...) call,
    // which spans across newlines just before the `.from(...)` occurrence.
    for (const m of rawFroms) {
      const start = Math.max(0, (m.index ?? 0) - 120);
      const window = SRC.slice(start, (m.index ?? 0) + 40);
      expect(window).toMatch(/applyFilters\(/);
    }
  });

  it("never trusts commercial_zone_slug from body/query as authority", () => {
    // Client value is never used to build .eq("commercial_zone_slug", ...)
    expect(SRC).not.toMatch(/\.eq\(\s*["']commercial_zone_slug["']\s*,\s*(payload|bodyPayload|qp|url\.searchParams|pickStr)/);
    // Only assignedSlug drives the filter.
    const eqLines = [...SRC.matchAll(/\.eq\(\s*["']commercial_zone_slug["']\s*,\s*([^)]+)\)/g)];
    expect(eqLines.length).toBeGreaterThanOrEqual(1);
    for (const m of eqLines) expect(m[1].trim()).toBe("assignedSlug");
  });

  it("resolves optional quartiere against the assigned zone (fail-closed)", () => {
    expect(SRC).toContain("commercialZoneForQuartiere(quartiereRaw)");
    expect(SRC).toContain("QUARTIERE_OUT_OF_ZONE");
  });

  it("preserves existing filters: tipo_lead, solo_con_telefono, offset, limit, ordering, sanitize", () => {
    expect(SRC).toContain("tipo_lead");
    expect(SRC).toContain("solo_con_telefono");
    expect(SRC).toMatch(/\.range\(offset,\s*offset\s*\+\s*limit\s*-\s*1\)/);
    expect(SRC).toContain('.order("telefono"');
    expect(SRC).toContain('.order("prezzo"');
    expect(SRC).toContain("sanitize(data ?? [])");
  });

  it("nessun bypass all-zones per i chiamanti Civiko One (11B-A)", () => {
    // L'eventuale ramo admin (uso interno Central Core) resta subordinato al
    // gate zona singola: per source-app Civiko l'admin viene disattivato.
    expect(SRC).toContain("applyCivikoSingleZoneGate");
    expect(SRC).toMatch(/gate\.civiko[\s\S]{0,400}isAdmin = false/);
  });

  it("keeps the successful response shape compatible with the PWA", () => {
    expect(SRC).toMatch(/ok:\s*true/);
    expect(SRC).toMatch(/privati,\s*\n\s*total,/);
    expect(SRC).toMatch(/con_telefono,/);
    // Nested data keeps `privati` for existing PWA clients and adds `items`
    // as an alias so newer callers can use the same list without a rename.
    expect(SRC).toMatch(
      /data:\s*\{\s*items:\s*privati,\s*privati,\s*total,\s*con_telefono\s*\}/,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// BEHAVIOURAL tests on the zone-resolution rules
// ─────────────────────────────────────────────────────────────
describe("padova-privati-list — zone resolution rules", () => {
  it("returns SLUG when workspace occupies a valid contract zone", () => {
    const v = resolveAssignedZone(
      [{ slug: "centro-storico", status: "occupata", occupied_agency_id: WID, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(v).toEqual({ ok: true, slug: "centro-storico" });
  });

  it("returns SLUG for a valid in_trial reservation", () => {
    const v = resolveAssignedZone(
      [{ slug: "nord-arcella", status: "in_trial", occupied_agency_id: null, trial_agency_id: WID, trial_reserved_until: IN_FUTURE }],
      WID,
    );
    expect(v).toEqual({ ok: true, slug: "nord-arcella" });
  });

  it("fails NO_ZONE_ASSIGNED when the trial is expired", () => {
    const v = resolveAssignedZone(
      [{ slug: "centro-storico", status: "in_trial", occupied_agency_id: null, trial_agency_id: WID, trial_reserved_until: IN_PAST }],
      WID,
    );
    expect(v).toEqual({ ok: false, code: "NO_ZONE_ASSIGNED" });
  });

  it("fails NO_ZONE_ASSIGNED when zone belongs to another workspace", () => {
    const v = resolveAssignedZone(
      [{ slug: "centro-storico", status: "occupata", occupied_agency_id: OTHER, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(v.ok).toBe(false);
  });

  it("fails NO_ZONE_ASSIGNED when zone is merely available", () => {
    const v = resolveAssignedZone(
      [{ slug: "centro-storico", status: "disponibile", occupied_agency_id: null, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(v.ok).toBe(false);
  });

  it("fails MULTIPLE_ZONES_ASSIGNED when more than one matches", () => {
    const v = resolveAssignedZone(
      [
        { slug: "centro-storico", status: "occupata", occupied_agency_id: WID, trial_agency_id: null, trial_reserved_until: null },
        { slug: "nord-arcella", status: "in_trial", occupied_agency_id: null, trial_agency_id: WID, trial_reserved_until: IN_FUTURE },
      ],
      WID,
    );
    expect(v).toEqual({ ok: false, code: "MULTIPLE_ZONES_ASSIGNED" });
  });

  it("fails SLUG_OUT_OF_CONTRACT when assigned zone slug is not in the 8-zone contract", () => {
    const v = resolveAssignedZone(
      [{ slug: "legacy-slug-fuori-contratto", status: "occupata", occupied_agency_id: WID, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(v).toEqual({ ok: false, code: "SLUG_OUT_OF_CONTRACT" });
  });
});

// ─────────────────────────────────────────────────────────────
// Header validation used by the endpoint
// ─────────────────────────────────────────────────────────────
describe("padova-privati-list — workspace header validation", () => {
  it("accepts a canonical UUID", () => {
    expect(UUID_RE.test(WID)).toBe(true);
  });
  it("rejects non-UUID workspace identifiers", () => {
    for (const bad of ["", "not-a-uuid", "12345", "workspace-1", "'; DROP TABLE"]) {
      expect(UUID_RE.test(bad)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Quartiere filter — must belong to the assigned zone (fail-closed)
// ─────────────────────────────────────────────────────────────
describe("padova-privati-list — quartiere filter authorization", () => {
  it("accepts a quartiere that resolves to the assigned zone", () => {
    const assigned = "centro-storico";
    const resolved = commercialZoneForQuartiere("Centro Storico");
    expect(resolved).toBe(assigned);
  });
  it("rejects a quartiere that resolves to a different zone", () => {
    const assigned = "centro-storico";
    const resolved = commercialZoneForQuartiere("Crocifisso");
    expect(resolved).not.toBe(assigned);
    expect(resolved).not.toBeNull();
  });
  it("rejects an unknown quartiere as null", () => {
    expect(commercialZoneForQuartiere("Quartiere Inventato XYZ")).toBeNull();
  });
});
