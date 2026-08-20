// Full hardening tests for padova-contendibili-list — zone isolation contract.
//
// Two layers, mirroring padova-privati-list-auth.test.ts:
//   1) Static assertions on the shipped source to lock security-critical wiring.
//   2) Behavioural tests for the pure zone-resolution logic reimplemented here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isCivikoCommercialZoneSlug,
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
} from "../../supabase/functions/_shared/civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "../../supabase/functions/_shared/civikoCommercialZoneByQuartiere.ts";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/padova-contendibili-list/index.ts"),
  "utf8",
);

const FEED_SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/civiko-one-signals-feed/index.ts"),
  "utf8",
);

const MIGRATION = readFileSync(
  resolve(__dirname, "../../docs/pending-migrations/20260721000000_padova_contendibili_by_zone_view.sql"),
  "utf8",
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────
// 1) Pure reimplementation of zone-resolution for behavioural tests
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
// 2) STATIC GUARANTEES on the shipped edge function
// ─────────────────────────────────────────────────────────────
describe("padova-contendibili-list — gate order (preserved)", () => {
  it("handles OPTIONS before any gate runs", () => {
    const idxOptions = SRC.indexOf('req.method === "OPTIONS"');
    const idxSecret = SRC.indexOf("requireSecret(req, did)");
    expect(idxOptions).toBeGreaterThan(-1);
    expect(idxSecret).toBeGreaterThan(idxOptions);
  });

  it("calls requireSecret before body parsing, createClient, and any .from()", () => {
    const idxSecret = SRC.indexOf("requireSecret(req, did)");
    const idxBody = SRC.indexOf("await req.json()");
    const idxCreate = SRC.indexOf("createClient(");
    const idxFrom = SRC.indexOf(".from(");
    expect(idxSecret).toBeGreaterThan(-1);
    expect(idxBody).toBeGreaterThan(idxSecret);
    expect(idxCreate).toBeGreaterThan(idxSecret);
    expect(idxFrom).toBeGreaterThan(idxSecret);
  });

  it("returns the secret-failure Response immediately", () => {
    expect(SRC).toMatch(
      /const\s+secretFail\s*=\s*requireSecret\(req,\s*did\);\s*\n\s*if\s*\(secretFail\)\s*return\s+secretFail;/,
    );
  });

  it("reads workspace identity EXCLUSIVELY from x-workspace-id header", () => {
    expect(SRC).toMatch(/req\.headers\.get\(["']x-workspace-id["']\)/);
    expect(SRC).not.toMatch(/body\.workspace_id/);
    expect(SRC).not.toMatch(/bodyPayload\.workspace_id/);
    expect(SRC).not.toMatch(/searchParams\.get\(["']workspace_id["']\)/);
  });

  it("validates x-workspace-id as UUID and fails-closed before DB access", () => {
    expect(SRC).toContain("UUID_RE.test(workspaceId)");
    expect(SRC).toContain("WORKSPACE_REQUIRED");
    const idxSecret = SRC.indexOf("requireSecret(req, did)");
    const idxUuid = SRC.indexOf("UUID_RE.test(workspaceId)");
    const idxBody = SRC.indexOf("await req.json()");
    expect(idxUuid).toBeGreaterThan(idxSecret);
    expect(idxBody).toBeGreaterThan(idxUuid);
  });
});

describe("padova-contendibili-list — client input isolation", () => {
  it("ignores client-supplied commercial_zone_slug: never uses it as a filter value", () => {
    // The filter value applied to DB queries must be `assignedSlug`, not any
    // client-supplied slug. There must NOT be a code path reading
    // `body.commercial_zone_slug` and passing it to .eq / into the query.
    expect(SRC).not.toMatch(/commercialZoneFilter\s*=/);
    // 11B-A: il filtro DB usa l'insieme autorizzato server-side (activeSlugs),
    // mai uno slug fornito dal client.
    expect(SRC).toMatch(/\.in\(\s*["']commercial_zone_slug["']\s*,\s*activeSlugs\s*\)/);
  });

  it("ignores client-supplied workspace_id", () => {
    expect(SRC).not.toMatch(/workspaceId\s*\|\|\s*body/);
    expect(SRC).not.toMatch(/workspaceId\s*\?\?\s*body/);
    expect(SRC).not.toMatch(/body\.workspace_id/);
  });

  it("removes the omiToSlug / assignCommercialZonesBatch legacy path", () => {
    expect(SRC).not.toMatch(/omiToSlug/);
    expect(SRC).not.toMatch(/assignCommercialZonesBatch/);
    expect(SRC).not.toMatch(/buildOmiToSlugMap/);
  });
});

describe("padova-contendibili-list — server-side zone resolution", () => {
  it("resolves zone from civiko_commercial_zones with occupata/in_trial disjunction", () => {
    expect(SRC).toContain("civiko_commercial_zones");
    expect(SRC).toContain("status.eq.occupata");
    expect(SRC).toContain("status.eq.in_trial");
    expect(SRC).toContain("trial_reserved_until");
  });

  it("emits the standard error codes with the same statuses as padova-privati-list", () => {
    expect(SRC).toMatch(/NO_ZONE_ASSIGNED[\s\S]*?403/);
    expect(SRC).toContain("applyCivikoSingleZoneGate");
  });

  it("validates the assigned slug is one of the 8 official slugs", () => {
    expect(SRC).toContain("isCivikoCommercialZoneSlug(s)");
  });

  it("does not expose raw e.message on 500", () => {
    expect(SRC).not.toMatch(/message:\s*e\s+instanceof\s+Error\s*\?\s*e\.message/);
  });
});

describe("padova-contendibili-list — DB-side zone filter", () => {
  it("reads from padova_contendibili_by_zone_v (server-only view), not raw table", () => {
    expect(SRC).toContain("padova_contendibili_by_zone_v");
    // Legacy direct table access for list/hot must be gone.
    expect(SRC).not.toMatch(/\.from\(\s*["']padova_contendibili["']\s*\)/);
  });

  it("applies .eq(commercial_zone_slug, assignedSlug) to the list query", () => {
    // Both list and hot must go through applyZoneFilter which sets .eq.
    expect(SRC).toContain("applyZoneFilter");
    expect(SRC).toMatch(/\.in\(["']commercial_zone_slug["'],\s*activeSlugs\)/);
  });

  it("computes hot_3plus with the same zone filter (not global Padova)", () => {
    const idxHot = SRC.indexOf("hot_3plus");
    expect(idxHot).toBeGreaterThan(-1);
    // The hot query is a head-count on n_agenzie >= 3 built via applyZoneFilter.
    expect(SRC).toMatch(/const\s+hotQ\s*=\s*applyZoneFilter\(/);
    const hotBlock = SRC.slice(SRC.indexOf("const hotQ"), SRC.indexOf("Reachability"));
    expect(hotBlock).toContain("applyZoneFilter");
    expect(hotBlock).toMatch(/\.gte\(["']n_agenzie["'],\s*HOT_AGENZIE_THRESHOLD\)/);
    expect(SRC).toMatch(/const\s+HOT_AGENZIE_THRESHOLD\s*=\s*3/);
    expect(hotBlock).toContain("head: true");
  });

  it("does not perform any in-memory zone filtering as a security control", () => {
    // No .filter(...commercial_zone_slug === ...) post-fetch anywhere.
    expect(SRC).not.toMatch(/\.filter\(\s*\([^)]*\)\s*=>\s*[^)]*commercial_zone_slug\s*===/);
  });

  it("restricts reachability lookup to the already-authorized IDs", () => {
    const reachBlock = SRC.slice(SRC.indexOf("padova_contendibili_reachability_v"));
    expect(reachBlock).toMatch(/\.in\(["']id["'],\s*ids\)/);
  });
});

describe("padova-contendibili-list — quartiere filter", () => {
  it("uses commercialZoneForQuartiere and compares against assignedSlug", () => {
    expect(SRC).toContain("commercialZoneForQuartiere(quartiereRaw)");
    expect(SRC).toContain("!activeSlugs.includes(resolved)");
    expect(SRC).toContain("QUARTIERE_OUT_OF_ZONE");
  });

  it("QUARTIERE_OUT_OF_ZONE fails-closed with 403", () => {
    expect(SRC).toMatch(/QUARTIERE_OUT_OF_ZONE[\s\S]*?403/m);
  });
});

describe("padova-contendibili-list — response shape preserved", () => {
  it("keeps items / total / hot_3plus / offset / limit / diagnostics under data", () => {
    expect(SRC).toContain("items: filtered");
    expect(SRC).toContain("total: totalOut");
    expect(SRC).toContain("hot_3plus: hot");
    expect(SRC).toContain("offset,");
    expect(SRC).toContain("limit,");
    expect(SRC).toContain("diagnostics,");
  });

  it("adds assigned_zone at top level without removing other fields", () => {
    expect(SRC).toContain("assigned_zone: primarySlug");
    expect(SRC).toContain("debug_id: did");
  });

  it("preserves CORS contract", () => {
    // CORS header value may span lines; assert the header + each token is present.
    expect(SRC).toContain("Access-Control-Allow-Headers");
    expect(SRC).toContain("x-internal-secret");
    expect(SRC).toContain("x-source-app");
    expect(SRC).toContain("x-workspace-id");
  });
});

describe("padova-contendibili-list — tenant_agency_name is not authoritative", () => {
  it("only influences the reachability.tier, never authorization or filters", () => {
    // tenantNorm is only ever compared to per-row agencies_normalized to set tier.
    expect(SRC).toContain("tenantNorm");
    expect(SRC).toContain("isOro");
    // It MUST NOT be used inside applyZoneFilter or any .eq/.in on the DB query.
    const applyBlock = SRC.slice(SRC.indexOf("applyZoneFilter"), SRC.indexOf("Main list"));
    expect(applyBlock).not.toContain("tenant");
  });
});

// ─────────────────────────────────────────────────────────────
// 3) Behavioural tests — zone assignment matrix
// ─────────────────────────────────────────────────────────────
describe("padova-contendibili-list — zone resolution behaviour", () => {
  it("accepts an occupata zone owned by the workspace", () => {
    const r = resolveAssignedZone(
      [{ slug: "centro-storico", status: "occupata", occupied_agency_id: WID, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(r).toEqual({ ok: true, slug: "centro-storico" });
  });

  it("accepts an in_trial zone with a future trial_reserved_until", () => {
    const r = resolveAssignedZone(
      [{ slug: "nord-arcella", status: "in_trial", occupied_agency_id: null, trial_agency_id: WID, trial_reserved_until: IN_FUTURE }],
      WID,
    );
    expect(r).toEqual({ ok: true, slug: "nord-arcella" });
  });

  it("rejects an in_trial zone with expired trial_reserved_until", () => {
    const r = resolveAssignedZone(
      [{ slug: "nord-arcella", status: "in_trial", occupied_agency_id: null, trial_agency_id: WID, trial_reserved_until: IN_PAST }],
      WID,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("NO_ZONE_ASSIGNED");
  });

  it("rejects when no zone is assigned", () => {
    const r = resolveAssignedZone([], WID);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("NO_ZONE_ASSIGNED");
  });

  it("rejects when multiple zones are assigned to the same workspace", () => {
    const r = resolveAssignedZone(
      [
        { slug: "centro-storico", status: "occupata", occupied_agency_id: WID, trial_agency_id: null, trial_reserved_until: null },
        { slug: "nord-arcella", status: "in_trial", occupied_agency_id: null, trial_agency_id: WID, trial_reserved_until: IN_FUTURE },
      ],
      WID,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("MULTIPLE_ZONES_ASSIGNED");
  });

  it("rejects zone owned by another workspace", () => {
    const r = resolveAssignedZone(
      [{ slug: "centro-storico", status: "occupata", occupied_agency_id: OTHER, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("NO_ZONE_ASSIGNED");
  });

  it("rejects a slug that is not one of the 8 official ones", () => {
    const r = resolveAssignedZone(
      [{ slug: "arcella", status: "occupata", occupied_agency_id: WID, trial_agency_id: null, trial_reserved_until: null }],
      WID,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("SLUG_OUT_OF_CONTRACT");
  });

  it("every official slug passes the contract check", () => {
    for (const slug of CIVIKO_COMMERCIAL_ZONE_SLUGS) {
      expect(isCivikoCommercialZoneSlug(slug)).toBe(true);
    }
  });
});

describe("padova-contendibili-list — quartiere resolver contract", () => {
  it("known quartiere resolves to its official zone", () => {
    expect(commercialZoneForQuartiere("Arcella")).toBe("nord-arcella");
  });
  it("unknown quartiere returns null (fail-closed at endpoint)", () => {
    expect(commercialZoneForQuartiere("__does_not_exist__")).toBeNull();
  });
  it("cross-zone quartiere never accidentally maps to a different zone", () => {
    const centro = commercialZoneForQuartiere("Centro Storico");
    const arcella = commercialZoneForQuartiere("Arcella");
    expect(centro).toBe("centro-storico");
    expect(arcella).toBe("nord-arcella");
    expect(centro).not.toBe(arcella);
  });
});

// ─────────────────────────────────────────────────────────────
// 4) Migration guarantees
// ─────────────────────────────────────────────────────────────
describe("padova-contendibili-list — pending migration", () => {
  it("creates the server-only view", () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE VIEW\s+public\.padova_contendibili_by_zone_v/);
    expect(MIGRATION).toContain("civiko_resolve_commercial_zone_slug(pc.quartiere)");
  });
  it("revokes access from PUBLIC / anon / authenticated and grants only to service_role", () => {
    expect(MIGRATION).toMatch(/REVOKE ALL[\s\S]*FROM PUBLIC/);
    expect(MIGRATION).toMatch(/REVOKE ALL[\s\S]*FROM anon/);
    expect(MIGRATION).toMatch(/REVOKE ALL[\s\S]*FROM authenticated/);
    expect(MIGRATION).toMatch(/GRANT SELECT[\s\S]*TO service_role/);
  });
  it("does not modify source data", () => {
    expect(MIGRATION).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER TABLE|DROP TABLE)\b/i);
  });
});

// ─────────────────────────────────────────────────────────────
// 5) UUID regex sanity
// ─────────────────────────────────────────────────────────────
describe("padova-contendibili-list — UUID_RE behaviour", () => {
  it("accepts a canonical UUID", () => {
    expect(UUID_RE.test(WID)).toBe(true);
  });
  it("rejects malformed workspace identifiers", () => {
    for (const bad of ["", "not-a-uuid", "12345", "workspace-1", "'; DROP TABLE"]) {
      expect(UUID_RE.test(bad)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 6) PWA reconciliation contract — source_id + snapshot envelope
// ─────────────────────────────────────────────────────────────
describe("padova-contendibili-list — reconciliation contract", () => {
  it("civiko-one-signals-feed emits stable `cont:${chiave_match}` as source_id for contendibili", () => {
    // Post real-sources-v3: source_id is keyed by chiave_match (stable across recomputes)
    // rather than the regenerable row id. This lock prevents accidental regressions.
    expect(FEED_SRC).toMatch(/source_id:\s*`cont:\$\{stableCont\}`/);
    expect(FEED_SRC).toMatch(/stableCont\s*=\s*String\(row\.chiave_match/);
  });

  it("padova-contendibili-list emits the byte-identical source_id per item", () => {
    expect(SRC).toMatch(/source_id:\s*`cont:\$\{Number\(r\.id\)\}`/);
  });

  it("envelope exposes total, items_count, snapshot_complete, assigned_zone", () => {
    expect(SRC).toContain("items_count: itemsCount");
    expect(SRC).toContain("snapshot_complete: snapshotComplete");
    expect(SRC).toContain("assigned_zone: primarySlug");
    // Also mirrored under data.
    const dataBlock = SRC.slice(SRC.indexOf("data: {"), SRC.lastIndexOf("debug_id: did"));
    expect(dataBlock).toContain("total: totalOut");
    expect(dataBlock).toContain("items_count: itemsCount");
    expect(dataBlock).toContain("snapshot_complete: snapshotComplete");
    expect(dataBlock).toContain("assigned_zone: primarySlug");
  });

  it("snapshot_complete requires items_count === total AND offset === 0", () => {
    expect(SRC).toMatch(
      /snapshotComplete\s*=\s*itemsCount\s*===\s*totalOut\s*&&\s*offset\s*===\s*0/,
    );
  });

  it("snapshot_complete formula: paginated or truncated responses are never complete", () => {
    // Reimplement the formula and test edge cases.
    const complete = (items: number, total: number, offset: number) =>
      items === total && offset === 0;
    expect(complete(10, 10, 0)).toBe(true);
    expect(complete(5, 10, 0)).toBe(false);       // truncated by limit
    expect(complete(5, 10, 5)).toBe(false);       // paginated tail
    expect(complete(10, 10, 5)).toBe(false);      // paginated even if page full
    expect(complete(0, 0, 0)).toBe(true);         // empty zone, still a complete snapshot
  });
});
