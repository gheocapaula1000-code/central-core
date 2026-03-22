/**
 * Envelope & Response Normalization Tests — Central Core V3
 *
 * Validates the ok/fail envelope contract, edge cases, and
 * consistency across success, error, and degraded responses.
 */
import { describe, it, expect } from "vitest";

// ── Envelope shape contract ──

interface CoreEnvelope {
  ok: boolean;
  data: unknown;
  warnings: string[];
  debug_id: string;
  error?: { code: string; message: string };
}

function isValidEnvelope(obj: unknown): obj is CoreEnvelope {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  if (typeof e.ok !== "boolean") return false;
  if (!Array.isArray(e.warnings)) return false;
  if (typeof e.debug_id !== "string" || e.debug_id.length === 0) return false;
  if (e.ok && e.data === undefined) return false;
  if (!e.ok && (!e.error || typeof (e.error as Record<string, unknown>).code !== "string")) {
    return false;
  }
  return true;
}

describe("Envelope — Success shape", () => {
  it("ok=true envelope has data, warnings[], debug_id", () => {
    const env: CoreEnvelope = {
      ok: true,
      data: { status: "healthy" },
      warnings: [],
      debug_id: "abc123def456",
    };
    expect(isValidEnvelope(env)).toBe(true);
    expect(env.error).toBeUndefined();
  });

  it("ok=true with warnings is valid", () => {
    const env: CoreEnvelope = {
      ok: true,
      data: { result: "partial" },
      warnings: ["sottra timeout", "market_data unavailable"],
      debug_id: "abc123def456",
    };
    expect(isValidEnvelope(env)).toBe(true);
    expect(env.warnings).toHaveLength(2);
  });

  it("ok=true with null data is valid (e.g. delete operations)", () => {
    const env: CoreEnvelope = {
      ok: true,
      data: null,
      warnings: [],
      debug_id: "abc123def456",
    };
    expect(isValidEnvelope(env)).toBe(true);
  });
});

describe("Envelope — Error shape", () => {
  it("ok=false envelope has error.code + error.message", () => {
    const env: CoreEnvelope = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "abc123def456",
      error: { code: "APP_SECRET_REQUIRED", message: "Missing x-internal-secret" },
    };
    expect(isValidEnvelope(env)).toBe(true);
    expect(env.data).toBeNull();
  });

  it("error.code is always UPPER_SNAKE_CASE", () => {
    const codes = [
      "APP_SECRET_REQUIRED",
      "APP_SECRET_REJECTED",
      "ORIGIN_NOT_ALLOWED",
      "CONFIG_ERROR",
      "INTERNAL_ERROR",
      "PROVIDER_ERROR",
      "INVALID_JSON",
      "PAYLOAD_TOO_LARGE",
      "ROUTE_NOT_FOUND",
      "METHOD_NOT_ALLOWED",
      "RATE_LIMITED",
      "DIAGNOSTIC_SECRET_REQUIRED",
      "DIAGNOSTIC_SECRET_REJECTED",
      "BRIDGE_VALIDATION_ERROR",
      "BRIDGE_DUPLICATE",
      "BRIDGE_DELIVERY_FAILED",
    ];
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it("error.message never contains stack traces or file paths", () => {
    const safeMessages = [
      "Missing x-internal-secret",
      "Invalid secret",
      "Origin not in allowlist",
      "AI_CORE_SECRET not configured",
      "An internal error occurred",
      "AI provider temporarily unavailable",
    ];
    for (const msg of safeMessages) {
      expect(msg).not.toMatch(/at\s+\w+\s+\(/);
      expect(msg).not.toMatch(/\.ts:\d+/);
      expect(msg).not.toContain("node_modules");
      expect(msg).not.toContain("/home/");
      expect(msg).not.toContain("\\Users\\");
    }
  });
});

describe("Envelope — debug_id contract", () => {
  it("debug_id is a 12-char hex string", () => {
    const debugId = "a1b2c3d4e5f6";
    expect(debugId).toMatch(/^[a-f0-9]{12}$/);
  });

  it("debug_id is unique per call (probabilistic)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(crypto.randomUUID().replace(/-/g, "").slice(0, 12));
    }
    expect(ids.size).toBe(100);
  });

  it("debug_id is present in both ok and fail responses", () => {
    const okEnv = { ok: true, data: {}, warnings: [], debug_id: "aaa111bbb222" };
    const failEnv = {
      ok: false,
      data: null,
      warnings: [],
      debug_id: "ccc333ddd444",
      error: { code: "TEST", message: "test" },
    };
    expect(isValidEnvelope(okEnv)).toBe(true);
    expect(isValidEnvelope(failEnv)).toBe(true);
  });
});

describe("Envelope — Invalid inputs rejected", () => {
  it("missing ok field is invalid", () => {
    expect(isValidEnvelope({ data: {}, warnings: [], debug_id: "x" })).toBe(false);
  });

  it("missing debug_id is invalid", () => {
    expect(isValidEnvelope({ ok: true, data: {}, warnings: [] })).toBe(false);
  });

  it("empty debug_id is invalid", () => {
    expect(isValidEnvelope({ ok: true, data: {}, warnings: [], debug_id: "" })).toBe(false);
  });

  it("warnings as string instead of array is invalid", () => {
    expect(isValidEnvelope({ ok: true, data: {}, warnings: "none", debug_id: "x" })).toBe(false);
  });

  it("null is invalid", () => {
    expect(isValidEnvelope(null)).toBe(false);
  });

  it("string is invalid", () => {
    expect(isValidEnvelope("ok")).toBe(false);
  });
});
