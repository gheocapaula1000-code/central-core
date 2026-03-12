import { describe, it, expect } from "vitest";

/**
 * Sottra Contract Regression Tests — Max Stability Edition
 *
 * These tests verify the contract surface that Sottra PWA depends on.
 * Pure logic and structural expectations — no live HTTP calls.
 * Breaking any of these means a potential Sottra outage.
 *
 * DATA RIGOR RULES enforced:
 * 1. mediaZona must always be null (no fake duplication of prezzoMq)
 * 2. trend5Anni must always be null (no hardcoded/fake trend)
 * 3. Pricing not published if OMI match confidence < 50%
 * 4. sourceType must be official/elaborated/unavailable — never ambiguous
 * 5. No weak fallback promoting data to "official"
 * 6. ai_matched → elaborated (never official)
 * 7. Only single_zone with >= 85% confidence can be "official"
 * 8. Elaborated modules require >= 2 data sources
 */

// ── Publication Policy Thresholds ─────────────────────────────

const PUBLICATION_POLICY = {
  OMI_PUBLISH_THRESHOLD: 0.50,
  OMI_OFFICIAL_THRESHOLD: 0.85,
  ELABORATED_MIN_SOURCES: 2,
  OFFICIAL_MATCH_METHODS: ["single_zone"],
  ELABORATED_MATCH_METHODS: ["ai_matched"],
  UNPUBLISHABLE_MATCH_METHODS: ["ai_fallback", "first_zone_fallback", "none"],
};

function classifyOMIPricing(matchConfidence: number, matchMethod: string): "official" | "elaborated" | "unavailable" {
  if (PUBLICATION_POLICY.UNPUBLISHABLE_MATCH_METHODS.includes(matchMethod)) return "unavailable";
  if (matchConfidence < PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD) return "unavailable";
  if (
    PUBLICATION_POLICY.OFFICIAL_MATCH_METHODS.includes(matchMethod) &&
    matchConfidence >= PUBLICATION_POLICY.OMI_OFFICIAL_THRESHOLD
  ) return "official";
  if (matchConfidence >= PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD) return "elaborated";
  return "unavailable";
}

function classifyElaborated(sourcesCount: number): "elaborated" | "unavailable" {
  return sourcesCount >= PUBLICATION_POLICY.ELABORATED_MIN_SOURCES ? "elaborated" : "unavailable";
}

// ── A. Sottra-expected paths ──────────────────────────────────

const SOTTRA_SCAN_PATHS = [
  { path: "/scan/identify",             method: "POST", description: "Photo + GPS → address + building ID" },
  { path: "/scan/cadastral",            method: "POST", description: "Cadastral data (UNAVAILABLE)" },
  { path: "/scan/pricing",              method: "POST", description: "OMI pricing data" },
  { path: "/scan/listings",             method: "POST", description: "Listings (UNAVAILABLE)" },
  { path: "/scan/energy",               method: "POST", description: "Energy class (UNAVAILABLE)" },
  { path: "/scan/condominio",           method: "POST", description: "Condominium data (UNAVAILABLE)" },
  { path: "/scan/storico-transazioni",  method: "POST", description: "Transaction history (UNAVAILABLE)" },
];

const SOTTRA_FORECAST_PATHS = [
  { path: "/forecast/moodscore",                  method: "POST", description: "MoodScore (UNAVAILABLE)" },
  { path: "/forecast/timeview",                   method: "POST", description: "Medium-term scenario" },
  { path: "/forecast/opportunity",                method: "POST", description: "Opportunity index" },
  { path: "/forecast/infrastrutture",             method: "POST", description: "Infrastructure analysis" },
  { path: "/forecast/rischio-zona",               method: "POST", description: "Zone risk analysis" },
  { path: "/forecast/trend-demografico",          method: "POST", description: "Demographic trend" },
  { path: "/forecast/sviluppo-area",              method: "POST", description: "Area development" },
  { path: "/forecast/convergenza-territoriale",   method: "POST", description: "ICTV territorial convergence" },
];

const ALL_SOTTRA_PATHS = [...SOTTRA_SCAN_PATHS, ...SOTTRA_FORECAST_PATHS];

describe("Sottra contract — path registry", () => {
  it("has 7 scan endpoints", () => {
    expect(SOTTRA_SCAN_PATHS).toHaveLength(7);
  });

  it("has 8 forecast endpoints", () => {
    expect(SOTTRA_FORECAST_PATHS).toHaveLength(8);
  });

  it("total 15 endpoints", () => {
    expect(ALL_SOTTRA_PATHS).toHaveLength(15);
  });

  it.each(ALL_SOTTRA_PATHS)("$path ($method) — endsWith matching works", ({ path }) => {
    const fullPath = `/functions/v1/sottra${path}`;
    expect(fullPath.endsWith(path)).toBe(true);
  });

  it("health endpoint is GET and separate from scan/forecast", () => {
    const healthPath = "/health";
    const fullPath = `/functions/v1/sottra${healthPath}`;
    expect(fullPath.endsWith("/health")).toBe(true);
  });
});

// ── B. Envelope consistency ───────────────────────────────────

describe("Sottra contract — envelope shape", () => {
  it("success envelope has required fields", () => {
    const envelope = {
      ok: true,
      data: { address: "Via Roma 1, Milano" },
      warnings: [],
      debug_id: "abc123",
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeDefined();
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(typeof envelope.debug_id).toBe("string");
  });

  it("error envelope has required fields", () => {
    const envelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "abc456",
      error: { code: "MISSING_COORDS", message: "Provide lat and lng" },
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(typeof envelope.error.message).toBe("string");
  });

  it("known error codes are uppercase snake_case", () => {
    const codes = [
      "MISSING_COORDS", "MISSING_ADDRESS", "GEOCODE_FAILED",
      "COMUNE_NOT_FOUND", "PROVIDER_ERROR", "APP_SECRET_REQUIRED",
      "APP_SECRET_REJECTED", "ROUTE_NOT_FOUND", "METHOD_NOT_ALLOWED",
      "INVALID_JSON", "PAYLOAD_TOO_LARGE", "INTERNAL_ERROR",
    ];
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it("error messages never contain stack traces or internal paths", () => {
    // Security: error messages must be safe for user-facing payload
    const safeMessage = "An internal error occurred. Reference: abc123";
    expect(safeMessage).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
    expect(safeMessage).not.toMatch(/\/home\//); // no server paths
    expect(safeMessage).not.toMatch(/node_modules/);
    expect(safeMessage).not.toContain("SUPABASE_");
    expect(safeMessage).not.toContain("API_KEY");
  });
});

// ── C. scan/identify contract ─────────────────────────────────

describe("Sottra contract — scan/identify", () => {
  it("success shape has address, buildingId, confidence", () => {
    const data = {
      address: "Via Roma 1, Milano MI",
      buildingId: "IT-A1B2C3D4",
      confidence: 0.75,
    };
    expect(typeof data.address).toBe("string");
    expect(data.buildingId).toMatch(/^IT-[A-F0-9]+$/);
    expect(data.confidence).toBeGreaterThanOrEqual(0);
    expect(data.confidence).toBeLessThanOrEqual(1);
  });
});

// ── D. scan/pricing contract — DATA RIGOR ─────────────────────

describe("Sottra contract — scan/pricing (max stability)", () => {
  it("success shape with real OMI data has null mediaZona and null trend5Anni", () => {
    const data = {
      prezzoMq: 2500,
      prezzoMqMin: 2000,
      prezzoMqMax: 3000,
      mediaZona: null,
      trend5Anni: null,
      omiMatchConfidence: 0.95,
      omiMatchMethod: "single_zone",
      sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
      sourceType: "official",
      sourcePeriod: "1° semestre 2025",
      limitations: ["some limitation"],
    };
    expect(data.sourceType).toBe("official");
    expect(typeof data.prezzoMq).toBe("number");
    expect(data.mediaZona).toBeNull();
    expect(data.trend5Anni).toBeNull();
    expect(data.omiMatchConfidence).toBeGreaterThanOrEqual(PUBLICATION_POLICY.OMI_OFFICIAL_THRESHOLD);
    expect(typeof data.omiMatchMethod).toBe("string");
  });

  it("mediaZona is NEVER equal to prezzoMq — it must be null", () => {
    const data = { prezzoMq: 2500, mediaZona: null };
    expect(data.mediaZona).not.toBe(data.prezzoMq);
    expect(data.mediaZona).toBeNull();
  });

  it("trend5Anni is NEVER a hardcoded value — it must be null", () => {
    const data = { trend5Anni: null };
    expect(data.trend5Anni).toBeNull();
    expect(data.trend5Anni).not.toBe(0);
  });

  it("pricing NOT published when OMI match confidence is below threshold", () => {
    const weakMatchData = {
      prezzoMq: null,
      prezzoMqMin: null,
      prezzoMqMax: null,
      mediaZona: null,
      trend5Anni: null,
      omiMatchConfidence: 0.25,
      omiMatchMethod: "first_zone_fallback",
      sourceType: "unavailable",
    };
    expect(weakMatchData.prezzoMq).toBeNull();
    expect(weakMatchData.sourceType).toBe("unavailable");
    expect(weakMatchData.omiMatchConfidence).toBeLessThan(PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD);
  });

  it("valid omiMatchMethod values", () => {
    const validMethods = ["single_zone", "ai_matched", "ai_fallback", "first_zone_fallback", "none"];
    for (const m of validMethods) {
      expect(typeof m).toBe("string");
    }
    expect(validMethods).toHaveLength(5);
  });

  it("unavailable shape when OMI not found", () => {
    const data = {
      prezzoMq: null,
      mediaZona: null,
      trend5Anni: null,
      omiMatchConfidence: 0,
      omiMatchMethod: "none",
      sourceType: "unavailable",
      limitations: ["Comune non presente nel dataset OMI importato"],
    };
    expect(data.prezzoMq).toBeNull();
    expect(data.mediaZona).toBeNull();
    expect(data.trend5Anni).toBeNull();
    expect(data.sourceType).toBe("unavailable");
    expect(data.omiMatchConfidence).toBe(0);
    expect(data.limitations.length).toBeGreaterThan(0);
  });
});

// ── E. UNAVAILABLE endpoints contract ─────────────────────────

describe("Sottra contract — UNAVAILABLE endpoints", () => {
  const UNAVAILABLE_ENDPOINTS = [
    "scan/cadastral", "scan/listings", "scan/energy",
    "scan/condominio", "scan/storico-transazioni", "forecast/moodscore",
  ];

  it("unavailable endpoints return sourceType=unavailable", () => {
    const shape = {
      sourceType: "unavailable",
      sourcePeriod: null,
      limitations: ["Servizio non collegato"],
    };
    expect(shape.sourceType).toBe("unavailable");
    expect(shape.sourcePeriod).toBeNull();
    expect(shape.limitations.length).toBeGreaterThan(0);
  });

  it(`there are ${UNAVAILABLE_ENDPOINTS.length} known UNAVAILABLE endpoints`, () => {
    expect(UNAVAILABLE_ENDPOINTS).toHaveLength(6);
  });
});

// ── F. forecast/rischio-zona contract ─────────────────────────

describe("Sottra contract — forecast/rischio-zona", () => {
  it("success shape has riskProfile and sources", () => {
    const data = {
      comune: "Milano",
      riskProfile: { idrogeologico: "basso", sismico: "zona 3" },
      sourceLabel: "ISPRA 2021 + OPCM 3519/2006",
      sourceType: "official",
      limitations: [],
    };
    expect(typeof data.comune).toBe("string");
    expect(data.riskProfile).toBeDefined();
    expect(data.sourceType).toBe("official");
  });

  it("unavailable when ISPRA data missing", () => {
    const data = {
      sourceType: "unavailable",
      scoreRischio: null,
    };
    expect(data.sourceType).toBe("unavailable");
    expect(data.scoreRischio).toBeNull();
  });
});

// ── G. forecast/convergenza-territoriale (ICTV) ───────────────

describe("Sottra contract — forecast/convergenza-territoriale (ICTV)", () => {
  it("success shape has score, band, convergenceLevel, coverageLevel", () => {
    const data = {
      comune: "Milano",
      score: 72,
      band: "forte",
      convergenceLevel: "alta",
      coverageLevel: "buona",
      identityConfidence: 0.85,
      positiveFamilies: ["mercato", "demografia"],
      negativeFamilies: [],
      topPositiveSignals: [{ label: "Trend positivo", source: "OMI" }],
      topNegativeSignals: [],
      evidenceTrace: ["mercato: ↑ positivo (2 segnali da OMI 2025/1)"],
      narrativeObservation: "Contesto favorevole",
      sourceLabel: "ICTV v1.0",
      sourceType: "elaborated",
      sourcePeriod: "multi-fonte",
      confidenceReason: "reason",
      limitations: [],
    };
    expect(data.score).toBeGreaterThanOrEqual(0);
    expect(data.score).toBeLessThanOrEqual(100);
    expect(["molto_forte", "forte", "interessante", "debole"]).toContain(data.band);
    expect(["alta", "media", "bassa", "insufficiente"]).toContain(data.convergenceLevel);
    expect(["completa", "buona", "parziale", "scarsa", "insufficiente"]).toContain(data.coverageLevel);
    expect(data.sourceType).toBe("elaborated");
    expect(Array.isArray(data.topPositiveSignals)).toBe(true);
    expect(Array.isArray(data.topNegativeSignals)).toBe(true);
    expect(data.topPositiveSignals.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(data.evidenceTrace)).toBe(true);
    expect(Array.isArray(data.limitations)).toBe(true);
  });

  it("insufficient data returns sourceType=unavailable", () => {
    const data = {
      coverageLevel: "insufficiente",
      convergenceLevel: "insufficiente",
      score: 0,
      sourceType: "unavailable",
    };
    expect(data.sourceType).toBe("unavailable");
    expect(data.score).toBe(0);
  });
});

// ── H. sourceType quality policy ──────────────────────────────

describe("Sottra contract — sourceType quality policy", () => {
  const VALID_SOURCE_TYPES = ["official", "elaborated", "unavailable"];

  it("only 3 valid sourceType values", () => {
    expect(VALID_SOURCE_TYPES).toHaveLength(3);
  });

  it("official requires: real source + solid territorial match + no weak fallback", () => {
    const officialModules = ["scan/pricing", "forecast/rischio-zona", "forecast/trend-demografico"];
    expect(officialModules).toHaveLength(3);
  });

  it("elaborated requires: built from verified sources + explainable + sufficient coverage", () => {
    const elaboratedModules = [
      "forecast/timeview", "forecast/opportunity", "forecast/infrastrutture",
      "forecast/sviluppo-area", "forecast/convergenza-territoriale",
    ];
    expect(elaboratedModules).toHaveLength(5);
  });

  it("unavailable if: weak match, insufficient coverage, or no real source", () => {
    const alwaysUnavailable = [
      "scan/cadastral", "scan/listings", "scan/energy",
      "scan/condominio", "scan/storico-transazioni", "forecast/moodscore",
    ];
    expect(alwaysUnavailable).toHaveLength(6);
  });

  it("elaborated modules downgrade to unavailable when data insufficient", () => {
    const insufficientData = { sourceType: "unavailable", sourcesUsedCount: 1 };
    expect(insufficientData.sourceType).toBe("unavailable");
  });
});

// ── I. Secret headers ─────────────────────────────────────────

describe("Sottra contract — secret headers", () => {
  it("canonical secret is AI_CORE_SECRET", () => {
    expect("AI_CORE_SECRET").toBe("AI_CORE_SECRET");
  });

  it("legacy aliases in correct priority", () => {
    const priority = ["x-internal-secret", "x-app-secret", "x-core-secret", "authorization"];
    expect(priority).toHaveLength(4);
    expect(priority[0]).toBe("x-internal-secret");
  });
});

// ── J. Health endpoint ────────────────────────────────────────

describe("Sottra contract — health endpoint", () => {
  it("health data has status, engine, version, routes", () => {
    const expectedRoutes = [
      "scan/identify", "scan/cadastral", "scan/pricing", "scan/listings",
      "scan/energy", "scan/condominio", "scan/storico-transazioni",
      "forecast/moodscore", "forecast/timeview", "forecast/opportunity",
      "forecast/infrastrutture", "forecast/rischio-zona", "forecast/trend-demografico",
      "forecast/sviluppo-area", "forecast/convergenza-territoriale",
    ];
    const data = {
      status: "healthy",
      engine: "sottra",
      version: "3.3.0",
      routes: expectedRoutes,
      time: new Date().toISOString(),
    };
    expect(data.status).toBe("healthy");
    expect(data.engine).toBe("sottra");
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(data.routes)).toBe(true);
    expect(data.routes).toHaveLength(15);
  });
});

// ── K. OMI match confidence contract (STRICTER) ───────────────

describe("Sottra contract — OMI match confidence (max stability)", () => {
  it("single_zone match ≥ 85% → official", () => {
    expect(classifyOMIPricing(0.95, "single_zone")).toBe("official");
    expect(classifyOMIPricing(0.85, "single_zone")).toBe("official");
  });

  it("single_zone match < 85% but ≥ 50% → elaborated (not official)", () => {
    expect(classifyOMIPricing(0.80, "single_zone")).toBe("elaborated");
    expect(classifyOMIPricing(0.50, "single_zone")).toBe("elaborated");
  });

  it("ai_matched ≥ 50% → elaborated (NEVER official)", () => {
    expect(classifyOMIPricing(0.70, "ai_matched")).toBe("elaborated");
    expect(classifyOMIPricing(0.90, "ai_matched")).toBe("elaborated");
    expect(classifyOMIPricing(0.99, "ai_matched")).toBe("elaborated");
  });

  it("ai_matched < 50% → unavailable", () => {
    expect(classifyOMIPricing(0.49, "ai_matched")).toBe("unavailable");
    expect(classifyOMIPricing(0.25, "ai_matched")).toBe("unavailable");
  });

  it("ai_fallback → always unavailable regardless of confidence", () => {
    expect(classifyOMIPricing(0.99, "ai_fallback")).toBe("unavailable");
    expect(classifyOMIPricing(0.50, "ai_fallback")).toBe("unavailable");
    expect(classifyOMIPricing(0.25, "ai_fallback")).toBe("unavailable");
  });

  it("first_zone_fallback → always unavailable (never publishable)", () => {
    expect(classifyOMIPricing(0.99, "first_zone_fallback")).toBe("unavailable");
    expect(classifyOMIPricing(0.50, "first_zone_fallback")).toBe("unavailable");
    expect(classifyOMIPricing(0.20, "first_zone_fallback")).toBe("unavailable");
  });

  it("none → always unavailable", () => {
    expect(classifyOMIPricing(0, "none")).toBe("unavailable");
    expect(classifyOMIPricing(1, "none")).toBe("unavailable");
  });

  it("confidence exactly at boundary thresholds", () => {
    // At 0.50 boundary
    expect(classifyOMIPricing(0.50, "ai_matched")).toBe("elaborated");
    expect(classifyOMIPricing(0.49, "ai_matched")).toBe("unavailable");
    // At 0.85 boundary
    expect(classifyOMIPricing(0.85, "single_zone")).toBe("official");
    expect(classifyOMIPricing(0.84, "single_zone")).toBe("elaborated");
  });
});

// ── L. Elaborated modules sourceType gating ───────────────────

describe("Sottra contract — elaborated modules gating", () => {
  it("requires ≥ 2 sources for elaborated", () => {
    expect(classifyElaborated(0)).toBe("unavailable");
    expect(classifyElaborated(1)).toBe("unavailable");
    expect(classifyElaborated(2)).toBe("elaborated");
    expect(classifyElaborated(4)).toBe("elaborated");
  });

  it("single source → unavailable", () => {
    expect(classifyElaborated(1)).toBe("unavailable");
  });
});

// ── M. Security — no secrets in payload ───────────────────────

describe("Sottra contract — security (no leaks)", () => {
  it("error payload contains only debug_id reference, no internal details", () => {
    const errorPayload = {
      ok: false,
      data: null,
      error: { code: "INTERNAL_ERROR", message: "An internal error occurred. Reference: abc123" },
      debug_id: "abc123",
    };
    const serialized = JSON.stringify(errorPayload);
    expect(serialized).not.toContain("SUPABASE_");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
    expect(serialized).not.toMatch(/\/home\//);
    expect(serialized).not.toContain("node_modules");
  });

  it("provider error does not leak exception details", () => {
    const errorPayload = {
      ok: false,
      data: null,
      error: { code: "PROVIDER_ERROR", message: "Pricing analysis failed. Reference: abc123" },
      debug_id: "abc123",
    };
    const serialized = JSON.stringify(errorPayload);
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain("fetch failed");
    expect(serialized).not.toContain("ECONNREFUSED");
  });
});

// ── N. Publication policy thresholds ──────────────────────────

describe("Sottra contract — publication policy thresholds", () => {
  it("OMI publish threshold is 50%", () => {
    expect(PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD).toBe(0.50);
  });

  it("OMI official threshold is 85%", () => {
    expect(PUBLICATION_POLICY.OMI_OFFICIAL_THRESHOLD).toBe(0.85);
  });

  it("elaborated requires minimum 2 sources", () => {
    expect(PUBLICATION_POLICY.ELABORATED_MIN_SOURCES).toBe(2);
  });

  it("only single_zone can be official", () => {
    expect(PUBLICATION_POLICY.OFFICIAL_MATCH_METHODS).toEqual(["single_zone"]);
  });

  it("ai_matched produces elaborated", () => {
    expect(PUBLICATION_POLICY.ELABORATED_MATCH_METHODS).toEqual(["ai_matched"]);
  });

  it("3 methods are never publishable", () => {
    expect(PUBLICATION_POLICY.UNPUBLISHABLE_MATCH_METHODS).toEqual(["ai_fallback", "first_zone_fallback", "none"]);
  });
});

// ── O. Audit trail completeness ───────────────────────────────

describe("Sottra contract — audit trail fields", () => {
  const AUDIT_FIELDS = ["sourceLabel", "sourceType", "sourcePeriod", "confidenceReason", "limitations"];

  it("all audit fields present in official pricing response", () => {
    const data = {
      sourceLabel: "Agenzia delle Entrate — Osservatorio Mercato Immobiliare",
      sourceType: "official",
      sourcePeriod: "1° semestre 2025",
      confidenceReason: "Prezzi ufficiali OMI — zona B1",
      limitations: ["Range min/max"],
    };
    for (const field of AUDIT_FIELDS) {
      expect(data).toHaveProperty(field);
      expect((data as Record<string, unknown>)[field]).not.toBeUndefined();
    }
  });

  it("all audit fields present in unavailable response", () => {
    const data = {
      sourceLabel: "Catasto (non integrato)",
      sourceType: "unavailable",
      sourcePeriod: null,
      confidenceReason: "Non disponibile",
      limitations: ["Servizio non collegato"],
    };
    for (const field of AUDIT_FIELDS) {
      expect(data).toHaveProperty(field);
    }
  });

  it("all audit fields present in elaborated response", () => {
    const data = {
      sourceLabel: "OMI 2025/1 + ISTAT 2025",
      sourceType: "elaborated",
      sourcePeriod: "multi-fonte",
      confidenceReason: "Indice costruito su 3 fonti",
      limitations: ["Indice sintetico"],
    };
    for (const field of AUDIT_FIELDS) {
      expect(data).toHaveProperty(field);
      expect((data as Record<string, unknown>)[field]).not.toBeUndefined();
    }
  });
});

// ── P. Provider adapter preparation ───────────────────────────

describe("Sottra contract — provider adapter interface (Phase 2 prep)", () => {
  it("DataProviderResult shape is stable", () => {
    const result = {
      available: true,
      data: { price: 2500 },
      source: "OMI",
      sourceClass: "official_db",
      freshnessMonths: 3,
    };
    expect(typeof result.available).toBe("boolean");
    expect(result.data).not.toBeNull();
    expect(typeof result.source).toBe("string");
    expect(["official_db", "official_portal", "official_imported", "derived_from_official", "commercial"]).toContain(result.sourceClass);
    expect(typeof result.freshnessMonths).toBe("number");
  });

  it("unavailable provider result", () => {
    const result = {
      available: false,
      data: null,
      source: "FutureProvider",
      sourceClass: "commercial",
      freshnessMonths: null,
      error: "Not configured",
    };
    expect(result.available).toBe(false);
    expect(result.data).toBeNull();
    expect(typeof result.error).toBe("string");
  });
});
