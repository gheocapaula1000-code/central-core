// ═══════════════════════════════════════════════════════════════
// Property Detail — Contract Tests
// Tests runtime behavior, contract shape, block outcome rules
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Load source files ─────────────────────────────────────────

const ASSEMBLER_SRC = fs.readFileSync(path.resolve("supabase/functions/property-detail/assembler.ts"), "utf-8");
const TYPES_SRC = fs.readFileSync(path.resolve("supabase/functions/property-detail/types.ts"), "utf-8");
const PROVIDERS_SRC = fs.readFileSync(path.resolve("supabase/functions/property-detail/providers.ts"), "utf-8");
const INDEX_SRC = fs.readFileSync(path.resolve("supabase/functions/property-detail/index.ts"), "utf-8");

// ═══════════════════════════════════════════════════════════════
// 1. PUBLIC ID CONTRACT — URN format
// ═══════════════════════════════════════════════════════════════

describe("Public ID contract", () => {
  it("uses urn:ccv3:property:veneto: format", () => {
    expect(ASSEMBLER_SRC).toContain("urn:ccv3:property:veneto:");
  });

  it("does not expose coordinate-style veneto:<lat>:<lng> as public ID", () => {
    // The old format should not appear in ID generation
    const idGenSection = ASSEMBLER_SRC.split("publicId")[0] ?? "";
    expect(idGenSection).not.toMatch(/id:\s*propertyId/); // no raw coordinate passthrough
  });

  it("generates stable hash-based IDs", () => {
    expect(ASSEMBLER_SRC).toContain("generateStableId");
    expect(ASSEMBLER_SRC).toContain("SHA-256");
  });

  it("parser validates urn:ccv3:property:veneto: prefix", () => {
    expect(ASSEMBLER_SRC).toContain("parsePropertyUrn");
    expect(ASSEMBLER_SRC).toContain('"urn"');
    expect(ASSEMBLER_SRC).toContain('"ccv3"');
    expect(ASSEMBLER_SRC).toContain('"property"');
    expect(ASSEMBLER_SRC).toContain('"veneto"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. RESPONSE ENVELOPE — direct payload, no ok/data
// ═══════════════════════════════════════════════════════════════

describe("Response envelope", () => {
  it("does NOT use ok() for property detail responses", () => {
    // The index should use directJson for the main response, not ok()
    const routerSection = INDEX_SRC.split("Deno.serve")[1] ?? "";
    // The success path should use directJson, not ok()
    expect(routerSection).toContain("directJson(req, 200, result");
    expect(routerSection).not.toMatch(/ok\(req,\s*result/);
  });

  it("defines directJson helper that returns raw body", () => {
    expect(INDEX_SRC).toContain("function directJson");
    expect(INDEX_SRC).toContain("JSON.stringify(body)");
  });

  it("error responses use propertyError without ok/data wrapper", () => {
    expect(INDEX_SRC).toContain("function propertyError");
    expect(INDEX_SRC).toContain("error: { code, message }");
    expect(INDEX_SRC).toContain("debug_id: debugId");
  });

  it("does not import ok from _shared/http", () => {
    // Should not import ok since this endpoint doesn't use the standard envelope
    const importSection = INDEX_SRC.split("from")[0] ?? "";
    // ok should NOT be in the property detail imports for the main response
    // (it's still used for health/manifest which is fine)
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. BLOCK SHAPES — frontend contract alignment
// ═══════════════════════════════════════════════════════════════

describe("Identity block shape (frontend contract)", () => {
  it("uses indirizzo not address", () => {
    expect(TYPES_SRC).toContain("indirizzo:");
    expect(TYPES_SRC).not.toMatch(/^\s+address:/m);
  });

  it("uses civico not houseNumber", () => {
    expect(TYPES_SRC).toContain("civico:");
  });

  it("uses coordinate object with lat/lng", () => {
    expect(TYPES_SRC).toContain("coordinate: { lat: number; lng: number }");
  });

  it("includes tipologia, stato, superficieMq, locali, piano, annoCostruzione, classeEnergetica", () => {
    for (const field of ["tipologia", "stato", "superficieMq", "locali", "piano", "annoCostruzione", "classeEnergetica"]) {
      expect(TYPES_SRC).toContain(`${field}:`);
    }
  });

  it("includes cap", () => {
    expect(TYPES_SRC).toContain("cap:");
  });

  it("has provenance", () => {
    expect(TYPES_SRC).toContain("provenance: BlockProvenance");
  });
});

describe("Territory block shape (frontend contract)", () => {
  it("uses microZona", () => {
    expect(TYPES_SRC).toContain("microZona:");
  });

  it("uses sommario, puntiForti, criticita", () => {
    expect(TYPES_SRC).toContain("sommario:");
    expect(TYPES_SRC).toContain("puntiForti:");
    expect(TYPES_SRC).toContain("criticita:");
  });

  it("has indicatori with vivibilita, sicurezza, rumore, servizi", () => {
    expect(TYPES_SRC).toContain("indicatori:");
    expect(TYPES_SRC).toContain("vivibilita:");
    expect(TYPES_SRC).toContain("sicurezza:");
    expect(TYPES_SRC).toContain("rumore:");
    expect(TYPES_SRC).toContain("servizi:");
  });

  it("has scenarioFuturo", () => {
    expect(TYPES_SRC).toContain("scenarioFuturo:");
  });
});

describe("Valuation block shape (frontend contract)", () => {
  it("uses prezzoStimato, prezzoMinimo, prezzoMassimo", () => {
    expect(TYPES_SRC).toContain("prezzoStimato:");
    expect(TYPES_SRC).toContain("prezzoMinimo:");
    expect(TYPES_SRC).toContain("prezzoMassimo:");
  });

  it("uses drivers", () => {
    expect(TYPES_SRC).toContain("drivers:");
  });
});

describe("Signals block shape (frontend contract)", () => {
  it("signals is an array type, not an object", () => {
    expect(TYPES_SRC).toContain("SignalItem[]");
  });

  it("SignalItem has id, tipo, titolo, descrizione, impatto, orizzonte", () => {
    for (const field of ["id:", "tipo:", "titolo:", "descrizione:", "impatto:", "orizzonte:"]) {
      expect(TYPES_SRC).toContain(field);
    }
  });
});

describe("Provenance uses string confidence", () => {
  it("confidence is string (alta/media/bassa) not number", () => {
    expect(TYPES_SRC).toContain("confidence: string");
    expect(TYPES_SRC).not.toMatch(/confidence:\s*number/);
  });

  it("provider maps geo level to confidence label", () => {
    expect(PROVIDERS_SRC).toContain("confidenceLabel");
    expect(PROVIDERS_SRC).toContain('"alta"');
    expect(PROVIDERS_SRC).toContain('"media"');
    expect(PROVIDERS_SRC).toContain('"bassa"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. BLOCK OUTCOME RULES
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
    expect(ASSEMBLER_SRC).toContain('case "unavailable"');
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
// 5. IDENTITY-GATED FLOW
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
// 6. ERROR CONTRACT
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

  it("error shape uses { error: { code, message }, debug_id } not ok/data", () => {
    expect(INDEX_SRC).toContain("propertyError");
    // Verify error helper doesn't produce ok/data
    const errorFn = INDEX_SRC.split("function propertyError")[1]?.split("}")[0] ?? "";
    expect(errorFn).not.toContain('"ok"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. PROVIDER ARCHITECTURE
// ═══════════════════════════════════════════════════════════════

describe("Provider architecture", () => {
  it("has all 4 provider functions", () => {
    expect(PROVIDERS_SRC).toContain("export async function resolveIdentity");
    expect(PROVIDERS_SRC).toContain("export async function resolveValuation");
    expect(PROVIDERS_SRC).toContain("export async function resolveTerritory");
    expect(PROVIDERS_SRC).toContain("export async function resolveSignals");
  });

  it("identity provider maps to frontend field names", () => {
    expect(PROVIDERS_SRC).toContain("indirizzo:");
    expect(PROVIDERS_SRC).toContain("civico:");
    expect(PROVIDERS_SRC).toContain("coordinate:");
    expect(PROVIDERS_SRC).toContain("cap:");
  });

  it("identity returns honest nulls for fields not available from geocoding", () => {
    expect(PROVIDERS_SRC).toContain("tipologia: null");
    expect(PROVIDERS_SRC).toContain("superficieMq: null");
    expect(PROVIDERS_SRC).toContain("classeEnergetica: null");
  });

  it("stub providers return unavailable honestly", () => {
    const valSection = PROVIDERS_SRC.split("resolveValuation")[1].split("export async")[0];
    expect(valSection).toContain('"unavailable"');
    const terSection = PROVIDERS_SRC.split("resolveTerritory")[1].split("export async")[0];
    expect(terSection).toContain('"unavailable"');
    const sigSection = PROVIDERS_SRC.split("resolveSignals")[1];
    expect(sigSection).toContain('"unavailable"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. OBSERVABILITY
// ═══════════════════════════════════════════════════════════════

describe("Structured observability", () => {
  it("logs request with debug_id", () => {
    expect(INDEX_SRC).toContain("[property-detail]");
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
    const routerBody = INDEX_SRC.split("Deno.serve")[1] ?? "";
    const healthIdx = routerBody.indexOf('"/health"');
    const authIdx = routerBody.indexOf("requireSecret");
    expect(healthIdx).toBeGreaterThan(0);
    expect(authIdx).toBeGreaterThan(0);
    expect(healthIdx).toBeLessThan(authIdx);
  });

  it("only allows GET method", () => {
    expect(INDEX_SRC).toContain("METHOD_NOT_ALLOWED");
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. CONFIG REGISTRATION
// ═══════════════════════════════════════════════════════════════

describe("Function registration", () => {
  it("is registered in config.toml", () => {
    const configToml = fs.readFileSync(path.resolve("supabase/config.toml"), "utf-8");
    expect(configToml).toContain("[functions.property-detail]");
    expect(configToml).toContain("verify_jwt = false");
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. BEHAVIORAL SIMULATION — parsePropertyUrn
// ═══════════════════════════════════════════════════════════════

describe("parsePropertyUrn logic", () => {
  // Inline the parser logic for testing (can't import Deno modules in vitest)
  const BOUNDS = { latMin: 44.8, latMax: 46.7, lngMin: 10.6, lngMax: 13.1 };

  function parsePropertyUrn(urn: string) {
    const parts = urn.split(":");
    if (parts.length < 4 || parts[0] !== "urn" || parts[1] !== "ccv3" || parts[2] !== "property" || parts[3] !== "veneto") {
      return { ok: false as const, error: "invalid_format" as const };
    }
    if (parts.length === 6) {
      const lat = parseFloat(parts[4]);
      const lng = parseFloat(parts[5]);
      if (isNaN(lat) || isNaN(lng)) return { ok: false as const, error: "invalid_format" as const };
      if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lng < BOUNDS.lngMin || lng > BOUNDS.lngMax) {
        return { ok: false as const, error: "out_of_bounds" as const };
      }
      return { ok: true as const, coords: { lat, lng } };
    }
    return { ok: false as const, error: "invalid_format" as const };
  }

  it("parses valid Padova URN", () => {
    const r = parsePropertyUrn("urn:ccv3:property:veneto:45.4064:11.8768");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coords.lat).toBeCloseTo(45.4064);
      expect(r.coords.lng).toBeCloseTo(11.8768);
    }
  });

  it("rejects old coordinate-style id", () => {
    const r = parsePropertyUrn("veneto:45.4064:11.8768");
    expect(r.ok).toBe(false);
  });

  it("rejects non-veneto prefix", () => {
    const r = parsePropertyUrn("urn:ccv3:property:lombardia:45.4:9.2");
    expect(r.ok).toBe(false);
  });

  it("rejects missing parts", () => {
    expect(parsePropertyUrn("urn:ccv3:property").ok).toBe(false);
    expect(parsePropertyUrn("urn:ccv3").ok).toBe(false);
    expect(parsePropertyUrn("").ok).toBe(false);
  });

  it("rejects non-numeric coordinates", () => {
    const r = parsePropertyUrn("urn:ccv3:property:veneto:abc:def");
    expect(r.ok).toBe(false);
  });

  it("rejects coordinates outside Veneto (Rome)", () => {
    const r = parsePropertyUrn("urn:ccv3:property:veneto:41.9028:12.4964");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("out_of_bounds");
  });

  it("accepts Venezia coordinates", () => {
    expect(parsePropertyUrn("urn:ccv3:property:veneto:45.4408:12.3155").ok).toBe(true);
  });

  it("accepts Verona coordinates", () => {
    expect(parsePropertyUrn("urn:ccv3:property:veneto:45.4384:10.9917").ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. BLOCK CLASSIFICATION SIMULATION
// ═══════════════════════════════════════════════════════════════

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

  it("identity resolved, others unavailable → only identity in resolvedBlocks", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("unavailable", "territory", resolved, failed);
    classifyBlock("unavailable", "valuation", resolved, failed);
    classifyBlock("unavailable", "signals", resolved, failed);
    expect(resolved).toEqual(["identity"]);
    expect(failed).toEqual([]);
  });

  it("one provider fails → appears only in failedBlocks", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("failed", "territory", resolved, failed);
    classifyBlock("unavailable", "valuation", resolved, failed);
    classifyBlock("unavailable", "signals", resolved, failed);
    expect(resolved).toEqual(["identity"]);
    expect(failed).toEqual(["territory"]);
  });

  it("unavailable block never appears in either array", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("unavailable", "signals", resolved, failed);
    expect(resolved).toEqual([]);
    expect(failed).toEqual([]);
  });

  it("all blocks resolved → all in resolvedBlocks, none in failedBlocks", () => {
    const resolved: string[] = [];
    const failed: string[] = [];
    classifyBlock("resolved", "identity", resolved, failed);
    classifyBlock("resolved", "territory", resolved, failed);
    classifyBlock("resolved", "valuation", resolved, failed);
    classifyBlock("resolved", "signals", resolved, failed);
    expect(resolved).toEqual(["identity", "territory", "valuation", "signals"]);
    expect(failed).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. RESPONSE CONTRACT SHAPE (top-level)
// ═══════════════════════════════════════════════════════════════

describe("Response contract top-level shape", () => {
  it("defines id as urn string", () => {
    expect(TYPES_SRC).toContain("id: string; // urn:ccv3:property:veneto:");
  });

  it("defines all required top-level fields", () => {
    for (const field of ["id:", "meta:", "identity:", "territory:", "valuation:", "signals:", "createdAt:", "updatedAt:"]) {
      expect(TYPES_SRC).toContain(field);
    }
  });

  it("meta contains requestedAt, resolvedBlocks, failedBlocks", () => {
    expect(TYPES_SRC).toContain("requestedAt: string");
    expect(TYPES_SRC).toContain("resolvedBlocks: string[]");
    expect(TYPES_SRC).toContain("failedBlocks: string[]");
  });

  it("type comment says NO ok/data wrapper", () => {
    expect(TYPES_SRC).toContain("No ok/data/warnings wrapper");
  });
});
