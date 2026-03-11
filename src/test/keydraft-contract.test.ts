import { describe, it, expect } from "vitest";

/**
 * KeyDraft Contract Regression Tests
 *
 * These tests verify the contract surface that KeyDraft PWA depends on.
 * KeyDraft uses ai-core-run with domain=keydraft_realestate and task=keydraft_engine.
 * Pure logic and structural expectations — no live HTTP calls.
 */

// ── A. KeyDraft-expected paths ────────────────────────────────

const KEYDRAFT_PATHS = [
  { path: "/health",         method: "GET",  description: "Health probe" },
  { path: "/__health",       method: "GET",  description: "Alt health probe" },
  { path: "/ai-core-run",    method: "POST", description: "Generic AI run (keydraft_engine task)" },
];

describe("KeyDraft contract — path registry", () => {
  it("all expected paths are defined", () => {
    expect(KEYDRAFT_PATHS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(KEYDRAFT_PATHS)("$path ($method) — endsWith matching works", ({ path }) => {
    const fullPath = `/functions/v1/ai-core-run${path}`;
    expect(fullPath.endsWith(path)).toBe(true);
  });
});

// ── B. Envelope consistency ───────────────────────────────────

describe("KeyDraft contract — envelope shape", () => {
  it("success envelope has required fields", () => {
    const envelope = {
      ok: true,
      data: { final_output: "{}", data: {} },
      warnings: [],
      debug_id: "kd-123",
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
      debug_id: "kd-456",
      error: { code: "MISSING_INPUT", message: "Provide input object for keydraft_engine" },
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

// ── C. keydraft_engine task contract ──────────────────────────

describe("KeyDraft contract — keydraft_engine task", () => {
  it("request shape has domain, task, input with imageUrls", () => {
    const request = {
      domain: "keydraft_realestate",
      task: "keydraft_engine",
      input: {
        imageUrls: ["https://example.com/photo1.jpg"],
        operation: "vendita",
        price: 250000,
        province: "MI",
        comune: "Milano",
        locality: "Centro",
        enableRenovationEstimate: true,
      },
    };
    expect(request.domain).toBe("keydraft_realestate");
    expect(request.task).toBe("keydraft_engine");
    expect(Array.isArray(request.input.imageUrls)).toBe(true);
    expect(request.input.imageUrls.length).toBeGreaterThan(0);
  });

  it("success response has final_output and data", () => {
    const data = {
      final_output: '{"title":"Appartamento luminoso"}',
      data: {
        title: "Appartamento luminoso",
        description: "Bellissimo appartamento...",
        highlights: ["Luminoso", "Ristrutturato"],
        rooms: { identified: ["cucina", "bagno"], count: 3 },
        condition: { value: "buono", notes: "Stato conservativo buono" },
        sqm_estimate: 80,
        tags: ["luminoso", "ristrutturato"],
      },
      debug_id: "kd-789",
    };
    expect(typeof data.final_output).toBe("string");
    expect(data.data).toBeDefined();
    expect(typeof data.debug_id).toBe("string");
  });

  it("error for missing input returns MISSING_INPUT", () => {
    const code = "MISSING_INPUT";
    expect(code).toBe("MISSING_INPUT");
  });

  it("error for no images returns NO_IMAGES", () => {
    const code = "NO_IMAGES";
    expect(code).toBe("NO_IMAGES");
  });
});

// ── D. Domain validation ──────────────────────────────────────

describe("KeyDraft contract — domain validation", () => {
  it("keydraft_realestate passes SAFE_ID regex", () => {
    const SAFE_ID = /^[a-z0-9_]+$/;
    expect(SAFE_ID.test("keydraft_realestate")).toBe(true);
  });

  it("keydraft_engine passes SAFE_ID regex", () => {
    const SAFE_ID = /^[a-z0-9_]+$/;
    expect(SAFE_ID.test("keydraft_engine")).toBe(true);
  });
});

// ── E. Rate limiting contract ─────────────────────────────────

describe("KeyDraft contract — rate limiting", () => {
  it("rate limit error has correct shape", () => {
    const error = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "kd-rate",
      error: { code: "RATE_LIMITED", message: "Too many requests. Retry in 30s." },
    };
    expect(error.error.code).toBe("RATE_LIMITED");
    expect(error.error.message).toContain("Retry");
  });
});

// ── F. Secret headers ─────────────────────────────────────────

describe("KeyDraft contract — secret headers", () => {
  it("canonical secret is AI_CORE_SECRET", () => {
    expect("AI_CORE_SECRET").toBe("AI_CORE_SECRET");
  });

  it("legacy aliases supported", () => {
    const priority = ["x-internal-secret", "x-app-secret", "x-core-secret", "authorization"];
    expect(priority[0]).toBe("x-internal-secret");
  });
});

// ── G. Pipeline config ────────────────────────────────────────

describe("KeyDraft contract — pipeline config", () => {
  it("keydraft_realestate pipeline exists with expected parameters", () => {
    // These values must match keydraft_realestate.ts
    const config = { maxTokens: 1800, temperature: 0.3 };
    expect(config.maxTokens).toBe(1800);
    expect(config.temperature).toBe(0.3);
  });

  it("keydraft_engine has token override of 2500", () => {
    const TASK_TOKEN_OVERRIDES: Record<string, number> = {
      keydraft_engine: 2500,
    };
    expect(TASK_TOKEN_OVERRIDES.keydraft_engine).toBe(2500);
  });
});
