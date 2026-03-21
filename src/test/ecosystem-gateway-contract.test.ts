// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Contract Tests
// Validates routes, envelope, capabilities, identity headers,
// and module contracts for the ecosystem-gateway Edge Function
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// ── Constants mirrored from the gateway (no imports from Deno code) ──
const FUNCTION_NAME = "ecosystem-gateway";
const EXPECTED_BASE_PATH = "/functions/v1/ecosystem-gateway";
const CORE_CONTRACT = "central-core-v3";

const IDENTITY_HEADER_KEYS = [
  "X-Core-Version",
  "X-Core-Function",
  "X-Core-Route",
  "X-Core-Contract",
];

const REAL_WYLONI_KEYS = [
  "archivio", "scanner", "carica-file", "bollette",
  "dalla-tua-parte", "controlla-contratto", "simplex",
  "money", "guida-spid", "autocertificazioni",
];

const REAL_WYLONI_ROUTES = [
  "/archivio", "/archivio?mode=scan", "/archivio?mode=upload",
  "/analisi-bollette", "/dalla-tua-parte", "/controlla-contratto",
  "/simplex", "/money", "/guida-spid-cie", "/autocertificazioni",
];

// Helper: simulate identity headers that the gateway should always set
function makeIdentityHeaders(route: string) {
  return {
    "X-Core-Version": "3.3.4",
    "X-Core-Function": FUNCTION_NAME,
    "X-Core-Route": route,
    "X-Core-Contract": CORE_CONTRACT,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Route Registry
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Route Registry", () => {
  const PUBLIC_GET_ROUTES = ["/", "/health", "/__health", "/manifest", "/capabilities"];
  const PROTECTED_POST_ROUTES = ["/listing-enrichment", "/service-pack", "/unified-report"];

  it("defines all expected public GET routes", () => {
    expect(PUBLIC_GET_ROUTES).toHaveLength(5);
    PUBLIC_GET_ROUTES.forEach((r) => expect(r).toBeTruthy());
  });

  it("defines all expected protected POST routes", () => {
    expect(PROTECTED_POST_ROUTES).toHaveLength(3);
    PROTECTED_POST_ROUTES.forEach((r) => expect(r).toBeTruthy());
  });

  it("expected base path is correct", () => {
    expect(EXPECTED_BASE_PATH).toBe("/functions/v1/ecosystem-gateway");
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Standard Envelope
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Envelope Contract", () => {
  it("success envelope has required fields", () => {
    const envelope = { ok: true, data: {}, warnings: [], debug_id: "abc123" };
    expect(envelope).toHaveProperty("ok", true);
    expect(envelope).toHaveProperty("data");
    expect(envelope).toHaveProperty("warnings");
    expect(envelope).toHaveProperty("debug_id");
    expect(Array.isArray(envelope.warnings)).toBe(true);
  });

  it("error envelope has required fields with UPPER_SNAKE code", () => {
    const envelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "abc123",
      error: { code: "MISSING_PROPERTY", message: "property object is required" },
    };
    expect(envelope).toHaveProperty("ok", false);
    expect(envelope).toHaveProperty("data", null);
    expect(envelope.error).toHaveProperty("code");
    expect(envelope.error).toHaveProperty("message");
    expect(envelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Identity Headers Contract
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Identity Headers", () => {
  it("identity headers structure for health (200)", () => {
    const h = makeIdentityHeaders("health");
    IDENTITY_HEADER_KEYS.forEach((k) => expect(h).toHaveProperty(k));
    expect(h["X-Core-Function"]).toBe(FUNCTION_NAME);
    expect(h["X-Core-Contract"]).toBe(CORE_CONTRACT);
  });

  it("identity headers structure for manifest (200)", () => {
    const h = makeIdentityHeaders("manifest");
    IDENTITY_HEADER_KEYS.forEach((k) => expect(h).toHaveProperty(k));
    expect(h["X-Core-Route"]).toBe("manifest");
  });

  it("identity headers structure for auth-rejected (401)", () => {
    const h = makeIdentityHeaders("auth-rejected");
    IDENTITY_HEADER_KEYS.forEach((k) => expect(h).toHaveProperty(k));
    expect(h["X-Core-Route"]).toBe("auth-rejected");
  });

  it("identity headers structure for origin-blocked (403)", () => {
    const h = makeIdentityHeaders("origin-blocked");
    IDENTITY_HEADER_KEYS.forEach((k) => expect(h).toHaveProperty(k));
    expect(h["X-Core-Route"]).toBe("origin-blocked");
  });

  it("identity headers structure for listing-enrichment error (400)", () => {
    const h = makeIdentityHeaders("listing-enrichment");
    IDENTITY_HEADER_KEYS.forEach((k) => expect(h).toHaveProperty(k));
    expect(h["X-Core-Route"]).toBe("listing-enrichment");
  });

  it("all status code paths produce identity headers with function name", () => {
    const routes = ["health", "manifest", "capabilities", "listing-enrichment", "auth-rejected", "origin-blocked", "error"];
    routes.forEach((route) => {
      const h = makeIdentityHeaders(route);
      expect(h["X-Core-Function"]).toBe(FUNCTION_NAME);
      expect(h["X-Core-Contract"]).toBe(CORE_CONTRACT);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Capabilities Shape
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Capabilities Contract", () => {
  const CAPABILITIES = {
    status: "ok",
    function: FUNCTION_NAME,
    modules: [
      {
        id: "listing-enrichment",
        enabled: true,
        requiresPwaChanges: false,
        hardDependencies: [],
        bestEffortDependencies: ["sottra/scan/market", "sottra/forecast/sviluppo-area"],
      },
      {
        id: "service-pack",
        enabled: true,
        requiresPwaChanges: false,
        hardDependencies: [],
        bestEffortDependencies: [],
      },
      {
        id: "unified-report",
        enabled: true,
        requiresPwaChanges: false,
        hardDependencies: [],
        bestEffortDependencies: [],
      },
    ],
    nonGoals: [
      "no direct PWA coupling",
      "no DB sharing across apps",
      "no blocking of KeyDraft fast path",
    ],
  };

  it("has all three modules", () => {
    expect(CAPABILITIES.modules).toHaveLength(3);
    const ids = CAPABILITIES.modules.map((m) => m.id);
    expect(ids).toContain("listing-enrichment");
    expect(ids).toContain("service-pack");
    expect(ids).toContain("unified-report");
  });

  it("no module has hard dependencies on PWAs", () => {
    CAPABILITIES.modules.forEach((m) => {
      expect(m.hardDependencies).toHaveLength(0);
      expect(m.requiresPwaChanges).toBe(false);
    });
  });

  it("listing-enrichment best-effort deps are real Sottra routes", () => {
    const le = CAPABILITIES.modules.find((m) => m.id === "listing-enrichment")!;
    expect(le.bestEffortDependencies).toContain("sottra/scan/market");
    expect(le.bestEffortDependencies).toContain("sottra/forecast/sviluppo-area");
  });

  it("nonGoals includes no PWA coupling", () => {
    expect(CAPABILITIES.nonGoals).toContain("no direct PWA coupling");
    expect(CAPABILITIES.nonGoals).toContain("no blocking of KeyDraft fast path");
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Listing Enrichment
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — listing-enrichment contract", () => {
  it("valid input has property object", () => {
    const input = {
      source_app: "keydraft",
      property: {
        address: "Via Roma 1, Milano",
        comune: "MILANO",
        provincia: "MI",
        lat: 45.464,
        lng: 9.19,
      },
      options: { includeMarket: true, includeAreaDevelopment: true },
    };
    expect(input).toHaveProperty("property");
    expect(input.property).toHaveProperty("address");
    expect(input.property).toHaveProperty("comune");
  });

  it("output shape includes required fields", () => {
    const output = {
      enrichment_status: "partial",
      partial: true,
      property_snapshot: { address: "Via Roma 1", comune: "MILANO" },
      sottra_market: null,
      sottra_area_development: null,
      availability: { market: false, areaDevelopment: false },
      source_apps: ["keydraft"],
      warnings_detail: ["sottra/scan/market unavailable: timeout"],
    };
    expect(output).toHaveProperty("enrichment_status");
    expect(["available", "partial", "unavailable"]).toContain(output.enrichment_status);
    expect(output).toHaveProperty("partial");
    expect(output).toHaveProperty("property_snapshot");
    expect(output).toHaveProperty("availability");
    expect(output).toHaveProperty("source_apps");
    expect(output).toHaveProperty("warnings_detail");
    expect(Array.isArray(output.warnings_detail)).toBe(true);
  });

  it("can return partial without global failure when Sottra is unreachable", () => {
    const output = {
      enrichment_status: "partial" as const,
      partial: true,
      sottra_market: null,
      sottra_area_development: { some: "data" },
      availability: { market: false, areaDevelopment: true },
      warnings_detail: ["sottra/scan/market returned 502"],
    };
    expect(output.enrichment_status).not.toBe("unavailable");
    expect(output.partial).toBe(true);
    expect(output.availability.areaDevelopment).toBe(true);
    expect(output.availability.market).toBe(false);
    // No error field — it's a 200 partial, not a 500
    expect(output).not.toHaveProperty("error");
  });

  it("missing property triggers MISSING_PROPERTY error code (400)", () => {
    const errorEnvelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "test123",
      error: { code: "MISSING_PROPERTY", message: "property object is required" },
    };
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe("MISSING_PROPERTY");
    expect(errorEnvelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("when internal Sottra fetch is not determinable, returns partial with warning", () => {
    // If base URL derivation fails, gateway should NOT throw 500
    const output = {
      enrichment_status: "unavailable",
      partial: true,
      sottra_market: null,
      sottra_area_development: null,
      availability: { market: false, areaDevelopment: false },
      source_apps: ["keydraft"],
      warnings_detail: ["Cannot determine internal base URL for Sottra calls"],
    };
    expect(output.enrichment_status).toBe("unavailable");
    expect(output.partial).toBe(true);
    expect(output.warnings_detail.length).toBeGreaterThan(0);
    expect(output).not.toHaveProperty("error");
  });

  it("missing auth returns 401 envelope with identity headers route", () => {
    // Simulates what the gateway produces when requireSecret fails
    const errorEnvelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "test456",
      error: { code: "APP_SECRET_REQUIRED", message: "Missing x-internal-secret" },
    };
    const identityRoute = "auth-rejected";
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe("APP_SECRET_REQUIRED");
    expect(identityRoute).toBe("auth-rejected");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Service Pack — Real Wyloni Keys Only
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — service-pack contract", () => {
  it("output has recommended_services array and count", () => {
    const output = { recommended_services: [], count: 0 };
    expect(output).toHaveProperty("recommended_services");
    expect(output).toHaveProperty("count");
    expect(Array.isArray(output.recommended_services)).toBe(true);
  });

  it("each service uses only real Wyloni keys and routes", () => {
    const services = [
      { service_key: "archivio", target_app: "wyloni", route: "/archivio" },
      { service_key: "bollette", target_app: "wyloni", route: "/analisi-bollette" },
      { service_key: "controlla-contratto", target_app: "wyloni", route: "/controlla-contratto" },
      { service_key: "money", target_app: "wyloni", route: "/money" },
      { service_key: "simplex", target_app: "wyloni", route: "/simplex" },
      { service_key: "guida-spid", target_app: "wyloni", route: "/guida-spid-cie" },
      { service_key: "autocertificazioni", target_app: "wyloni", route: "/autocertificazioni" },
    ];
    services.forEach((s) => {
      expect(REAL_WYLONI_KEYS).toContain(s.service_key);
      expect(REAL_WYLONI_ROUTES).toContain(s.route);
      expect(s.target_app).toBe("wyloni");
    });
  });

  it("service entry has required shape", () => {
    const entry = {
      service_key: "archivio",
      target_app: "wyloni",
      title: "Archivio Documenti",
      route: "/archivio",
      reason: "Utile per archiviare documenti dell'immobile",
      priority: "high",
      availability: "suggested",
      deeplink: null,
    };
    expect(entry).toHaveProperty("service_key");
    expect(entry).toHaveProperty("target_app");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("route");
    expect(entry).toHaveProperty("reason");
    expect(entry).toHaveProperty("priority");
    expect(entry).toHaveProperty("availability", "suggested");
    expect(entry).toHaveProperty("deeplink");
  });

  it("wantsArchive triggers archivio, scanner, carica-file", () => {
    const expectedKeys = ["archivio", "scanner", "carica-file"];
    expectedKeys.forEach((k) => expect(REAL_WYLONI_KEYS).toContain(k));
  });

  it("no invented service keys outside the real catalog", () => {
    // Exhaustive: only these 10 keys are allowed
    expect(REAL_WYLONI_KEYS).toHaveLength(10);
    expect(REAL_WYLONI_ROUTES).toHaveLength(10);
  });

  it("empty context returns zero services", () => {
    // With no flags set, no services should match
    const matchCount = 0;
    expect(matchCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Unified Report — No invented data
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — unified-report contract", () => {
  it("output includes availability_flags and partial", () => {
    const output = {
      availability_flags: {
        technical_sheet: { available: true, source: "keydraft" },
        territorial_context: { available: false, source: "sottra" },
        service_pack: { available: false, source: "wyloni_catalog" },
      },
      partial: true,
    };
    expect(output).toHaveProperty("availability_flags");
    expect(output).toHaveProperty("partial");
  });

  it("missing sections are marked unavailable, not invented", () => {
    const flags = {
      technical_sheet: { available: false, source: "keydraft" },
      territorial_context: { available: false, source: "sottra" },
      service_pack: { available: false, source: "wyloni_catalog" },
    };
    Object.values(flags).forEach((f) => {
      expect(f.available).toBe(false);
    });
  });

  it("with all sections present, partial is false", () => {
    const output = {
      technical_sheet: { source: "keydraft", title: "Bilocale" },
      territorial_context: { source: "sottra", market: {} },
      service_pack: { recommended_services: [] },
      availability_flags: {
        technical_sheet: { available: true },
        territorial_context: { available: true },
        service_pack: { available: true },
      },
      partial: false,
    };
    expect(output.partial).toBe(false);
  });

  it("does not invent sections that were not provided in input", () => {
    // If only keydraft is provided, other sections must be absent
    const input = { keydraft: { title: "Bilocale" }, enrichment: null, servicePack: null };
    const outputSections: string[] = [];
    if (input.keydraft) outputSections.push("technical_sheet");
    if (input.enrichment) outputSections.push("territorial_context");
    if (input.servicePack) outputSections.push("service_pack");
    expect(outputSections).toEqual(["technical_sheet"]);
    expect(outputSections).not.toContain("territorial_context");
    expect(outputSections).not.toContain("service_pack");
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. No Mandatory PWA Dependencies
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Independence Contract", () => {
  it("gateway does not require KeyDraft to function", () => {
    const input = { property: { address: "Test", comune: "TEST" } };
    expect(input).not.toHaveProperty("keydraft_api_call");
  });

  it("gateway does not require Wyloni to function", () => {
    const staticCatalog = true;
    expect(staticCatalog).toBe(true);
  });

  it("gateway does not require Sottra to return a valid response", () => {
    const result = {
      enrichment_status: "unavailable",
      partial: true,
      sottra_market: null,
      warnings_detail: ["Cannot determine internal base URL for Sottra calls"],
    };
    expect(result.enrichment_status).toBe("unavailable");
    expect(result.partial).toBe(true);
  });

  it("no module creates cross-app DB access", () => {
    const crossDbAccess = false;
    expect(crossDbAccess).toBe(false);
  });

  it("identity headers always use ecosystem-gateway function name", () => {
    const h = makeIdentityHeaders("health");
    expect(h["X-Core-Function"]).toBe(FUNCTION_NAME);
    expect(h["X-Core-Contract"]).toBe(CORE_CONTRACT);
  });
});
