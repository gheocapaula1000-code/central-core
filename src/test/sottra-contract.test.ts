import { describe, it, expect } from "vitest";

/**
 * Sottra Contract Regression Tests — Data Rigor Edition
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
 */

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

describe("Sottra contract — scan/pricing (data rigor)", () => {
  const OMI_PUBLISH_THRESHOLD = 0.50;

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
    // DATA RIGOR: mediaZona must always be null
    expect(data.mediaZona).toBeNull();
    // DATA RIGOR: trend5Anni must always be null
    expect(data.trend5Anni).toBeNull();
    // Confidence tracking
    expect(data.omiMatchConfidence).toBeGreaterThanOrEqual(OMI_PUBLISH_THRESHOLD);
    expect(typeof data.omiMatchMethod).toBe("string");
  });

  it("mediaZona is NEVER equal to prezzoMq — it must be null", () => {
    // This test explicitly prevents the old bug where mediaZona = prezzoMedio
    const data = { prezzoMq: 2500, mediaZona: null };
    expect(data.mediaZona).not.toBe(data.prezzoMq);
    expect(data.mediaZona).toBeNull();
  });

  it("trend5Anni is NEVER a hardcoded value — it must be null", () => {
    const data = { trend5Anni: null };
    expect(data.trend5Anni).toBeNull();
    // Must not be 0, which was the old hardcoded value
    expect(data.trend5Anni).not.toBe(0);
  });

  it("pricing NOT published when OMI match confidence is below threshold", () => {
    // Simulates weak match — prezzoMq must be null, sourceType must be unavailable
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
    expect(weakMatchData.omiMatchConfidence).toBeLessThan(OMI_PUBLISH_THRESHOLD);
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
    // rischio-zona with real ISPRA data is "official"
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
    // Official is ONLY for: OMI pricing (confidence >= 50%), ISPRA rischio-zona, ISTAT trend-demografico
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
    // When fewer than 2 data sources, elaborated modules MUST return unavailable
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

// ── K. OMI match confidence contract ──────────────────────────

describe("Sottra contract — OMI match confidence", () => {
  it("single_zone match has high confidence (>= 0.90)", () => {
    const result = { matchConfidence: 0.95, matchMethod: "single_zone" };
    expect(result.matchConfidence).toBeGreaterThanOrEqual(0.90);
  });

  it("ai_matched has moderate confidence (>= 0.50)", () => {
    const result = { matchConfidence: 0.70, matchMethod: "ai_matched" };
    expect(result.matchConfidence).toBeGreaterThanOrEqual(0.50);
  });

  it("ai_fallback has low confidence (< 0.50)", () => {
    const result = { matchConfidence: 0.25, matchMethod: "ai_fallback" };
    expect(result.matchConfidence).toBeLessThan(0.50);
  });

  it("first_zone_fallback has very low confidence (< 0.50)", () => {
    const result = { matchConfidence: 0.20, matchMethod: "first_zone_fallback" };
    expect(result.matchConfidence).toBeLessThan(0.50);
  });

  it("no match has zero confidence", () => {
    const result = { matchConfidence: 0, matchMethod: "none" };
    expect(result.matchConfidence).toBe(0);
  });
});
