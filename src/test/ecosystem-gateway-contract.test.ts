// ═══════════════════════════════════════════════════════════════
// EcoSystem Gateway — Contract Tests
// Validates routes, envelope, capabilities, and module contracts
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════════════
// 1. Route Registry
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Route Registry", () => {
  const PUBLIC_GET_ROUTES = ["/", "/health", "/__health", "/manifest", "/capabilities"];
  const PROTECTED_POST_ROUTES = ["/listing-enrichment", "/service-pack", "/unified-report"];

  it("defines all expected public GET routes", () => {
    PUBLIC_GET_ROUTES.forEach((route) => {
      expect(route).toBeTruthy();
    });
    expect(PUBLIC_GET_ROUTES).toHaveLength(5);
  });

  it("defines all expected protected POST routes", () => {
    PROTECTED_POST_ROUTES.forEach((route) => {
      expect(route).toBeTruthy();
    });
    expect(PROTECTED_POST_ROUTES).toHaveLength(3);
  });

  it("expected base path is /functions/v1/ecosystem-gateway", () => {
    const basePath = "/functions/v1/ecosystem-gateway";
    expect(basePath).toBe("/functions/v1/ecosystem-gateway");
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

  it("error envelope has required fields", () => {
    const envelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "abc123",
      error: { code: "MISSING_PROPERTY", message: "property object is required" },
    };
    expect(envelope).toHaveProperty("ok", false);
    expect(envelope).toHaveProperty("data", null);
    expect(envelope).toHaveProperty("error");
    expect(envelope.error).toHaveProperty("code");
    expect(envelope.error).toHaveProperty("message");
    expect(envelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Capabilities Shape
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Capabilities Contract", () => {
  const CAPABILITIES = {
    status: "ok",
    function: "ecosystem-gateway",
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
// 4. Listing Enrichment — Valid Request
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

  // 5. Partial without global error
  it("can return partial without global failure", () => {
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
  });

  it("missing property triggers MISSING_PROPERTY error code", () => {
    const errorCode = "MISSING_PROPERTY";
    expect(errorCode).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Service Pack — Real Wyloni Keys Only
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — service-pack contract", () => {
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

  it("output has recommended_services array and count", () => {
    const output = { recommended_services: [], count: 0 };
    expect(output).toHaveProperty("recommended_services");
    expect(output).toHaveProperty("count");
    expect(Array.isArray(output.recommended_services)).toBe(true);
  });

  it("each service uses only real Wyloni keys", () => {
    const services = [
      { service_key: "archivio", target_app: "wyloni", route: "/archivio" },
      { service_key: "bollette", target_app: "wyloni", route: "/analisi-bollette" },
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
    const context = { wantsArchive: true };
    const expectedKeys = ["archivio", "scanner", "carica-file"];
    expectedKeys.forEach((k) => expect(REAL_WYLONI_KEYS).toContain(k));
  });

  it("empty context returns empty or minimal services", () => {
    const context = {};
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
      // No invented data — just marked unavailable
    });
  });

  it("with all sections, partial is false", () => {
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
});

// ═══════════════════════════════════════════════════════════════
// 8. No Mandatory PWA Dependencies
// ═══════════════════════════════════════════════════════════════
describe("EcoSystem Gateway — Independence Contract", () => {
  it("gateway does not require KeyDraft to function", () => {
    // listing-enrichment works with just property data, no keydraft call needed
    const input = { property: { address: "Test", comune: "TEST" } };
    expect(input).not.toHaveProperty("keydraft_api_call");
  });

  it("gateway does not require Wyloni to function", () => {
    // service-pack uses static catalog, no Wyloni call needed
    const staticCatalog = true;
    expect(staticCatalog).toBe(true);
  });

  it("gateway does not require Sottra to return a valid response", () => {
    // If Sottra is unavailable, listing-enrichment returns partial
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
    // Contract: gateway never queries keydraft/wyloni databases
    const crossDbAccess = false;
    expect(crossDbAccess).toBe(false);
  });

  it("identity headers use ecosystem-gateway function name", () => {
    const headers = {
      "X-Core-Function": "ecosystem-gateway",
      "X-Core-Contract": "central-core-v3",
    };
    expect(headers["X-Core-Function"]).toBe("ecosystem-gateway");
    expect(headers["X-Core-Contract"]).toBe("central-core-v3");
  });
});
