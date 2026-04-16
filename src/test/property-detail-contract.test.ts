// ═══════════════════════════════════════════════════════════════
// Property Detail — Contract Tests
// Tests assembler logic, block outcome rules, ID validation
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Load source files for static analysis ─────────────────────

const ASSEMBLER_SRC = fs.readFileSync(
  path.resolve("supabase/functions/property-detail/assembler.ts"),
  "utf-8",
);
const TYPES_SRC = fs.readFileSync(
  path.resolve("supabase/functions/property-detail/types.ts"),
  "utf-8",
);
const PROVIDERS_SRC = fs.readFileSync(
  path.resolve("supabase/functions/property-detail/providers.ts"),
  "utf-8",
);
const INDEX_SRC = fs.readFileSync(
  path.resolve("supabase/functions/property-detail/index.ts"),
  "utf-8",
);

// ═══════════════════════════════════════════════════════════════
// 1. PROPERTY ID FORMAT & VALIDATION
// ═══════════════════════════════════════════════════════════════

describe("Property ID format", () => {
  it("defines veneto:<lat>:<lng> format with validation", () => {
    expect(ASSEMBLER_SRC).toContain("parsePropertyId");
    expect(ASSEMBLER_SRC).toContain('"veneto"');
  });

  it("validates invalid format returns error", () => {
    expect(ASSEMBLER_SRC).toContain("invalid_format");
  });

  it("validates out-of-bounds coordinates", () => {
    expect(ASSEMBLER_SRC).toContain("out_of_bounds");
    expect(TYPES_SRC).toContain("VENETO_BOUNDS");
  });

  it("defines Veneto bounding box correctly", () => {
    // Veneto: lat 44.8-46.7, lng 10.6-13.1
    expect(TYPES_SRC).toContain("latMin: 44.8");
    expect(TYPES_SRC).toContain("latMax: 46.7");
    expect(TYPES_SRC).toContain("lngMin: 10.6");
    expect(TYPES_SRC).toContain("lngMax: 13.1");
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. RESPONSE CONTRACT SHAPE
// ═══════════════════════════════════════════════════════════════

describe("Response contract shape", () => {
  it("defines all required top-level fields", () => {
    for (const field of ["id", "meta", "identity", "territory", "valuation", "signals", "createdAt", "updatedAt"]) {
      expect(TYPES_SRC).toContain(field);
    }
  });

  it("meta contains requestedAt, resolvedBlocks, failedBlocks", () => {
    expect(TYPES_SRC).toContain("requestedAt: string");
    expect(TYPES_SRC).toContain("resolvedBlocks: string[]");
    expect(TYPES_SRC).toContain("failedBlocks: string[]");
  });

  it("defines all 4 block names", () => {
    expect(TYPES_SRC).toContain('"identity"');
    expect(TYPES_SRC).toContain('"territory"');
    expect(TYPES_SRC).toContain('"valuation"');
    expect(TYPES_SRC).toContain('"signals"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. BLOCK OUTCOME RULES
// ═══════════════════════════════════════════════════════════════

describe("Block outcome classification", () => {
  it("resolved block pushes to resolvedBlocks", () => {
    expect(ASSEMBLER_SRC).toContain('case "resolved"');
    expect(ASSEMBLER_SRC).toContain("resolvedBlocks.push(name)");
  });

  it("failed block pushes to failedBlocks", () => {
    expect(ASSEMBLER_SRC).toContain('case "failed"');
    expect(ASSEMBLER_SRC).toContain("failedBlocks.push(name)");
  });

  it("unavailable block goes to neither list", () => {
    // The unavailable case should NOT push to either list
    expect(ASSEMBLER_SRC).toContain('case "unavailable"');
    // Check the unavailable case doesn't push anything
    const unavailableBlock = ASSEMBLER_SRC.split('case "unavailable"')[1].split("break")[0];
    expect(unavailableBlock).not.toContain("resolvedBlocks.push");
    expect(unavailableBlock).not.toContain("failedBlocks.push");
  });

  it("defines three possible outcomes: resolved, unavailable, failed", () => {
    expect(TYPES_SRC).toContain('"resolved"');
    expect(TYPES_SRC).toContain('"unavailable"');
    expect(TYPES_SRC).toContain('"failed"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. IDENTITY-GATED FLOW
// ═══════════════════════════════════════════════════════════════

describe("Identity-gated assembler flow", () => {
  it("resolves identity first before fan-out", () => {
    const identityIdx = ASSEMBLER_SRC.indexOf("resolveIdentity");
    const fanOutIdx = ASSEMBLER_SRC.indexOf("Promise.all");
    expect(identityIdx).toBeLessThan(fanOutIdx);
  });

  it("returns immediately if identity not resolved", () => {
    expect(ASSEMBLER_SRC).toContain("no fan-out");
    expect(ASSEMBLER_SRC).toContain('identityResult.outcome !== "resolved"');
  });

  it("fans out valuation, territory, signals in parallel", () => {
    expect(ASSEMBLER_SRC).toContain("Promise.all");
    expect(ASSEMBLER_SRC).toContain("resolveValuation");
    expect(ASSEMBLER_SRC).toContain("resolveTerritory");
    expect(ASSEMBLER_SRC).toContain("resolveSignals");
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. ERROR CONTRACT
// ═══════════════════════════════════════════════════════════════

describe("Error contract", () => {
  it("returns VALIDATION_ERROR for invalid property id", () => {
    expect(INDEX_SRC).toContain("VALIDATION_ERROR");
  });

  it("returns PROPERTY_NOT_FOUND for unknown/non-Veneto property", () => {
    expect(INDEX_SRC).toContain("PROPERTY_NOT_FOUND");
  });

  it("returns TEMPORARY_BACKEND_FAILURE for identity failures", () => {
    expect(INDEX_SRC).toContain("TEMPORARY_BACKEND_FAILURE");
  });

  it("uses standard fail() envelope", () => {
    expect(INDEX_SRC).toContain("import {");
    expect(INDEX_SRC).toContain("fail,");
    expect(INDEX_SRC).toContain("ok,");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. PROVIDER ARCHITECTURE
// ═══════════════════════════════════════════════════════════════

describe("Provider architecture", () => {
  it("has all 4 provider functions", () => {
    expect(PROVIDERS_SRC).toContain("export async function resolveIdentity");
    expect(PROVIDERS_SRC).toContain("export async function resolveValuation");
    expect(PROVIDERS_SRC).toContain("export async function resolveTerritory");
    expect(PROVIDERS_SRC).toContain("export async function resolveSignals");
  });

  it("identity provider uses real DB (omi_zone_by_point RPC)", () => {
    expect(PROVIDERS_SRC).toContain("omi_zone_by_point");
    expect(PROVIDERS_SRC).toContain("SUPABASE_URL");
    expect(PROVIDERS_SRC).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("stub providers return unavailable honestly", () => {
    // valuation, territory, signals should all return unavailable
    const valSection = PROVIDERS_SRC.split("resolveValuation")[1].split("export async")[0];
    expect(valSection).toContain('"unavailable"');

    const terSection = PROVIDERS_SRC.split("resolveTerritory")[1].split("export async")[0];
    expect(terSection).toContain('"unavailable"');

    const sigSection = PROVIDERS_SRC.split("resolveSignals")[1];
    expect(sigSection).toContain('"unavailable"');
  });

  it("identity returns failed on DB errors, not unavailable", () => {
    expect(PROVIDERS_SRC).toContain('outcome: "failed"');
    expect(PROVIDERS_SRC).toContain("rpcErr");
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. PROVENANCE MODEL
// ═══════════════════════════════════════════════════════════════

describe("Provenance model", () => {
  it("defines BlockProvenance with source, confidence, updatedAt", () => {
    expect(TYPES_SRC).toContain("source: string");
    expect(TYPES_SRC).toContain("confidence: number");
    expect(TYPES_SRC).toContain("updatedAt: string");
  });

  it("identity block includes provenance", () => {
    expect(PROVIDERS_SRC).toContain("source: \"omi_zone_geometry+nominatim\"");
  });

  it("each block type includes provenance field", () => {
    expect(TYPES_SRC).toContain("provenance: BlockProvenance");
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. OBSERVABILITY
// ═══════════════════════════════════════════════════════════════

describe("Structured observability", () => {
  it("logs request start with method and pathname", () => {
    expect(INDEX_SRC).toContain("[property-detail]");
    expect(INDEX_SRC).toContain("method=");
    expect(INDEX_SRC).toContain("pathname=");
    expect(INDEX_SRC).toContain("debug_id=");
  });

  it("logs assembler start/end with block outcomes", () => {
    expect(ASSEMBLER_SRC).toContain("[property-detail:assembler] start");
    expect(ASSEMBLER_SRC).toContain("[property-detail:assembler] done");
    expect(ASSEMBLER_SRC).toContain("resolved=");
    expect(ASSEMBLER_SRC).toContain("failed=");
  });

  it("logs each provider invocation", () => {
    expect(PROVIDERS_SRC).toContain("[property-detail:identity]");
    expect(PROVIDERS_SRC).toContain("[property-detail:valuation]");
    expect(PROVIDERS_SRC).toContain("[property-detail:territory]");
    expect(PROVIDERS_SRC).toContain("[property-detail:signals]");
  });

  it("logs identity provider duration", () => {
    expect(PROVIDERS_SRC).toContain("duration_ms=");
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. SECURITY & ROUTING
// ═══════════════════════════════════════════════════════════════

describe("Security and routing", () => {
  it("enforces origin policy", () => {
    expect(INDEX_SRC).toContain("enforceOriginPolicy");
  });

  it("requires secret for property routes", () => {
    expect(INDEX_SRC).toContain("requireSecret");
  });

  it("health and manifest are public (no auth)", () => {
    // Auth check must come AFTER health/manifest route handling in the router body
    // Look at the Deno.serve handler section only
    const routerBody = INDEX_SRC.split("Deno.serve")[1] ?? "";
    const healthIdx = routerBody.indexOf('"/health"');
    const manifestIdx = routerBody.indexOf('"/manifest"');
    const authIdx = routerBody.indexOf("requireSecret");
    expect(healthIdx).toBeGreaterThan(0);
    expect(manifestIdx).toBeGreaterThan(0);
    expect(authIdx).toBeGreaterThan(0);
    expect(healthIdx).toBeLessThan(authIdx);
    expect(manifestIdx).toBeLessThan(authIdx);
  });

  it("adds identity headers to all responses", () => {
    expect(INDEX_SRC).toContain("withIdentity");
    expect(INDEX_SRC).toContain("addIdentityHeaders");
  });

  it("only allows GET method", () => {
    expect(INDEX_SRC).toContain("METHOD_NOT_ALLOWED");
    expect(INDEX_SRC).toContain('"Use GET"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. VENETO SCOPE
// ═══════════════════════════════════════════════════════════════

describe("Veneto scope enforcement", () => {
  it("only accepts veneto: prefixed IDs", () => {
    expect(ASSEMBLER_SRC).toContain('parts[0] !== "veneto"');
  });

  it("rejects out-of-bounds coordinates as not found", () => {
    expect(INDEX_SRC).toContain("Coordinates are outside Veneto region");
  });

  it("building IDs use VE- prefix", () => {
    expect(PROVIDERS_SRC).toContain('"VE-"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. CONFIG REGISTRATION
// ═══════════════════════════════════════════════════════════════

describe("Function registration", () => {
  it("is registered in config.toml", () => {
    const configToml = fs.readFileSync(
      path.resolve("supabase/config.toml"),
      "utf-8",
    );
    expect(configToml).toContain("[functions.property-detail]");
    expect(configToml).toContain("verify_jwt = false");
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. BEHAVIORAL SIMULATION (Pure Logic Tests)
// ═══════════════════════════════════════════════════════════════

describe("parsePropertyId logic", () => {
  // We inline the parser logic for testing since we can't import Deno modules

  function parsePropertyId(id: string) {
    const parts = id.split(":");
    if (parts.length !== 3 || parts[0] !== "veneto") {
      return { ok: false as const, error: "invalid_format" as const };
    }
    const lat = parseFloat(parts[1]);
    const lng = parseFloat(parts[2]);
    if (isNaN(lat) || isNaN(lng)) {
      return { ok: false as const, error: "invalid_format" as const };
    }
    if (lat < 44.8 || lat > 46.7 || lng < 10.6 || lng > 13.1) {
      return { ok: false as const, error: "out_of_bounds" as const };
    }
    return { ok: true as const, parsed: { region: "veneto" as const, lat, lng } };
  }

  it("parses valid Veneto ID", () => {
    const r = parsePropertyId("veneto:45.4064:11.8768");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.lat).toBeCloseTo(45.4064);
      expect(r.parsed.lng).toBeCloseTo(11.8768);
      expect(r.parsed.region).toBe("veneto");
    }
  });

  it("rejects non-veneto prefix", () => {
    const r = parsePropertyId("lombardia:45.4:9.2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_format");
  });

  it("rejects missing parts", () => {
    expect(parsePropertyId("veneto:45.4").ok).toBe(false);
    expect(parsePropertyId("veneto").ok).toBe(false);
    expect(parsePropertyId("").ok).toBe(false);
  });

  it("rejects non-numeric coordinates", () => {
    const r = parsePropertyId("veneto:abc:def");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_format");
  });

  it("rejects coordinates outside Veneto (Rome)", () => {
    const r = parsePropertyId("veneto:41.9028:12.4964");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("out_of_bounds");
  });

  it("rejects coordinates outside Veneto (Milan)", () => {
    const r = parsePropertyId("veneto:45.4642:9.1900");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("out_of_bounds");
  });

  it("accepts Padova coordinates", () => {
    const r = parsePropertyId("veneto:45.4064:11.8768");
    expect(r.ok).toBe(true);
  });

  it("accepts Venezia coordinates", () => {
    const r = parsePropertyId("veneto:45.4408:12.3155");
    expect(r.ok).toBe(true);
  });

  it("accepts Verona coordinates", () => {
    const r = parsePropertyId("veneto:45.4384:10.9917");
    expect(r.ok).toBe(true);
  });
});

describe("Block classification simulation", () => {
  function classifyBlock(
    outcome: "resolved" | "unavailable" | "failed",
    name: string,
    resolvedBlocks: string[],
    failedBlocks: string[],
  ) {
    switch (outcome) {
      case "resolved": resolvedBlocks.push(name); break;
      case "failed": failedBlocks.push(name); break;
      case "unavailable": break;
    }
  }

  it("identity resolved + 3 unavailable → resolvedBlocks=[identity], failedBlocks=[]", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("unavailable", "valuation", resolved, failed);
    classifyBlock("unavailable", "territory", resolved, failed);
    classifyBlock("unavailable", "signals", resolved, failed);
    expect(resolved).toEqual(["identity"]);
    expect(failed).toEqual([]);
  });

  it("one failed provider appears in failedBlocks only", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("failed", "valuation", resolved, failed);
    classifyBlock("unavailable", "territory", resolved, failed);
    classifyBlock("unavailable", "signals", resolved, failed);
    expect(resolved).toEqual(["identity"]);
    expect(failed).toEqual(["valuation"]);
  });

  it("unavailable does not appear in either list", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("unavailable", "territory", resolved, failed);
    expect(resolved).toEqual([]);
    expect(failed).toEqual([]);
  });

  it("all resolved → resolvedBlocks has all 4", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("resolved", "valuation", resolved, failed);
    classifyBlock("resolved", "territory", resolved, failed);
    classifyBlock("resolved", "signals", resolved, failed);
    expect(resolved).toEqual(["identity", "valuation", "territory", "signals"]);
    expect(failed).toEqual([]);
  });

  it("mixed outcomes are classified correctly", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("resolved", "valuation", resolved, failed);
    classifyBlock("failed", "territory", resolved, failed);
    classifyBlock("unavailable", "signals", resolved, failed);
    expect(resolved).toEqual(["identity", "valuation"]);
    expect(failed).toEqual(["territory"]);
  });
});
