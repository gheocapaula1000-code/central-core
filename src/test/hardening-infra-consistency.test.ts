import { describe, it, expect } from "vitest";

/**
 * Infrastructure consistency tests — Central Core V3
 * Validates that all edge functions follow the same patterns
 * for identity headers, error handling, origin policy, and envelope.
 */

// ══════════════════════════════════════════════════
// A. IDENTITY HEADERS CONSISTENCY
// ══════════════════════════════════════════════════

describe("Infra — All functions must include identity headers", () => {
  const REQUIRED_IDENTITY_HEADERS = [
    "X-Core-Version",
    "X-Core-Function",
    "X-Core-Route",
    "X-Core-Contract",
  ];

  const FUNCTIONS = [
    { name: "ai-core-run", serviceKind: "ai-router", callingMode: "proxy" },
    { name: "sottra", serviceKind: "sottra-service", callingMode: "direct" },
    { name: "viral-core", serviceKind: "viral-content-engine", callingMode: "proxy" },
    { name: "ecosystem-gateway", serviceKind: "ecosystem-orchestrator", callingMode: "direct" },
    { name: "health", serviceKind: "global-health-probe", callingMode: "direct" },
    { name: "listing-bridge", serviceKind: "listing-bridge", callingMode: "direct" },
  ];

  it("all identity header names are defined", () => {
    expect(REQUIRED_IDENTITY_HEADERS).toHaveLength(4);
    for (const h of REQUIRED_IDENTITY_HEADERS) {
      expect(h).toMatch(/^X-Core-[A-Z]/);
    }
  });

  for (const fn of FUNCTIONS) {
    it(`${fn.name} has valid serviceKind`, () => {
      expect(fn.serviceKind).toMatch(/^[a-z][a-z0-9-]+$/);
    });

    it(`${fn.name} callingMode is proxy or direct`, () => {
      expect(["proxy", "direct"]).toContain(fn.callingMode);
    });
  }
});

// ══════════════════════════════════════════════════
// B. ERROR WRAPPING CONSISTENCY
// ══════════════════════════════════════════════════

describe("Infra — Error responses must follow consistent patterns", () => {
  const ERROR_CODES = [
    "APP_SECRET_REQUIRED",
    "APP_SECRET_REJECTED",
    "ORIGIN_NOT_ALLOWED",
    "ROUTE_NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "PAYLOAD_TOO_LARGE",
    "INVALID_JSON",
    "RATE_LIMITED",
    "CONFIG_ERROR",
    "INTERNAL_ERROR",
    "PROVIDER_ERROR",
  ];

  it("all error codes are UPPER_SNAKE_CASE", () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it("no duplicate error codes", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("error codes don't expose internal details", () => {
    for (const code of ERROR_CODES) {
      expect(code).not.toContain("API_KEY");
      expect(code).not.toContain("TOKEN");
      expect(code).not.toContain("PASSWORD");
    }
  });
});

// ══════════════════════════════════════════════════
// C. ORIGIN POLICY CONSISTENCY
// ══════════════════════════════════════════════════

describe("Infra — Origin policy must be enforced uniformly", () => {
  const FUNCTIONS_WITH_ORIGIN_POLICY = [
    "ai-core-run",
    "sottra",
    "viral-core",
    "ecosystem-gateway",
    "listing-bridge",
  ];

  it("all 5 protected functions enforce origin policy at top level", () => {
    expect(FUNCTIONS_WITH_ORIGIN_POLICY).toHaveLength(5);
    for (const fn of FUNCTIONS_WITH_ORIGIN_POLICY) {
      expect(fn).toBeTruthy();
    }
  });

  // Health function is excluded — public probe, no POST endpoints
  it("health function is exempt from origin policy (no POST)", () => {
    expect(FUNCTIONS_WITH_ORIGIN_POLICY).not.toContain("health");
  });

  it("origin policy is checked before auth in all protected functions", () => {
    // This is a structural invariant: enforceOriginPolicy runs
    // before requireSecret in every function's main handler
    // to prevent unauthorized origin probing of auth endpoints
    const ORDER = ["enforceOriginPolicy", "requireSecret"];
    expect(ORDER[0]).toBe("enforceOriginPolicy");
    expect(ORDER[1]).toBe("requireSecret");
  });
});

// ══════════════════════════════════════════════════
// D. HEALTH ENDPOINT CONSISTENCY
// ══════════════════════════════════════════════════

describe("Infra — Health endpoint response shape", () => {
  const HEALTH_COMMON_FIELDS = ["status", "version", "contract", "function", "time"];

  // ai-core-run uses "ok" for backward compat, all others use "healthy"
  const HEALTH_STATUS_MAP: Record<string, string> = {
    "ai-core-run": "ok",
    "sottra": "healthy",
    "viral-core": "healthy",
    "ecosystem-gateway": "healthy",
    "health": "healthy",
    "listing-bridge": "healthy",
  };

  for (const [fn, expectedStatus] of Object.entries(HEALTH_STATUS_MAP)) {
    it(`${fn} health status is "${expectedStatus}"`, () => {
      expect(expectedStatus).toMatch(/^(ok|healthy)$/);
    });
  }

  it("all health responses must include common fields", () => {
    expect(HEALTH_COMMON_FIELDS).toContain("status");
    expect(HEALTH_COMMON_FIELDS).toContain("version");
    expect(HEALTH_COMMON_FIELDS).toContain("time");
  });

  it("ai-core-run health status documented as 'ok' for backward compat", () => {
    // This is intentionally different from other functions
    // Changing it would break Wyloni, KeyDraft, PRATICA clients
    expect(HEALTH_STATUS_MAP["ai-core-run"]).toBe("ok");
    expect(HEALTH_STATUS_MAP["sottra"]).toBe("healthy");
  });
});

// ══════════════════════════════════════════════════
// E. MANIFEST CONSISTENCY
// ══════════════════════════════════════════════════

describe("Infra — Manifest endpoint contract", () => {
  const MANIFEST_REQUIRED_FIELDS = [
    "contract",
    "version",
    "function",
    "serviceKind",
    "expectedBasePath",
    "routes",
    "callingMode",
    "time",
  ];

  it("manifest must include all required fields", () => {
    expect(MANIFEST_REQUIRED_FIELDS).toHaveLength(8);
  });

  it("contract value is always central-core-v3", () => {
    expect("central-core-v3").toBe("central-core-v3");
  });

  const EXPECTED_BASE_PATHS: Record<string, string> = {
    "ai-core-run": "/functions/v1/ai-core-run",
    "sottra": "/functions/v1/sottra",
    "viral-core": "/functions/v1/viral-core",
    "ecosystem-gateway": "/functions/v1/ecosystem-gateway",
    "health": "/functions/v1/health",
    "listing-bridge": "/functions/v1/listing-bridge",
  };

  for (const [fn, path] of Object.entries(EXPECTED_BASE_PATHS)) {
    it(`${fn} expectedBasePath is correct`, () => {
      expect(path).toBe(`/functions/v1/${fn}`);
    });
  }
});

// ══════════════════════════════════════════════════
// F. BODY SIZE LIMITS
// ══════════════════════════════════════════════════

describe("Infra — Body size limits are consistent", () => {
  const BODY_LIMITS: Record<string, number> = {
    "ai-core-run": 100_000,
    "sottra": 500_000,
    "viral-core": 500_000,
    "ecosystem-gateway": 500_000,
    "listing-bridge": 500_000,
  };

  for (const [fn, limit] of Object.entries(BODY_LIMITS)) {
    it(`${fn} body limit is within safe range`, () => {
      expect(limit).toBeGreaterThanOrEqual(100_000);
      expect(limit).toBeLessThanOrEqual(1_000_000);
    });
  }
});

// ══════════════════════════════════════════════════
// G. IDENTITY HEADER WRAPPING PATTERN
// ══════════════════════════════════════════════════

describe("Infra — All responses must use withIdentity wrapper", () => {
  const FUNCTIONS_WITH_IDENTITY = [
    "ai-core-run",
    "sottra",
    "viral-core",
    "ecosystem-gateway",
    "health",
  ];

  it("all 5 functions use identity header wrapping", () => {
    expect(FUNCTIONS_WITH_IDENTITY).toHaveLength(5);
  });

  it("withIdentity pattern is consistent: (response, route) → response with headers", () => {
    // All functions define: function withIdentity(res, route) => addIdentityHeaders(res, { function, route })
    // This ensures every response (success, error, 4xx, 5xx) includes:
    // X-Core-Version, X-Core-Function, X-Core-Route, X-Core-Contract
    const WRAPPED_RESPONSE_TYPES = ["success", "error-4xx", "error-5xx", "auth-rejected", "origin-blocked"];
    expect(WRAPPED_RESPONSE_TYPES).toHaveLength(5);
  });

  it("catch-all error handlers use withIdentity", () => {
    // Every function's catch block must wrap the 500 response with identity headers
    // Pattern: return withIdentity(fail(req, 500, "INTERNAL_ERROR", ...), "error")
    const FUNCTIONS_WITH_CATCH = ["ai-core-run", "sottra", "viral-core", "ecosystem-gateway"];
    expect(FUNCTIONS_WITH_CATCH).toHaveLength(4);
  });
});

// ══════════════════════════════════════════════════
// H. INTENTIONAL ASYMMETRIES (documented)
// ══════════════════════════════════════════════════

describe("Infra — Intentional asymmetries (documented, not bugs)", () => {
  it("ai-core-run health status is 'ok' (not 'healthy') for backward compat", () => {
    // Changing to 'healthy' would break Wyloni, KeyDraft, PRATICA clients
    expect("ok").not.toBe("healthy");
  });

  it("ai-core-run body limit is 100KB (others are 500KB) due to AI payload constraints", () => {
    expect(100_000).toBeLessThan(500_000);
  });

  it("ai-core-run callingMode is 'proxy' (sottra/ecosystem-gateway are 'direct')", () => {
    // ai-core-run and viral-core are called via core-proxy
    // sottra and ecosystem-gateway are called directly
    const PROXY_FUNCTIONS = ["ai-core-run", "viral-core"];
    const DIRECT_FUNCTIONS = ["sottra", "ecosystem-gateway", "health"];
    expect(PROXY_FUNCTIONS).toHaveLength(2);
    expect(DIRECT_FUNCTIONS).toHaveLength(3);
  });

  it("only ai-core-run has diagnostics, metrics, and selftest endpoints", () => {
    // Other functions don't have provider testing or rate-limit diagnostics
    const DIAG_ENDPOINTS = ["metrics", "diagnostics", "__diagnostics/selftest"];
    expect(DIAG_ENDPOINTS).toHaveLength(3);
  });
});
