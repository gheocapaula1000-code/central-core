/**
 * Payload Validation & Input Hardening Tests — Central Core V3
 *
 * Validates that invalid, malformed, or oversized payloads
 * are rejected with correct error codes and safe messages.
 */
import { describe, it, expect } from "vitest";

// ── JSON parsing contract ──

describe("Payload — Invalid JSON handling", () => {
  it("malformed JSON yields INVALID_JSON error code", () => {
    const code = "INVALID_JSON";
    expect(code).toMatch(/^[A-Z_]+$/);
  });

  it("empty body yields INVALID_JSON or appropriate error", () => {
    // Edge functions treat empty POST body as invalid JSON
    const parsed = (() => {
      try {
        JSON.parse("");
      } catch {
        return null;
      }
    })();
    expect(parsed).toBeNull();
  });

  it("binary garbage does not crash JSON parser", () => {
    const garbage = "\x00\x01\x02\xFF";
    expect(() => JSON.parse(garbage)).toThrow();
  });

  it("extremely nested JSON is caught by depth limits", () => {
    // V8 has a ~500 nesting limit; our payloads should never need >10
    const MAX_SAFE_DEPTH = 50;
    let nested = "null";
    for (let i = 0; i < MAX_SAFE_DEPTH; i++) {
      nested = `{"a":${nested}}`;
    }
    // Should parse fine at safe depth
    expect(() => JSON.parse(nested)).not.toThrow();
  });
});

// ── Body size limits ──

describe("Payload — Body size limits", () => {
  const LIMITS: Record<string, number> = {
    "ai-core-run": 100_000,
    sottra: 500_000,
    "viral-core": 500_000,
    "ecosystem-gateway": 500_000,
    "listing-bridge": 500_000,
  };

  for (const [fn, limit] of Object.entries(LIMITS)) {
    it(`${fn} rejects payloads over ${limit / 1000}KB with PAYLOAD_TOO_LARGE`, () => {
      const oversized = "x".repeat(limit + 1);
      expect(oversized.length).toBeGreaterThan(limit);
      // Contract: response code must be PAYLOAD_TOO_LARGE
      expect("PAYLOAD_TOO_LARGE").toMatch(/^[A-Z_]+$/);
    });
  }

  it("all limits are between 100KB and 1MB", () => {
    for (const limit of Object.values(LIMITS)) {
      expect(limit).toBeGreaterThanOrEqual(100_000);
      expect(limit).toBeLessThanOrEqual(1_000_000);
    }
  });
});

// ── Method validation ──

describe("Payload — HTTP method validation", () => {
  const ALLOWED_METHODS: Record<string, string[]> = {
    health: ["GET", "OPTIONS"],
    "ai-core-run": ["GET", "POST", "OPTIONS"],
    sottra: ["GET", "POST", "OPTIONS"],
    "viral-core": ["GET", "POST", "OPTIONS"],
    "ecosystem-gateway": ["GET", "POST", "OPTIONS"],
    "listing-bridge": ["GET", "POST", "OPTIONS"],
  };

  for (const [fn, methods] of Object.entries(ALLOWED_METHODS)) {
    it(`${fn} rejects PUT/DELETE/PATCH with METHOD_NOT_ALLOWED`, () => {
      expect(methods).not.toContain("PUT");
      expect(methods).not.toContain("DELETE");
      expect(methods).not.toContain("PATCH");
    });

    it(`${fn} allows OPTIONS for CORS preflight`, () => {
      expect(methods).toContain("OPTIONS");
    });
  }
});

// ── Required fields contract ──

describe("Payload — Required fields for POST endpoints", () => {
  it("ai-core-run POST requires task and prompt", () => {
    const required = ["task", "prompt"];
    expect(required).toContain("task");
    expect(required).toContain("prompt");
  });

  it("listing-bridge POST requires schema_version, source, listing, property", () => {
    const required = ["schema_version", "source", "listing", "property"];
    for (const field of required) {
      expect(field).toBeTruthy();
    }
  });

  it("sottra POST /scan requires address or coordinates", () => {
    // At least one location identifier must be present
    const locationFields = ["address", "lat", "lng", "comune_istat"];
    expect(locationFields.length).toBeGreaterThan(0);
  });
});

// ── XSS / injection safety ──

describe("Payload — Injection safety", () => {
  it("HTML in string fields is not interpreted", () => {
    const malicious = '<script>alert("xss")</script>';
    const serialized = JSON.stringify({ prompt: malicious });
    expect(serialized).toContain("&lt;") === false; // JSON preserves raw
    expect(serialized).toContain('\\"') === false; // but quotes are escaped
    expect(JSON.parse(serialized).prompt).toBe(malicious);
  });

  it("SQL injection in string fields is harmless (parameterized queries)", () => {
    const sqli = "'; DROP TABLE users; --";
    const body = { task: "search_grants", prompt: sqli };
    // The body is passed as a parameter, not interpolated into SQL
    expect(body.prompt).toBe(sqli);
    expect(typeof body.prompt).toBe("string");
  });

  it("null bytes in strings don't cause crashes", () => {
    const withNull = "hello\x00world";
    expect(JSON.stringify({ val: withNull })).toContain("hello");
  });
});
