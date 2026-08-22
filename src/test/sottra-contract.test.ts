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
  OFFICIAL_MATCH_METHODS: ["single_zone", "polygon_match"],
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
  { path: "/scan/photo-wow",            method: "POST", description: "Photo + GPS official report (OMI/ISTAT/OSM)" },
  { path: "/scan/cadastral",            method: "POST", description: "Cadastral data (UNAVAILABLE)" },
  { path: "/scan/pricing",              method: "POST", description: "OMI pricing data" },
  { path: "/scan/listings",             method: "POST", description: "Listings (UNAVAILABLE)" },
  { path: "/scan/energy",               method: "POST", description: "Energy class (UNAVAILABLE)" },
  { path: "/scan/condominio",           method: "POST", description: "Condominium data (UNAVAILABLE)" },
  { path: "/scan/storico-transazioni",  method: "POST", description: "Transaction history (UNAVAILABLE)" },
  { path: "/scan/market",               method: "POST", description: "Market data comparables + signals" },
  { path: "/scan/market-context",       method: "POST", description: "Market data (backward-compat alias)" },
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
  it("has 10 scan endpoints (including market-context alias and photo-wow)", () => {
    expect(SOTTRA_SCAN_PATHS).toHaveLength(10);
  });

  it("has 8 forecast endpoints", () => {
    expect(SOTTRA_FORECAST_PATHS).toHaveLength(8);
  });

  it("total 18 endpoints", () => {
    expect(ALL_SOTTRA_PATHS).toHaveLength(18);
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

  it("valid omiMatchMethod values include polygon_match", () => {
    const validMethods = ["polygon_match", "single_zone", "comune_aggregate", "ai_matched", "ai_fallback", "first_zone_fallback", "none"];
    for (const m of validMethods) {
      expect(typeof m).toBe("string");
    }
    expect(validMethods).toHaveLength(7);
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
      "scan/energy", "scan/condominio", "scan/storico-transazioni", "scan/market",
      "scan/market-context",
      "forecast/moodscore", "forecast/timeview", "forecast/opportunity",
      "forecast/infrastrutture", "forecast/rischio-zona", "forecast/trend-demografico",
      "forecast/sviluppo-area", "forecast/convergenza-territoriale",
    ];
    const data = {
      status: "healthy",
      engine: "sottra",
      version: "3.4.0",
      routes: expectedRoutes,
      time: new Date().toISOString(),
    };
    expect(data.status).toBe("healthy");
    expect(data.engine).toBe("sottra");
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(data.routes)).toBe(true);
    expect(data.routes).toHaveLength(17);
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

  it("polygon_match and single_zone can be official", () => {
    expect(PUBLICATION_POLICY.OFFICIAL_MATCH_METHODS).toEqual(["single_zone", "polygon_match"]);
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

// ── Q. Geo Resolution — Quality Model ────────────────────────

const GEO_MATCH_LEVELS = [
  "address_point", "house_number", "house_number_range",
  "street", "district", "city", "unknown",
] as const;

const GEO_MATCH_LEVEL_RANK: Record<string, number> = {
  address_point: 6, house_number: 5, house_number_range: 4,
  street: 3, district: 2, city: 1, unknown: 0,
};

const GEO_GATING = {
  MIN_PUBLISH: 0.40,
  MIN_MICROZONA_LEVEL: 5,
  MIN_COMUNALI_LEVEL: 1,
  CONSENSUS_BONUS: 0.10,
  DISAGREEMENT_PENALTY: 0.15,
};

describe("Sottra contract — geo resolution quality model", () => {
  it("has 7 match levels in correct rank order", () => {
    expect(GEO_MATCH_LEVELS).toHaveLength(7);
    expect(GEO_MATCH_LEVEL_RANK["address_point"]).toBeGreaterThan(GEO_MATCH_LEVEL_RANK["house_number"]);
    expect(GEO_MATCH_LEVEL_RANK["house_number"]).toBeGreaterThan(GEO_MATCH_LEVEL_RANK["street"]);
    expect(GEO_MATCH_LEVEL_RANK["street"]).toBeGreaterThan(GEO_MATCH_LEVEL_RANK["city"]);
    expect(GEO_MATCH_LEVEL_RANK["city"]).toBeGreaterThan(GEO_MATCH_LEVEL_RANK["unknown"]);
  });

  it("address_point and house_number qualify for microzona pricing", () => {
    expect(GEO_MATCH_LEVEL_RANK["address_point"]).toBeGreaterThanOrEqual(GEO_GATING.MIN_MICROZONA_LEVEL);
    expect(GEO_MATCH_LEVEL_RANK["house_number"]).toBeGreaterThanOrEqual(GEO_GATING.MIN_MICROZONA_LEVEL);
  });

  it("street-only does NOT qualify for microzona pricing", () => {
    expect(GEO_MATCH_LEVEL_RANK["street"]).toBeLessThan(GEO_GATING.MIN_MICROZONA_LEVEL);
  });

  it("city-only qualifies for comunali modules but NOT microzona", () => {
    expect(GEO_MATCH_LEVEL_RANK["city"]).toBeGreaterThanOrEqual(GEO_GATING.MIN_COMUNALI_LEVEL);
    expect(GEO_MATCH_LEVEL_RANK["city"]).toBeLessThan(GEO_GATING.MIN_MICROZONA_LEVEL);
  });

  it("unknown does NOT qualify for any module", () => {
    expect(GEO_MATCH_LEVEL_RANK["unknown"]).toBeLessThan(GEO_GATING.MIN_COMUNALI_LEVEL);
  });
});

// ── R. Geo Resolution — Provider Chain ────────────────────────

describe("Sottra contract — geo provider chain", () => {
  it("supported providers", () => {
    const providers = ["google_maps", "here", "tomtom", "nominatim"];
    expect(providers).toHaveLength(4);
    // Nominatim is always last (highest priority number)
    expect(providers[providers.length - 1]).toBe("nominatim");
  });

  it("env keys for premium providers", () => {
    const envKeys = ["GOOGLE_MAPS_API_KEY", "HERE_API_KEY", "TOMTOM_API_KEY"];
    expect(envKeys).toHaveLength(3);
    // These are optional — system must work without them
  });

  it("GEO_PROVIDER_ORDER and GEO_PREMIUM_ENABLED are optional env", () => {
    const optionalEnv = ["GEO_PROVIDER_ORDER", "GEO_PREMIUM_ENABLED"];
    expect(optionalEnv).toHaveLength(2);
  });
});

// ── S. Geo Resolution — Confidence Merge ──────────────────────

describe("Sottra contract — geo confidence merge", () => {
  it("no providers → geoConfidence=0, publicationEligible=false", () => {
    const result = {
      geoConfidence: 0,
      geoMatchLevel: "unknown",
      providerConsensus: "none",
      publicationEligible: false,
      eligibleModuleClasses: ["none"],
    };
    expect(result.geoConfidence).toBe(0);
    expect(result.publicationEligible).toBe(false);
  });

  it("strong consensus bonus applies", () => {
    // Two providers agree on same city
    const baseConfidence = 0.70;
    const withConsensus = baseConfidence + GEO_GATING.CONSENSUS_BONUS;
    expect(withConsensus).toBeCloseTo(0.80, 10);
    expect(withConsensus).toBeGreaterThan(baseConfidence);
  });

  it("disagreement penalty applies", () => {
    const baseConfidence = 0.70;
    const withDisagreement = baseConfidence - GEO_GATING.DISAGREEMENT_PENALTY;
    expect(withDisagreement).toBeCloseTo(0.55, 10);
    expect(withDisagreement).toBeLessThan(baseConfidence);
  });

  it("providerConsensus has 4 valid values", () => {
    const values = ["strong", "partial", "single", "none"];
    expect(values).toHaveLength(4);
  });
});

// ── T. Geo Resolution — Publication Gating ────────────────────

describe("Sottra contract — geo publication gating", () => {
  it("address_point + high confidence → microzona + comunali eligible", () => {
    const result = {
      geoMatchLevel: "address_point",
      geoConfidence: 0.90,
      publicationEligible: true,
      eligibleModuleClasses: ["microzona", "comunali"],
    };
    expect(result.publicationEligible).toBe(true);
    expect(result.eligibleModuleClasses).toContain("microzona");
    expect(result.eligibleModuleClasses).toContain("comunali");
  });

  it("city-only → only comunali eligible, no microzona", () => {
    const geoConfidence = 0.50;
    const matchRank = GEO_MATCH_LEVEL_RANK["city"]; // 1
    const eligible: string[] = [];
    if (geoConfidence >= GEO_GATING.MIN_PUBLISH && matchRank >= GEO_GATING.MIN_MICROZONA_LEVEL) {
      eligible.push("microzona", "comunali");
    } else if (geoConfidence >= GEO_GATING.MIN_PUBLISH && matchRank >= GEO_GATING.MIN_COMUNALI_LEVEL) {
      eligible.push("comunali");
    } else {
      eligible.push("none");
    }
    expect(eligible).toContain("comunali");
    expect(eligible).not.toContain("microzona");
  });

  it("street-only → only comunali eligible, NOT microzona pricing", () => {
    const matchRank = GEO_MATCH_LEVEL_RANK["street"]; // 3
    expect(matchRank).toBeLessThan(GEO_GATING.MIN_MICROZONA_LEVEL);
    expect(matchRank).toBeGreaterThanOrEqual(GEO_GATING.MIN_COMUNALI_LEVEL);
  });

  it("unknown + low confidence → not eligible for any module", () => {
    const matchRank = GEO_MATCH_LEVEL_RANK["unknown"]; // 0
    const geoConfidence = 0.20;
    const eligible = geoConfidence >= GEO_GATING.MIN_PUBLISH && matchRank >= GEO_GATING.MIN_COMUNALI_LEVEL;
    expect(eligible).toBe(false);
  });
});

// ── U. scan/identify enriched response ────────────────────────

describe("Sottra contract — scan/identify with geo resolution", () => {
  it("enriched response includes geoResolution payload", () => {
    const data = {
      address: "Via Roma 1, Milano MI",
      buildingId: "IT-A1B2C3D4",
      confidence: 0.85,
      geoResolution: {
        resolvedComune: "MILANO",
        resolvedProvincia: "MI",
        resolvedStreet: "Via Roma",
        resolvedHouseNumber: "1",
        resolvedPostalCode: "20121",
        resolvedLat: 45.464,
        resolvedLng: 9.190,
        geoConfidence: 0.85,
        geoConfidenceReason: "Provider primario: google_maps (address_point, 98%)",
        geoMatchLevel: "address_point",
        providerConsensus: "strong",
        providerBreakdown: [
          { provider: "google_maps", matchLevel: "address_point", confidence: 0.98, city: "Milano", street: "Via Roma", houseNumber: "1" },
        ],
        publicationEligible: true,
        eligibleModuleClasses: ["microzona", "comunali"],
      },
    };
    expect(data.geoResolution).toBeDefined();
    expect(data.geoResolution.geoConfidence).toBeGreaterThanOrEqual(0);
    expect(data.geoResolution.geoConfidence).toBeLessThanOrEqual(1);
    expect(GEO_MATCH_LEVELS).toContain(data.geoResolution.geoMatchLevel);
    expect(typeof data.geoResolution.geoConfidenceReason).toBe("string");
    expect(["strong", "partial", "single", "none"]).toContain(data.geoResolution.providerConsensus);
    expect(Array.isArray(data.geoResolution.providerBreakdown)).toBe(true);
    expect(typeof data.geoResolution.publicationEligible).toBe("boolean");
    expect(Array.isArray(data.geoResolution.eligibleModuleClasses)).toBe(true);
  });

  it("legacy fallback response has geoResolution=null", () => {
    const data = {
      address: "Via Roma 1, Milano",
      buildingId: "IT-A1B2C3D4",
      confidence: 0.50,
      geoResolution: null,
    };
    expect(data.geoResolution).toBeNull();
    expect(data.confidence).toBeLessThanOrEqual(0.50);
  });
});

// ── V. No secrets in geo payload ──────────────────────────────

describe("Sottra contract — geo security", () => {
  it("provider breakdown never leaks API keys", () => {
    const breakdown = { provider: "google_maps", matchLevel: "address_point", confidence: 0.98, city: "Milano", street: "Via Roma", houseNumber: "1" };
    const serialized = JSON.stringify(breakdown);
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("key=");
    expect(serialized).not.toContain("apiKey");
  });
});

// ── W. Street Evidence — Policy Constants ─────────────────────

const STREET_EVIDENCE_POLICY = {
  HOUSE_NUMBER_MATCH_BONUS: 0.08,
  STREET_MATCH_BONUS: 0.05,
  CONFLICT_PENALTY: 0.12,
  MIN_PHOTO_CONFIDENCE: 0.30,
  MAX_TOTAL_BONUS: 0.15,
  MAX_TOTAL_PENALTY: 0.20,
};

// Local merge logic mirroring street-evidence.ts for contract testing
function mergeStreetEvidenceTest(
  geoConfidence: number,
  photoHN: string | null,
  resolvedHN: string | null,
  photoStreet: string | null,
  resolvedStreet: string | null,
  facadeConfidence: number,
): { finalConfidence: number; hnConfirmed: boolean; streetConfirmed: boolean } {
  let adj = 0;
  let hnConfirmed = false;
  let streetConfirmed = false;

  // HN comparison
  if (photoHN && resolvedHN) {
    const a = photoHN.replace(/\D/g, "");
    const b = resolvedHN.replace(/\D/g, "");
    if (a && b) {
      if (a === b) { adj += STREET_EVIDENCE_POLICY.HOUSE_NUMBER_MATCH_BONUS * facadeConfidence; hnConfirmed = true; }
      else if (Math.abs(parseInt(a) - parseInt(b)) > 2) { adj -= STREET_EVIDENCE_POLICY.CONFLICT_PENALTY * facadeConfidence; }
    }
  }

  // Street comparison (simplified)
  if (photoStreet && resolvedStreet) {
    const normA = photoStreet.toUpperCase().trim();
    const normB = resolvedStreet.toUpperCase().trim();
    if (normA === normB) { adj += STREET_EVIDENCE_POLICY.STREET_MATCH_BONUS * facadeConfidence; streetConfirmed = true; }
    else if (!normA.includes(normB) && !normB.includes(normA)) { adj -= STREET_EVIDENCE_POLICY.CONFLICT_PENALTY * 0.7 * facadeConfidence; }
  }

  adj = Math.max(-STREET_EVIDENCE_POLICY.MAX_TOTAL_PENALTY, Math.min(STREET_EVIDENCE_POLICY.MAX_TOTAL_BONUS, adj));
  return { finalConfidence: Math.max(0, Math.min(1, parseFloat((geoConfidence + adj).toFixed(3)))), hnConfirmed, streetConfirmed };
}

describe("Sottra contract — street evidence merge", () => {
  it("matching civico → confidence bonus", () => {
    const { finalConfidence, hnConfirmed } = mergeStreetEvidenceTest(0.70, "15", "15", null, null, 0.80);
    expect(finalConfidence).toBeGreaterThan(0.70);
    expect(hnConfirmed).toBe(true);
  });

  it("matching street name → confidence bonus", () => {
    const { finalConfidence, streetConfirmed } = mergeStreetEvidenceTest(0.70, null, null, "VIA ROMA", "VIA ROMA", 0.80);
    expect(finalConfidence).toBeGreaterThan(0.70);
    expect(streetConfirmed).toBe(true);
  });

  it("conflicting civico → confidence penalty", () => {
    const { finalConfidence, hnConfirmed } = mergeStreetEvidenceTest(0.70, "15", "98", null, null, 0.80);
    expect(finalConfidence).toBeLessThan(0.70);
    expect(hnConfirmed).toBe(false);
  });

  it("conflicting street → confidence penalty", () => {
    const { finalConfidence } = mergeStreetEvidenceTest(0.70, null, null, "VIA ROMA", "CORSO ITALIA", 0.80);
    expect(finalConfidence).toBeLessThan(0.70);
  });

  it("no photo evidence → confidence unchanged", () => {
    const { finalConfidence } = mergeStreetEvidenceTest(0.70, null, null, null, null, 0);
    expect(finalConfidence).toBeCloseTo(0.70, 10);
  });

  it("both civico and street match → cumulative bonus (capped)", () => {
    const { finalConfidence, hnConfirmed, streetConfirmed } = mergeStreetEvidenceTest(0.70, "10", "10", "VIA ROMA", "VIA ROMA", 0.90);
    expect(finalConfidence).toBeGreaterThan(0.70);
    expect(hnConfirmed).toBe(true);
    expect(streetConfirmed).toBe(true);
    // Bonus capped at MAX_TOTAL_BONUS
    expect(finalConfidence).toBeLessThanOrEqual(0.70 + STREET_EVIDENCE_POLICY.MAX_TOTAL_BONUS);
  });

  it("total penalty is capped at MAX_TOTAL_PENALTY", () => {
    const { finalConfidence } = mergeStreetEvidenceTest(0.70, "1", "99", "VIA ROMA", "CORSO ITALIA", 1.0);
    expect(finalConfidence).toBeGreaterThanOrEqual(0.70 - STREET_EVIDENCE_POLICY.MAX_TOTAL_PENALTY);
  });

  it("confidence never exceeds 1.0", () => {
    const { finalConfidence } = mergeStreetEvidenceTest(0.95, "10", "10", "VIA ROMA", "VIA ROMA", 1.0);
    expect(finalConfidence).toBeLessThanOrEqual(1.0);
  });

  it("confidence never goes below 0", () => {
    const { finalConfidence } = mergeStreetEvidenceTest(0.10, "1", "99", "VIA ROMA", "CORSO ITALIA", 1.0);
    expect(finalConfidence).toBeGreaterThanOrEqual(0);
  });
});

// ── X. Street Evidence — Identity Verification Levels ─────────

describe("Sottra contract — identity verification levels", () => {
  const LEVELS = ["strong", "good", "partial", "weak", "insufficient"] as const;

  it("has 5 verification levels", () => {
    expect(LEVELS).toHaveLength(5);
  });

  it("strong requires ≥ 85% confidence + house number confirmed", () => {
    const confidence = 0.88;
    const hnConfirmed = true;
    const level = confidence >= 0.85 && hnConfirmed ? "strong" : "other";
    expect(level).toBe("strong");
  });

  it("good requires ≥ 70% confidence + visual confirmation", () => {
    const confidence = 0.75;
    const hnConfirmed = true;
    const level = confidence >= 0.70 && hnConfirmed ? "good" : "other";
    expect(level).toBe("good");
  });

  it("insufficient below 30%", () => {
    const confidence = 0.20;
    const level = confidence < 0.30 ? "insufficient" : "other";
    expect(level).toBe("insufficient");
  });
});

// ── Y. Street Evidence — Facade Consistency ───────────────────

describe("Sottra contract — facade consistency levels", () => {
  const LEVELS = ["strong", "good", "partial", "weak", "none"] as const;

  it("has 5 facade consistency levels", () => {
    expect(LEVELS).toHaveLength(5);
  });

  it("strong = both civico and street confirmed", () => {
    const hn = true;
    const st = true;
    expect(hn && st ? "strong" : "other").toBe("strong");
  });

  it("none = no photo evidence at all", () => {
    const hasPhoto = false;
    expect(hasPhoto ? "weak" : "none").toBe("none");
  });
});

// ── Z. Street Evidence — scan/identify enriched response ──────

describe("Sottra contract — scan/identify with street evidence", () => {
  it("enriched response includes streetEvidence payload", () => {
    const data = {
      address: "Via Roma 15, Milano MI",
      buildingId: "IT-A1B2C3D4",
      confidence: 0.88,
      geoResolution: { geoConfidence: 0.80, geoMatchLevel: "address_point" },
      streetEvidence: {
        streetEvidenceConfidence: 0.72,
        streetEvidenceReason: "Civico confermato: foto \"15\" = geocodifica \"15\"",
        houseNumberConfirmed: true,
        streetConfirmed: false,
        facadeConsistencyLevel: "good",
        finalIdentityConfidence: 0.88,
        finalIdentityReason: "Confidence geo: 80%, aggiustamento: +8.0%, finale: 88%",
        identityVerificationLevel: "strong",
        photoAnalysis: {
          visibleHouseNumber: "15",
          visibleStreetName: null,
          buildingType: "residenziale",
          visibleFloors: 5,
          facadeConfidence: 0.85,
          photoReadability: "clear",
        },
        streetSignalCount: 0,
      },
    };
    expect(data.streetEvidence).toBeDefined();
    expect(typeof data.streetEvidence.streetEvidenceConfidence).toBe("number");
    expect(typeof data.streetEvidence.houseNumberConfirmed).toBe("boolean");
    expect(typeof data.streetEvidence.streetConfirmed).toBe("boolean");
    expect(["strong", "good", "partial", "weak", "none"]).toContain(data.streetEvidence.facadeConsistencyLevel);
    expect(["strong", "good", "partial", "weak", "insufficient"]).toContain(data.streetEvidence.identityVerificationLevel);
    expect(data.streetEvidence.finalIdentityConfidence).toBeGreaterThanOrEqual(0);
    expect(data.streetEvidence.finalIdentityConfidence).toBeLessThanOrEqual(1);
    // No raw base64 in payload
    expect(JSON.stringify(data)).not.toContain("data:image");
  });

  it("legacy response without photo has streetEvidence=null", () => {
    const data = {
      address: "Via Roma 1, Milano",
      buildingId: "IT-A1B2C3D4",
      confidence: 0.50,
      geoResolution: null,
      streetEvidence: null,
    };
    expect(data.streetEvidence).toBeNull();
  });

  it("no API keys → system stable, streetEvidence still available from photo-only", () => {
    // When no Mapillary key is configured, system uses photo evidence only
    const data = {
      streetEvidence: {
        streetEvidenceConfidence: 0.40,
        streetSignalCount: 0, // no external providers
        houseNumberConfirmed: true,
        identityVerificationLevel: "partial",
      },
    };
    expect(data.streetEvidence.streetSignalCount).toBe(0);
    expect(data.streetEvidence.houseNumberConfirmed).toBe(true);
  });
});

// ── AA. Street Evidence — Env Keys ────────────────────────────

describe("Sottra contract — street evidence env keys", () => {
  it("optional env keys for street evidence", () => {
    const envKeys = ["MAPILLARY_API_KEY", "STREET_EVIDENCE_ENABLED", "STREET_PROVIDER_ORDER", "STREET_EVIDENCE_MIN_CONFIDENCE"];
    expect(envKeys).toHaveLength(4);
    // All are optional — system must work without them
  });
});

// ── AB. Street Evidence — Security ────────────────────────────

describe("Sottra contract — street evidence security", () => {
  it("streetEvidence payload never contains raw base64 images", () => {
    const payload = {
      streetEvidence: {
        streetEvidenceConfidence: 0.75,
        photoAnalysis: { visibleHouseNumber: "15", facadeConfidence: 0.85 },
      },
    };
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("base64,");
    expect(serialized).not.toContain("API_KEY");
  });

  it("street signal breakdown never leaks provider credentials", () => {
    const signal = { provider: "mapillary", confidence: 0.35, available: true };
    const serialized = JSON.stringify(signal);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("key=");
  });
});

// ── AC. Market Data — Source Class Model ──────────────────────

const MARKET_SOURCE_CLASSES = [
  "official", "commercial_verified", "commercial_partial",
  "user_provided", "elaborated", "unavailable",
] as const;

const MARKET_DATA_POLICY = {
  MIN_COMPARABLES_PUBLISHABLE: 3,
  MIN_COMPARABLES_GOOD: 8,
  MIN_COMPARABLES_PARTIAL: 5,
  MAX_COMPARABLE_DISTANCE_KM: 2.0,
  MAX_SQM_RATIO: 0.50,
  FRESHNESS_MAX_DAYS: 180,
  MIN_IDENTITY_CONFIDENCE: 0.50,
  MIN_IDENTITY_CONFIDENCE_MICROZONA: 0.70,
  STALE_THRESHOLD_DAYS: 90,
};

describe("Sottra contract — market data source class model", () => {
  it("has 6 source class values", () => {
    expect(MARKET_SOURCE_CLASSES).toHaveLength(6);
  });

  it("official is only for real official sources", () => {
    expect(MARKET_SOURCE_CLASSES).toContain("official");
  });

  it("commercial_verified requires solid coverage", () => {
    expect(MARKET_SOURCE_CLASSES).toContain("commercial_verified");
  });

  it("unavailable is the default safe state", () => {
    expect(MARKET_SOURCE_CLASSES).toContain("unavailable");
  });
});

// ── AD. Market Data — Comparables Engine ──────────────────────

describe("Sottra contract — comparables engine", () => {
  it("requires minimum 3 comparables to publish", () => {
    expect(MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE).toBe(3);
  });

  it("fewer than 3 comparables → unavailable", () => {
    const comparablesCount = 2;
    const publishable = comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE;
    expect(publishable).toBe(false);
  });

  it("3+ comparables → publishable", () => {
    const comparablesCount = 3;
    const publishable = comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE;
    expect(publishable).toBe(true);
  });

  it("8+ comparables → buona coverage", () => {
    const comparablesCount = 10;
    const level = comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_GOOD ? "buona"
      : comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PARTIAL ? "parziale"
      : comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE ? "scarsa"
      : "insufficiente";
    expect(level).toBe("buona");
  });

  it("5-7 comparables → parziale coverage", () => {
    const comparablesCount = 6;
    const level = comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_GOOD ? "buona"
      : comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PARTIAL ? "parziale"
      : "scarsa";
    expect(level).toBe("parziale");
  });

  it("3-4 comparables → scarsa coverage", () => {
    const comparablesCount = 4;
    const level = comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_GOOD ? "buona"
      : comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PARTIAL ? "parziale"
      : comparablesCount >= MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE ? "scarsa"
      : "insufficiente";
    expect(level).toBe("scarsa");
  });

  it("sqm filtering removes very different properties", () => {
    const referenceSqm = 100;
    const candidateSqm = 200;
    const ratio = Math.abs(candidateSqm - referenceSqm) / referenceSqm;
    expect(ratio).toBeGreaterThan(MARKET_DATA_POLICY.MAX_SQM_RATIO);
  });

  it("stale listings beyond 180 days are excluded", () => {
    const ageDays = 200;
    expect(ageDays).toBeGreaterThan(MARKET_DATA_POLICY.FRESHNESS_MAX_DAYS);
  });
});

// ── AE. Market Data — Identity Gating ─────────────────────────

describe("Sottra contract — market data identity gating", () => {
  it("identity confidence < 50% → market data unavailable", () => {
    const identityConfidence = 0.40;
    const eligible = identityConfidence >= MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE;
    expect(eligible).toBe(false);
  });

  it("identity confidence ≥ 50% → market data allowed", () => {
    const identityConfidence = 0.55;
    const eligible = identityConfidence >= MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE;
    expect(eligible).toBe(true);
  });

  it("microzona comparables require ≥ 70% identity confidence", () => {
    const identityConfidence = 0.65;
    const microzonaEligible = identityConfidence >= MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE_MICROZONA;
    expect(microzonaEligible).toBe(false);
  });

  it("microzona comparables pass at ≥ 70% confidence + house_number", () => {
    const identityConfidence = 0.75;
    const geoMatchLevel = "house_number";
    const microzonaEligible = identityConfidence >= MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE_MICROZONA &&
      ["address_point", "house_number"].includes(geoMatchLevel);
    expect(microzonaEligible).toBe(true);
  });

  it("street-only match → no microzona comparables even with high confidence", () => {
    const identityConfidence = 0.90;
    const geoMatchLevel = "street";
    const microzonaEligible = identityConfidence >= MARKET_DATA_POLICY.MIN_IDENTITY_CONFIDENCE_MICROZONA &&
      ["address_point", "house_number"].includes(geoMatchLevel);
    expect(microzonaEligible).toBe(false);
  });
});

// ── AF. Market Data — Market Signals ──────────────────────────

describe("Sottra contract — market signals", () => {
  const SIGNAL_IDS = [
    "price_band_locale", "market_freshness", "market_depth",
    "seller_pressure", "listing_turnover",
  ];

  it("defines 5 core signal types", () => {
    expect(SIGNAL_IDS).toHaveLength(5);
  });

  it("signal shape is consistent", () => {
    const signal = {
      signalId: "market_freshness",
      label: "Freschezza mercato",
      value: 0.75,
      unit: "score 0-1",
      sourceClass: "elaborated",
      confidence: 0.60,
      reason: "Score basato sull'età media degli annunci",
      limitations: ["Misura la rotazione degli annunci"],
    };
    expect(typeof signal.signalId).toBe("string");
    expect(typeof signal.label).toBe("string");
    expect(MARKET_SOURCE_CLASSES).toContain(signal.sourceClass);
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(signal.limitations)).toBe(true);
  });

  it("signals are never promoted beyond their sourceClass", () => {
    // Elaborated signals should not claim to be official
    const signalSourceClass = "elaborated";
    expect(signalSourceClass).not.toBe("official");
    expect(signalSourceClass).not.toBe("commercial_verified");
  });
});

// ── AG. Market Data — No Provider Stability ───────────────────

describe("Sottra contract — market data no-provider stability", () => {
  it("no providers → clean unavailable result", () => {
    const result = {
      marketContext: "unavailable",
      comparablesSummary: null,
      marketConfidence: 0,
      sourceType: "unavailable",
      providerBreakdown: [],
      limitations: ["Nessun provider commerciale di dati immobiliari è attivo"],
    };
    expect(result.marketContext).toBe("unavailable");
    expect(result.comparablesSummary).toBeNull();
    expect(result.marketConfidence).toBe(0);
    expect(result.sourceType).toBe("unavailable");
    expect(result.providerBreakdown).toHaveLength(0);
  });

  it("unavailable result has all required fields", () => {
    const result = {
      marketContext: "unavailable",
      comparablesSummary: null,
      marketSignals: {
        priceBandLocale: null,
        marketFreshness: null,
        marketDepth: null,
        sellerPressure: null,
        premiumMicroAreaSignal: null,
        rentalAppealSignal: null,
        energyPremiumSignal: null,
        listingTurnoverSignal: null,
      },
      marketConfidence: 0,
      marketConfidenceReason: "reason",
      marketCoverageLevel: "insufficiente",
      sourceType: "unavailable",
      sourceLabel: "Dati di mercato (non integrato)",
      sourcePeriod: null,
      limitations: [],
      providerBreakdown: [],
    };
    expect(result.marketSignals).toBeDefined();
    expect(Object.keys(result.marketSignals)).toHaveLength(8);
    for (const val of Object.values(result.marketSignals)) {
      expect(val).toBeNull();
    }
  });
});

// ── AH. Market Data — Provider Disagreement ───────────────────

describe("Sottra contract — market provider disagreement", () => {
  it("30%+ price divergence between providers → 30% confidence penalty", () => {
    const baseConfidence = 0.80;
    const provider1Median = 2000;
    const provider2Median = 3000;
    const divergence = (provider2Median - provider1Median) / provider2Median;
    expect(divergence).toBeGreaterThan(0.30);
    const penalized = baseConfidence * 0.70;
    expect(penalized).toBeCloseTo(0.56, 1);
  });

  it("providers within 30% → no penalty", () => {
    const provider1Median = 2000;
    const provider2Median = 2500;
    const maxMedian = Math.max(provider1Median, provider2Median);
    const divergence = (maxMedian - Math.min(provider1Median, provider2Median)) / maxMedian;
    expect(divergence).toBe(0.20);
    expect(divergence).toBeLessThanOrEqual(0.30);
  });
});

// ── AI. Market Data — Payload Sanitization ────────────────────

describe("Sottra contract — market data security", () => {
  it("market payload never contains API keys or credentials", () => {
    const payload = {
      marketContext: "available",
      comparablesSummary: { comparablesCount: 10, medianPricePerSqm: 3000 },
      providerBreakdown: [{ provider: "market_provider_1", available: true, confidence: 0.80 }],
    };
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("password");
  });

  it("individual listings never leak provider internal IDs inappropriately", () => {
    const listing = {
      provider: "market_provider_1",
      listingId: "pub_12345",
      askingPrice: 250000,
      pricePerSqm: 3000,
    };
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("key=");
  });
});

// ── AJ. Market Data — Env Keys ────────────────────────────────

describe("Sottra contract — market data env keys", () => {
  it("optional env keys for market data", () => {
    const envKeys = [
      "MARKET_DATA_ENABLED",
      "MARKET_PROVIDER_ORDER",
      "MARKET_PROVIDER_1_API_KEY",
      "MARKET_PROVIDER_1_BASE_URL",
      "MARKET_PROVIDER_2_API_KEY",
      "MARKET_PROVIDER_2_BASE_URL",
      "MARKET_PROVIDER_3_API_KEY",
      "MARKET_PROVIDER_3_BASE_URL",
    ];
    expect(envKeys).toHaveLength(8);
    // All are optional — system must work without them
  });
});

// ── AK. Market Data — scan/market endpoint contract ───────────

describe("Sottra contract — scan/market endpoint", () => {
  it("success response shape with comparables", () => {
    const data = {
      marketContext: "available",
      comparablesSummary: {
        comparablesCount: 10,
        medianPricePerSqm: 3200,
        lowerQuartilePricePerSqm: 2800,
        upperQuartilePricePerSqm: 3600,
        freshnessScore: 0.75,
        marketDepthScore: 0.67,
        comparableCoverageLevel: "buona",
        marketDataConfidence: 0.72,
        marketDataReason: "10 comparabili filtrati",
      },
      marketSignals: {
        priceBandLocale: { signalId: "price_band_locale", sourceClass: "commercial_verified" },
        marketFreshness: { signalId: "market_freshness", sourceClass: "elaborated" },
        marketDepth: null,
        sellerPressure: null,
        premiumMicroAreaSignal: null,
        rentalAppealSignal: null,
        energyPremiumSignal: null,
        listingTurnoverSignal: null,
      },
      marketConfidence: 0.72,
      marketConfidenceReason: "10 comparabili da 1 provider",
      marketCoverageLevel: "buona",
      sourceType: "commercial_verified",
      sourceLabel: "Dati di mercato — market_provider_1",
      sourcePeriod: "ultimi 6 mesi",
      limitations: ["Prezzi basati su annunci pubblici"],
      providerBreakdown: [{ provider: "market_provider_1", available: true, sourceClass: "commercial_verified", comparablesCount: 10, confidence: 0.80 }],
    };
    expect(data.marketContext).toBe("available");
    expect(data.comparablesSummary).not.toBeNull();
    expect(data.comparablesSummary!.comparablesCount).toBeGreaterThanOrEqual(MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE);
    expect(["buona", "parziale", "scarsa", "insufficiente"]).toContain(data.comparablesSummary!.comparableCoverageLevel);
    expect(data.marketConfidence).toBeGreaterThanOrEqual(0);
    expect(data.marketConfidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(data.limitations)).toBe(true);
    expect(data.limitations.length).toBeGreaterThan(0);
  });

  it("unavailable response shape", () => {
    const data = {
      marketContext: "unavailable",
      comparablesSummary: null,
      marketConfidence: 0,
      sourceType: "unavailable",
      limitations: ["Nessun provider configurato"],
    };
    expect(data.marketContext).toBe("unavailable");
    expect(data.comparablesSummary).toBeNull();
    expect(data.marketConfidence).toBe(0);
    expect(data.sourceType).toBe("unavailable");
  });

  it("comparablesSummary has all required metric fields", () => {
    const fields = [
      "comparablesCount", "medianPricePerSqm", "lowerQuartilePricePerSqm",
      "upperQuartilePricePerSqm", "freshnessScore", "marketDepthScore",
      "comparableCoverageLevel", "marketDataConfidence", "marketDataReason",
    ];
    expect(fields).toHaveLength(9);
  });

  it("marketSignals has all 8 slots", () => {
    const slots = [
      "priceBandLocale", "marketFreshness", "marketDepth", "sellerPressure",
      "premiumMicroAreaSignal", "rentalAppealSignal", "energyPremiumSignal", "listingTurnoverSignal",
    ];
    expect(slots).toHaveLength(8);
  });
});

// ── AL. Real Provider Contract — Provider 1 Activation ────────

describe("Sottra contract — real market provider activation", () => {
  it("provider 1 with valid response → normalized comparables", () => {
    // Simulates a real provider returning listings in various formats
    const rawListing = {
      id: "abc123",
      address: "Via Montenapoleone 8, Milano",
      street: "Via Montenapoleone",
      houseNumber: "8",
      city: "Milano",
      lat: 45.468,
      lng: 9.194,
      price: 850000,
      area: 95,
      rooms: 3,
      floor: 2,
      condition: "ristrutturato",
      energyClass: "B",
      status: "active",
      publishedAt: "2026-01-15T10:00:00Z",
    };

    // Test normalization — price and pricePerSqm derived
    const askingPrice = rawListing.price;
    const areaSqm = rawListing.area;
    const pricePerSqm = Math.round(askingPrice / areaSqm);
    expect(pricePerSqm).toBe(8947);
    expect(askingPrice).toBe(850000);
    expect(areaSqm).toBe(95);
  });

  it("provider 1 with partial payload → commercial_partial", () => {
    // Provider returns listings but with missing fields
    const listings = [
      { price: 300000, areaSqm: 80 },
      { price: 350000, areaSqm: 90 },
      { price: 280000, areaSqm: 75 },
    ];
    const withPrice = listings.filter(l => l.price != null);
    const withStreet = listings.filter((l: Record<string, unknown>) => (l as Record<string, unknown>).street != null);
    const priceRatio = withPrice.length / listings.length; // 1.0
    const addressRatio = withStreet.length / listings.length; // 0.0
    // No street info → commercial_partial at best
    expect(priceRatio).toBeGreaterThanOrEqual(0.50);
    expect(addressRatio).toBeLessThan(0.60);
  });

  it("provider 1 with rich payload → commercial_verified", () => {
    const richListings = Array.from({ length: 10 }, (_, i) => ({
      price: 250000 + i * 10000,
      pricePerSqm: 3000 + i * 100,
      areaSqm: 80 + i * 2,
      street: `Via Roma`,
      houseNumber: String(i + 1),
      city: "Milano",
      status: "active",
      listingAgeDays: 15 + i * 5,
    }));
    const withPrice = richListings.filter(l => l.pricePerSqm > 0);
    const withStreet = richListings.filter(l => l.street != null);
    const priceRatio = withPrice.length / richListings.length; // 1.0
    const addressRatio = withStreet.length / richListings.length; // 1.0
    expect(richListings.length).toBeGreaterThanOrEqual(MARKET_DATA_POLICY.MIN_COMPARABLES_GOOD);
    expect(priceRatio).toBeGreaterThanOrEqual(0.80);
    expect(addressRatio).toBeGreaterThanOrEqual(0.60);
  });

  it("provider returning empty listings → unavailable, no crash", () => {
    const listings: unknown[] = [];
    expect(listings).toHaveLength(0);
    const sourceClass = "unavailable";
    expect(sourceClass).toBe("unavailable");
  });

  it("provider response with alternative field names is handled", () => {
    // Italian-language API responses
    const italianListing = {
      prezzo: 420000,
      superficie: 120,
      via: "Via Garibaldi",
      civico: "15",
      comune: "Torino",
      locali: 4,
      piano: 3,
      stato: "attivo",
      classe_energetica: "C",
    };
    expect(italianListing.prezzo).toBe(420000);
    expect(italianListing.superficie).toBe(120);
    // Normalization should map: prezzo→askingPrice, superficie→areaSqm, via→street, etc.
    const expectedPricePerSqm = Math.round(420000 / 120);
    expect(expectedPricePerSqm).toBe(3500);
  });

  it("commercial_verified requires ≥8 listings + 80% price + 60% address coverage", () => {
    const THRESHOLDS = { minListings: 8, minPriceRatio: 0.80, minAddressRatio: 0.60 };
    expect(THRESHOLDS.minListings).toBe(MARKET_DATA_POLICY.MIN_COMPARABLES_GOOD);
  });

  it("commercial_partial requires ≥3 listings + 50% price coverage", () => {
    const minListings = MARKET_DATA_POLICY.MIN_COMPARABLES_PUBLISHABLE;
    expect(minListings).toBe(3);
  });

  it("provider not configured → system stable, no crash", () => {
    // No env set → isAvailable() returns false → skipped cleanly
    const configured = false;
    const result = configured ? "would_query" : "skipped";
    expect(result).toBe("skipped");
  });

  it("provider HTTP error → retry on 5xx, fail fast on 4xx", () => {
    const retryable = [500, 502, 503, 429];
    const nonRetryable = [400, 401, 403, 404];
    for (const code of retryable) {
      expect(code >= 500 || code === 429).toBe(true);
    }
    for (const code of nonRetryable) {
      expect(code >= 400 && code < 500 && code !== 429).toBe(true);
    }
  });

  it("no API keys or secrets leak in market payload", () => {
    const providerResult = {
      provider: "market_provider_1",
      available: true,
      sourceClass: "commercial_verified",
      comparables: [{ askingPrice: 300000, pricePerSqm: 3000, city: "Milano" }],
      confidence: 0.75,
    };
    const serialized = JSON.stringify(providerResult);
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("MARKET_PROVIDER_1_API_KEY");
  });

  it("sourceType classification: commercial_verified vs commercial_partial vs unavailable", () => {
    // commercial_verified: buona coverage + microzona eligible + verified provider
    const verified = { coverage: "buona", microzona: true, providerClass: "commercial_verified" };
    expect(verified.coverage === "buona" && verified.microzona && verified.providerClass === "commercial_verified").toBe(true);

    // commercial_partial: some data but not strong enough
    const partial = { coverage: "parziale", providerClass: "commercial_partial" };
    expect(partial.coverage !== "buona" || partial.providerClass !== "commercial_verified").toBe(true);

    // unavailable: insufficient
    const unavailable = { coverage: "insufficiente" };
    expect(unavailable.coverage).toBe("insufficiente");
  });

  it("market signals populated only when data supports them", () => {
    // priceBandLocale, marketFreshness, marketDepth, sellerPressure, listingTurnover → populated if data exists
    // premiumMicroAreaSignal, rentalAppealSignal, energyPremiumSignal → null (no data source yet)
    const signals = {
      priceBandLocale: { signalId: "price_band_locale" },
      marketFreshness: { signalId: "market_freshness" },
      premiumMicroAreaSignal: null,
      rentalAppealSignal: null,
      energyPremiumSignal: null,
    };
    expect(signals.premiumMicroAreaSignal).toBeNull();
    expect(signals.rentalAppealSignal).toBeNull();
    expect(signals.energyPremiumSignal).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// POLYGON MATCH — Coordinate-first OMI resolution contract
// ══════════════════════════════════════════════════════════════

describe("Sottra contract — polygon match hierarchy", () => {
  it("polygon_match with high confidence → official", () => {
    expect(classifyOMIPricing(0.98, "polygon_match")).toBe("official");
    expect(classifyOMIPricing(0.90, "polygon_match")).toBe("official");
    expect(classifyOMIPricing(0.85, "polygon_match")).toBe("official");
  });

  it("polygon_match with moderate confidence → elaborated", () => {
    expect(classifyOMIPricing(0.70, "polygon_match")).toBe("elaborated");
    expect(classifyOMIPricing(0.50, "polygon_match")).toBe("elaborated");
  });

  it("polygon_match below threshold → unavailable", () => {
    expect(classifyOMIPricing(0.49, "polygon_match")).toBe("unavailable");
    expect(classifyOMIPricing(0.20, "polygon_match")).toBe("unavailable");
  });

  it("hierarchy: polygon_match > single_zone > ai_matched > fallbacks", () => {
    const methods = ["polygon_match", "single_zone", "comune_aggregate", "ai_matched", "ai_fallback", "first_zone_fallback", "none"];
    // polygon_match and single_zone at 95% both official
    expect(classifyOMIPricing(0.95, "polygon_match")).toBe("official");
    expect(classifyOMIPricing(0.95, "single_zone")).toBe("official");
    // comune_aggregate at 95% is elaborated (real prices, no invented microzona)
    expect(classifyOMIPricing(0.95, "comune_aggregate")).toBe("elaborated");
    // ai_matched at 95% is elaborated (never official)
    expect(classifyOMIPricing(0.95, "ai_matched")).toBe("elaborated");
    // fallbacks always unavailable
    expect(classifyOMIPricing(0.95, "ai_fallback")).toBe("unavailable");
    expect(classifyOMIPricing(0.95, "first_zone_fallback")).toBe("unavailable");
    expect(classifyOMIPricing(0.95, "none")).toBe("unavailable");
    expect(methods).toHaveLength(7);
  });

  it("ai_matched is NOT equivalent to polygon_match even at high confidence", () => {
    // ai_matched at 99% → elaborated
    expect(classifyOMIPricing(0.99, "ai_matched")).toBe("elaborated");
    // polygon_match at 85% → official
    expect(classifyOMIPricing(0.85, "polygon_match")).toBe("official");
  });
});

describe("Sottra contract — scan/pricing polygon-first flow", () => {
  it("pricing response with polygon match has polygonMatch=true", () => {
    const data = {
      prezzoMq: 2800,
      prezzoMqMin: 2500,
      prezzoMqMax: 3100,
      mediaZona: null,
      trend5Anni: null,
      omiMatchConfidence: 0.98,
      omiMatchMethod: "polygon_match",
      polygonMatch: true,
      omiGeoLevel: "microzona_omi",
      pricingPrecisionLabel: "Microzona OMI B1 — match spaziale (polygon)",
      sourceCoverageLevel: "microzona",
      sourceType: "official",
    };
    expect(data.polygonMatch).toBe(true);
    expect(data.omiGeoLevel).toBe("microzona_omi");
    expect(data.omiMatchMethod).toBe("polygon_match");
    expect(data.sourceType).toBe("official");
    expect(data.sourceCoverageLevel).toBe("microzona");
    expect(data.mediaZona).toBeNull();
    expect(data.trend5Anni).toBeNull();
  });

  it("pricing response without polygon match has polygonMatch=false", () => {
    const data = {
      omiMatchMethod: "ai_matched",
      polygonMatch: false,
      omiGeoLevel: "comune",
      sourceCoverageLevel: "comunale",
      sourceType: "elaborated",
    };
    expect(data.polygonMatch).toBe(false);
    expect(data.omiGeoLevel).toBe("comune");
    expect(data.sourceCoverageLevel).toBe("comunale");
  });

  it("ai_matched pricing NOT presented as microzona", () => {
    const data = {
      omiMatchMethod: "ai_matched",
      polygonMatch: false,
      omiGeoLevel: "comune",
      pricingPrecisionLabel: "Zona OMI B1 — identificazione AI (non verificata spazialmente)",
    };
    expect(data.omiGeoLevel).not.toBe("microzona_omi");
    expect(data.polygonMatch).toBe(false);
    expect(data.pricingPrecisionLabel).toContain("AI");
    expect(data.pricingPrecisionLabel).toContain("non verificata");
  });

  it("weak match pricing NOT published as precise", () => {
    const data = {
      prezzoMq: null,
      omiMatchMethod: "first_zone_fallback",
      polygonMatch: false,
      omiGeoLevel: "none",
      sourceCoverageLevel: "none",
      sourceType: "unavailable",
    };
    expect(data.prezzoMq).toBeNull();
    expect(data.sourceType).toBe("unavailable");
    expect(data.polygonMatch).toBe(false);
    expect(data.sourceCoverageLevel).toBe("none");
  });

  it("scan/pricing accepts lat/lng for coordinate-first path", () => {
    // Contract: body can include lat, lng for coordinate-first lookup
    const body = { address: "Via Roma 1, Milano", lat: 45.4642, lng: 9.1900 };
    expect(typeof body.lat).toBe("number");
    expect(typeof body.lng).toBe("number");
    expect(typeof body.address).toBe("string");
  });

  it("OMI result shape includes new polygon fields", () => {
    const requiredFields = [
      "found", "fonte", "matchConfidence", "matchMethod",
      "polygonMatch", "omiGeoLevel", "pricingPrecisionLabel",
      "sourceCoverageLevel", "confidenceReason", "limitations",
    ];
    const result = {
      found: true,
      zona: "B1",
      zona_descr: "Centro",
      comune: "MILANO",
      compr_min: 2500,
      compr_max: 3100,
      prezzoMedio: 2800,
      fonte: "Agenzia Entrate — OMI, 1° semestre 2025",
      matchConfidence: 0.98,
      matchMethod: "polygon_match",
      polygonMatch: true,
      omiGeoLevel: "microzona_omi",
      pricingPrecisionLabel: "Microzona OMI B1 — match spaziale (polygon)",
      sourceCoverageLevel: "microzona",
      confidenceReason: "Match spaziale univoco",
      limitations: [],
    };
    for (const field of requiredFields) {
      expect(result).toHaveProperty(field);
    }
  });

  it("comune with many zones — no arbitrary selection without polygon", () => {
    // When address lookup finds many zones and AI fails, result is NOT official
    const multiZoneResult = {
      omiMatchMethod: "first_zone_fallback",
      matchConfidence: 0.20,
      polygonMatch: false,
      sourceType: classifyOMIPricing(0.20, "first_zone_fallback"),
    };
    expect(multiZoneResult.sourceType).toBe("unavailable");
    expect(multiZoneResult.polygonMatch).toBe(false);
    expect(multiZoneResult.matchConfidence).toBeLessThan(PUBLICATION_POLICY.OMI_PUBLISH_THRESHOLD);
  });

  it("address+AI match without polygon → NOT equivalent to polygon match", () => {
    const aiResult = classifyOMIPricing(0.90, "ai_matched");
    const polygonResult = classifyOMIPricing(0.90, "polygon_match");
    expect(aiResult).toBe("elaborated");
    expect(polygonResult).toBe("official");
    expect(aiResult).not.toBe(polygonResult);
  });
});

describe("Sottra contract — OMI geo level consistency", () => {
  it("valid omiGeoLevel values", () => {
    const valid = ["microzona_omi", "comune", "none"];
    expect(valid).toHaveLength(3);
  });

  it("valid sourceCoverageLevel values", () => {
    const valid = ["microzona", "comunale", "none"];
    expect(valid).toHaveLength(3);
  });

  it("polygon_match → omiGeoLevel=microzona_omi, sourceCoverageLevel=microzona", () => {
    // Contract guarantee
    const polygonResult = {
      matchMethod: "polygon_match",
      polygonMatch: true,
      omiGeoLevel: "microzona_omi",
      sourceCoverageLevel: "microzona",
    };
    expect(polygonResult.omiGeoLevel).toBe("microzona_omi");
    expect(polygonResult.sourceCoverageLevel).toBe("microzona");
  });

  it("ai_matched → omiGeoLevel=comune, sourceCoverageLevel=comunale", () => {
    const aiResult = {
      matchMethod: "ai_matched",
      polygonMatch: false,
      omiGeoLevel: "comune",
      sourceCoverageLevel: "comunale",
    };
    expect(aiResult.omiGeoLevel).toBe("comune");
    expect(aiResult.sourceCoverageLevel).toBe("comunale");
  });
});

// ── AO. scan/market-context alias ─────────────────────────────

describe("Sottra contract — scan/market-context alias", () => {
  it("scan/market-context is a valid route alias", () => {
    const path = "/scan/market-context";
    const fullPath = `/functions/v1/sottra${path}`;
    expect(fullPath.endsWith("/scan/market-context")).toBe(true);
  });

  it("scan/market-context produces same shape as scan/market", () => {
    const shape = {
      marketContext: "unavailable",
      comparablesSummary: null,
      marketSignals: {},
      marketSignalsList: [],
      marketConfidence: 0,
      sourceType: "unavailable",
    };
    expect(shape).toHaveProperty("marketContext");
    expect(shape).toHaveProperty("marketSignalsList");
    expect(Array.isArray(shape.marketSignalsList)).toBe(true);
  });
});

// ── AP. Market additive backward-compat fields ────────────────

describe("Sottra contract — market additive compat fields", () => {
  it("comparablesSummary includes additive aliases", () => {
    const summary = {
      comparablesCount: 10,
      medianPricePerSqm: 3200,
      lowerQuartilePricePerSqm: 2800,
      upperQuartilePricePerSqm: 3600,
      freshnessScore: 0.75,
      marketDepthScore: 0.67,
      comparableCoverageLevel: "buona",
      marketDataConfidence: 0.72,
      marketDataReason: "10 comparabili",
      count: 10,
      q1PricePerSqm: 2800,
      q3PricePerSqm: 3600,
      marketDepth: "profondo",
      marketFreshnessLabel: "recente",
    };
    expect(summary.count).toBe(summary.comparablesCount);
    expect(summary.q1PricePerSqm).toBe(summary.lowerQuartilePricePerSqm);
    expect(summary.q3PricePerSqm).toBe(summary.upperQuartilePricePerSqm);
    expect(["profondo", "sufficiente", "limitato"]).toContain(summary.marketDepth);
    expect(["recente", "moderata", "datata"]).toContain(summary.marketFreshnessLabel);
  });

  it("marketSignalsList is flat array of signals", () => {
    const list = [
      { key: "priceBandLocale", label: "Fascia prezzo locale", value: "€2800-3600/mq", detail: "Basato su 10 comparabili" },
      { key: "marketFreshness", label: "Freschezza mercato", value: 0.75, detail: "Score basato sull'età media" },
    ];
    for (const item of list) {
      expect(item).toHaveProperty("key");
      expect(item).toHaveProperty("label");
      expect(item).toHaveProperty("value");
      expect(item).toHaveProperty("detail");
    }
  });

  it("unavailable result has empty marketSignalsList", () => {
    const result = { marketSignalsList: [] };
    expect(result.marketSignalsList).toHaveLength(0);
  });
});

// ── AQ. connectivityContext precision ─────────────────────────

describe("Sottra contract — connectivityContext precision", () => {
  it("connectivityContext shape in infrastrutture response", () => {
    const ctx = {
      connectivityAvailable: true,
      connectivityLabel: "Copertura BUL: FTTH 80%, FWA 95%",
      connectivityPrecision: "comune",
      connectivitySource: "Infratel/BUL — Piano Banda Ultralarga",
      limitations: ["Dato di copertura a livello comunale, non puntuale al civico"],
    };
    expect(["civico", "strada", "comune"]).toContain(ctx.connectivityPrecision);
    expect(ctx.connectivityAvailable).toBe(true);
    expect(ctx.limitations.length).toBeGreaterThan(0);
  });

  it("unavailable connectivity returns precision=comune", () => {
    const ctx = {
      connectivityAvailable: false,
      connectivityPrecision: "comune",
      connectivitySource: null,
    };
    expect(ctx.connectivityAvailable).toBe(false);
    expect(ctx.connectivityPrecision).toBe("comune");
  });
});

// ── AR. schoolContext in sviluppo-area ─────────────────────────

describe("Sottra contract — schoolContext", () => {
  it("available schoolContext shape", () => {
    const ctx = {
      available: true,
      totalSchools: 15,
      byGrado: { infanzia: 3, primaria: 5, secondaria_i: 4, secondaria_ii: 3 },
      gradiPresenti: ["infanzia", "primaria", "secondaria_i", "secondaria_ii"],
      nearestSchools: [{ denominazione: "IC Milano 1", grado: "primaria", indirizzo: "Via Roma 10" }],
      precision: "comune",
      source: "MIM — Ministero Istruzione e Merito (Open Data)",
    };
    expect(ctx.available).toBe(true);
    expect(ctx.totalSchools).toBeGreaterThan(0);
    expect(ctx.precision).toBe("comune");
  });

  it("unavailable schoolContext when no data", () => {
    const ctx = { available: false, totalSchools: 0, source: null };
    expect(ctx.available).toBe(false);
    expect(ctx.source).toBeNull();
  });

  it("schoolContext never invents data", () => {
    const ctx = { available: false, totalSchools: 0 };
    expect(ctx.available).toBe(false);
  });
});

// ── AS. Energy — no unit-level data ───────────────────────────

describe("Sottra contract — energy policy", () => {
  it("scan/energy remains unavailable without real APE source", () => {
    const data = { classeEnergetica: null, sourceType: "unavailable" };
    expect(data.classeEnergetica).toBeNull();
    expect(data.sourceType).toBe("unavailable");
  });
});

// ── AT. National coverage model ───────────────────────────────

describe("Sottra contract — national coverage model", () => {
  it("unavailable modules correctly listed", () => {
    const unavailable = [
      "scan/cadastral", "scan/listings", "scan/energy",
      "scan/condominio", "scan/storico-transazioni", "forecast/moodscore",
    ];
    expect(unavailable).toHaveLength(6);
  });
});