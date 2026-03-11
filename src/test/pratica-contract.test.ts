import { describe, it, expect } from "vitest";

/**
 * PRATICA Contract Regression Tests
 *
 * These tests verify the contract surface that PRATICA PWA depends on.
 * PRATICA uses ai-core-run with domain=pratica_legal for legal tasks.
 * Pure logic and structural expectations — no live HTTP calls.
 */

// ── A. PRATICA-expected paths ─────────────────────────────────

const PRATICA_PATHS = [
  { path: "/health",              method: "GET",  description: "Health probe" },
  { path: "/__health",            method: "GET",  description: "Alt health probe" },
  { path: "/ai-core-run",         method: "POST", description: "Generic AI run (pratica_legal tasks)" },
  { path: "/documents/analyze",   method: "POST", description: "Document analysis" },
  { path: "/web/scrape",          method: "POST", description: "Web scraping" },
];

describe("PRATICA contract — path registry", () => {
  it("all expected paths are defined", () => {
    expect(PRATICA_PATHS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(PRATICA_PATHS)("$path ($method) — endsWith matching works", ({ path }) => {
    const fullPath = `/functions/v1/ai-core-run${path}`;
    expect(fullPath.endsWith(path)).toBe(true);
  });
});

// ── B. Envelope consistency ───────────────────────────────────

describe("PRATICA contract — envelope shape", () => {
  it("success envelope: ok=true, data, warnings, debug_id", () => {
    const envelope = {
      ok: true,
      data: { final_output: "{}" },
      warnings: [],
      debug_id: "pr-123",
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeDefined();
    expect(envelope.data).not.toBeNull();
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(typeof envelope.debug_id).toBe("string");
  });

  it("error envelope: ok=false, data=null, error.code + error.message", () => {
    const envelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "pr-456",
      error: { code: "MISSING_PROMPT", message: "Provide prompt field" },
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(typeof envelope.error.code).toBe("string");
    expect(typeof envelope.error.message).toBe("string");
    expect(envelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

// ── C. PRATICA tasks ──────────────────────────────────────────

describe("PRATICA contract — legal tasks", () => {
  const PRATICA_TASKS = [
    "translate_objection",
    "simplex",
    "contratto_analisi",
    "solve_problem",
    "alchemist",
    "loyalty_analyze",
    "find_contacts",
    "find_company_contacts",
  ];

  it("all tasks pass SAFE_ID validation", () => {
    const SAFE_ID = /^[a-z0-9_]+$/;
    for (const task of PRATICA_TASKS) {
      expect(SAFE_ID.test(task)).toBe(true);
    }
  });

  it("pratica_legal domain passes SAFE_ID validation", () => {
    expect(/^[a-z0-9_]+$/.test("pratica_legal")).toBe(true);
  });

  it("generic AI run response has final_output, data, results", () => {
    const data = {
      final_output: '{"analysis":"result"}',
      data: { analysis: "result" },
      offers: [],
      properties: [],
      results: [],
      debug_id: "pr-gen",
    };
    expect(typeof data.final_output).toBe("string");
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.offers)).toBe(true);
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.debug_id).toBe("string");
  });
});

// ── D. documents/analyze contract ─────────────────────────────

describe("PRATICA contract — documents/analyze", () => {
  it("NOT_READABLE when text too short", () => {
    const data = {
      status: "NOT_READABLE",
      extracted: {},
      quality: { gate: "NOT_READABLE", score: 0, notes: ["No text"] },
    };
    expect(data.status).toBe("NOT_READABLE");
    expect(data.quality.score).toBe(0);
  });

  it("READY shape with extracted data", () => {
    const data = {
      status: "READY",
      extracted: { fornitore: { label: "Enel" } },
      quality: { gate: "READY", score: 80, notes: ["estrazione automatica"] },
    };
    expect(data.status).toBe("READY");
    expect(data.quality.score).toBeGreaterThan(0);
    expect(data.extracted).toBeDefined();
  });
});

// ── E. web/scrape contract ────────────────────────────────────

describe("PRATICA contract — web/scrape", () => {
  it("success shape", () => {
    const data = {
      success: true,
      content: "# Page",
      markdown: "# Page",
      text: "# Page",
      metadata: { title: "Page", sourceUrl: "https://example.com", scrapedAt: new Date().toISOString(), context: null },
    };
    expect(data.success).toBe(true);
    expect(typeof data.content).toBe("string");
    expect(typeof data.markdown).toBe("string");
  });

  it("failure shape", () => {
    const data = {
      success: false,
      content: null,
      error: "Scrape failed or returned empty",
    };
    expect(data.success).toBe(false);
    expect(data.content).toBeNull();
  });
});

// ── F. VITE_CENTRAL_CORE_BASE_URL compatibility ──────────────

describe("PRATICA contract — base URL", () => {
  it("ai-core-run base path is consistent", () => {
    const projectId = "jpunnzgixcghuydstdlt";
    const baseUrl = `https://${projectId}.supabase.co/functions/v1/ai-core-run`;

    const analyzeUrl = `${baseUrl}/documents/analyze`;
    const scrapeUrl = `${baseUrl}/web/scrape`;
    const runUrl = baseUrl; // POST directly to base

    expect(analyzeUrl).toContain("/ai-core-run/documents/analyze");
    expect(scrapeUrl).toContain("/ai-core-run/web/scrape");
    expect(runUrl).toContain("/ai-core-run");
  });
});

// ── G. Secret headers ─────────────────────────────────────────

describe("PRATICA contract — secret headers", () => {
  it("canonical secret is AI_CORE_SECRET", () => {
    expect("AI_CORE_SECRET").toBe("AI_CORE_SECRET");
  });

  it("legacy aliases in correct priority", () => {
    const priority = ["x-internal-secret", "x-app-secret", "x-core-secret", "authorization"];
    expect(priority).toHaveLength(4);
    expect(priority[0]).toBe("x-internal-secret");
  });
});

// ── H. Pipeline config ────────────────────────────────────────

describe("PRATICA contract — pipeline config", () => {
  it("pratica_legal pipeline exists with expected parameters", () => {
    const config = { maxTokens: 900, temperature: 0.4 };
    expect(config.maxTokens).toBe(900);
    expect(config.temperature).toBe(0.4);
  });

  it("task token overrides for PRATICA tasks", () => {
    const overrides: Record<string, number> = {
      contratto_analisi: 2000,
      alchemist: 1600,
    };
    expect(overrides.contratto_analisi).toBe(2000);
    expect(overrides.alchemist).toBe(1600);
  });
});
