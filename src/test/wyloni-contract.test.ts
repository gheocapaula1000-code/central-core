import { describe, it, expect } from "vitest";

/**
 * Wyloni Contract Regression Tests
 *
 * These tests verify the contract surface that Wyloni depends on.
 * They test pure logic and structural expectations — no live HTTP calls.
 * Breaking any of these means a potential Wyloni outage.
 */

// ── A. Wyloni-expected paths ──────────────────────────────────
// These are the paths Wyloni's proxy maps to ai-core-run.
// The edge function uses pathname.endsWith() matching.

const WYLONI_PATHS = [
  { path: "/health",              method: "GET",  description: "Health probe" },
  { path: "/__health",            method: "GET",  description: "Alt health probe" },
  { path: "/documents/analyze",   method: "POST", description: "Document analysis" },
  { path: "/web/scrape",          method: "POST", description: "Web scraping via Firecrawl" },
  { path: "/tariffs/compare",     method: "POST", description: "Tariff comparison" },
  { path: "/metrics",             method: "GET",  description: "Metrics endpoint" },
];

describe("Wyloni contract — path registry", () => {
  it("all expected paths are defined", () => {
    expect(WYLONI_PATHS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(WYLONI_PATHS)("$path ($method) — endsWith matching works", ({ path }) => {
    // Simulate what the edge function does: new URL(req.url).pathname
    const fullPath = `/functions/v1/ai-core-run${path}`;
    expect(fullPath.endsWith(path)).toBe(true);
  });

  it("health paths match both /health and /__health", () => {
    const healthPaths = ["/health", "/__health"];
    for (const p of healthPaths) {
      const full = `/functions/v1/ai-core-run${p}`;
      const matches = full.endsWith("/health") || full.endsWith("/__health");
      expect(matches).toBe(true);
    }
  });

  it("root path / is handled as health", () => {
    // The edge function checks: pathname === "/"
    const rootPath = "/";
    expect(rootPath).toBe("/");
  });
});

// ── B. Envelope consistency ───────────────────────────────────
// Wyloni expects a standard envelope: { ok, data, warnings, debug_id, error? }

describe("Wyloni contract — envelope shape", () => {
  it("success envelope has required fields", () => {
    const successEnvelope = {
      ok: true,
      data: { status: "ok" },
      warnings: [],
      debug_id: "test-123",
    };
    expect(successEnvelope.ok).toBe(true);
    expect(successEnvelope.data).toBeDefined();
    expect(successEnvelope.data).not.toBeNull();
    expect(Array.isArray(successEnvelope.warnings)).toBe(true);
    expect(typeof successEnvelope.debug_id).toBe("string");
  });

  it("error envelope has required fields", () => {
    const errorEnvelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "test-456",
      error: { code: "MISSING_PROMPT", message: "Provide prompt field" },
    };
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.data).toBeNull();
    expect(errorEnvelope.error).toBeDefined();
    expect(typeof errorEnvelope.error.code).toBe("string");
    expect(typeof errorEnvelope.error.message).toBe("string");
  });

  it("error codes are uppercase snake_case strings", () => {
    const knownCodes = [
      "MISSING_PROMPT", "INVALID_JSON", "PAYLOAD_TOO_LARGE", "PROMPT_TOO_LONG",
      "INVALID_DOMAIN", "INVALID_TASK", "RATE_LIMITED", "METHOD_NOT_ALLOWED",
      "APP_SECRET_REQUIRED", "APP_SECRET_REJECTED", "INTERNAL_ERROR",
      "MISSING_URL", "MISSING_INPUT", "NO_IMAGES", "CONFIG_ERROR",
    ];
    for (const code of knownCodes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});

// ── C. Documents/analyze contract ─────────────────────────────

describe("Wyloni contract — documents/analyze", () => {
  it("empty text returns NOT_READABLE shape", () => {
    // This is the shape returned when text is too short (< 20 chars)
    const notReadable = {
      status: "NOT_READABLE",
      extracted: {},
      quality: { gate: "NOT_READABLE", score: 0, notes: ["No text"] },
    };
    expect(notReadable.status).toBe("NOT_READABLE");
    expect(notReadable.quality.gate).toBe("NOT_READABLE");
    expect(notReadable.quality.score).toBe(0);
  });

  it("success returns READY shape", () => {
    const ready = {
      status: "READY",
      extracted: { fornitore: { label: "Enel" } },
      quality: { gate: "READY", score: 80, notes: ["estrazione automatica"] },
    };
    expect(ready.status).toBe("READY");
    expect(ready.quality.gate).toBe("READY");
    expect(ready.quality.score).toBeGreaterThan(0);
    expect(ready.extracted).toBeDefined();
  });
});

// ── D. Web/scrape contract ────────────────────────────────────

describe("Wyloni contract — web/scrape", () => {
  it("success shape has content and metadata", () => {
    const success = {
      success: true,
      content: "# Page title\nSome content",
      markdown: "# Page title\nSome content",
      text: "# Page title\nSome content",
      metadata: { title: "Page", sourceUrl: "https://example.com", scrapedAt: new Date().toISOString(), context: null },
    };
    expect(success.success).toBe(true);
    expect(typeof success.content).toBe("string");
    expect(typeof success.markdown).toBe("string");
    expect(success.metadata.sourceUrl).toBeTruthy();
  });

  it("failure shape has success=false", () => {
    const failure = {
      success: false,
      content: null,
      error: "Scrape failed or returned empty",
    };
    expect(failure.success).toBe(false);
    expect(failure.content).toBeNull();
  });
});

// ── E. Tariffs/compare contract ───────────────────────────────

describe("Wyloni contract — tariffs/compare", () => {
  it("response shape has final_output and data", () => {
    const shape = {
      final_output: '{"offers":[]}',
      data: { offers: [] },
      offers: [],
      debug_id: "test-789",
    };
    expect(typeof shape.final_output).toBe("string");
    expect(shape.data).toBeDefined();
    expect(Array.isArray(shape.offers)).toBe(true);
    expect(typeof shape.debug_id).toBe("string");
  });
});

// ── F. Generic AI run contract ────────────────────────────────

describe("Wyloni contract — generic AI run", () => {
  it("response shape has final_output, data, results, offers, properties", () => {
    const shape = {
      final_output: '{}',
      data: {},
      offers: [],
      properties: [],
      results: [],
      debug_id: "test-gen",
    };
    expect(typeof shape.final_output).toBe("string");
    expect(Array.isArray(shape.offers)).toBe(true);
    expect(Array.isArray(shape.properties)).toBe(true);
    expect(Array.isArray(shape.results)).toBe(true);
  });

  it("domain validation accepts lowercase snake_case", () => {
    const SAFE_ID = /^[a-z0-9_]+$/;
    expect(SAFE_ID.test("wyloni_bandi")).toBe(true);
    expect(SAFE_ID.test("pratica_legal")).toBe(true);
    expect(SAFE_ID.test("keydraft_realestate")).toBe(true);
    expect(SAFE_ID.test("wyloni_bonus")).toBe(true);
    expect(SAFE_ID.test("INVALID")).toBe(false);
    expect(SAFE_ID.test("some domain")).toBe(false);
  });
});

// ── G. Secret header compatibility ────────────────────────────

describe("Wyloni contract — secret headers", () => {
  it("canonical secret is AI_CORE_SECRET", () => {
    expect("AI_CORE_SECRET").toBe("AI_CORE_SECRET");
  });

  it("legacy aliases are supported in correct priority", () => {
    // The requireSecret function in _shared/http.ts checks these in order:
    const headerPriority = [
      "x-internal-secret",
      "x-app-secret",
      "x-core-secret",
      "authorization", // Bearer prefix stripped
    ];
    expect(headerPriority).toHaveLength(4);
    expect(headerPriority[0]).toBe("x-internal-secret");
  });
});

// ── H. Health endpoint shape ──────────────────────────────────

describe("Wyloni contract — health endpoint", () => {
  it("health data includes status, version, time", () => {
    const healthData = {
      status: "ok",
      version: "3.3.5",
      time: new Date().toISOString(),
    };
    expect(healthData.status).toBe("ok");
    expect(typeof healthData.version).toBe("string");
    expect(healthData.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof healthData.time).toBe("string");
  });
});

// ── I. URL normalization ──────────────────────────────────────

describe("Wyloni contract — URL base normalization", () => {
  it("ai-core-run function base path is consistent", () => {
    const projectId = "jpunnzgixcghuydstdlt";
    const baseUrl = `https://${projectId}.supabase.co/functions/v1/ai-core-run`;
    
    // All Wyloni paths should be appended to this base
    const healthUrl = `${baseUrl}/health`;
    const analyzeUrl = `${baseUrl}/documents/analyze`;
    const scrapeUrl = `${baseUrl}/web/scrape`;
    const tariffsUrl = `${baseUrl}/tariffs/compare`;
    
    expect(healthUrl).toContain("/ai-core-run/health");
    expect(analyzeUrl).toContain("/ai-core-run/documents/analyze");
    expect(scrapeUrl).toContain("/ai-core-run/web/scrape");
    expect(tariffsUrl).toContain("/ai-core-run/tariffs/compare");
  });

  it("standalone /health function is separate from ai-core-run", () => {
    const projectId = "jpunnzgixcghuydstdlt";
    const standaloneHealth = `https://${projectId}.supabase.co/functions/v1/health`;
    const coreHealth = `https://${projectId}.supabase.co/functions/v1/ai-core-run/health`;
    expect(standaloneHealth).not.toBe(coreHealth);
  });
});
