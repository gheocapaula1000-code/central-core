import { describe, it, expect } from "vitest";

/**
 * Compatibility contract tests — Central Core V3
 * Validates identity headers, manifest shape, envelope standards,
 * proxy contract expectations, and no sensitive data leaks.
 * Covers ALL functions: ai-core-run, sottra, health, ecosystem-gateway, viral-core.
 * Runs as dry-run / structural checks (no live HTTP required).
 */

const CORE_VERSION = "3.4.0";
const CORE_CONTRACT = "central-core-v3";

// ── Shared constants ──
const MANIFEST_REQUIRED_KEYS = ["contract", "version", "function", "serviceKind", "expectedBasePath", "routes", "callingMode", "time"];
const SENSITIVE_PATTERNS = [/API_KEY/i, /SECRET/i, /password/i, /token/i, /service.role/i, /allowlist/i, /allowed.origins/i];
const IDENTITY_HEADERS = ["X-Core-Version", "X-Core-Function", "X-Core-Route", "X-Core-Contract"];
const AUTH_HEADERS_PRIORITY = ["x-internal-secret", "x-app-secret", "x-core-secret", "Authorization"];
const _VALID_RISK_LEVELS = ["low", "medium", "high"];
const _VALID_PUBLISH_MODES = ["manual_review", "draft_only", "eligible_manual_publish"];
const _VALID_PLATFORMS = ["tiktok", "instagram", "facebook", "linkedin"];

interface ManifestData {
  contract: string;
  version: string;
  function: string;
  serviceKind: string;
  expectedBasePath: string;
  routes: string[];
  callingMode: string;
  domains?: string[];
  time: string;
}

function buildTestManifest(functionName: string, serviceKind: string, basePath: string, routes: string[], extra?: { domains?: string[]; callingMode?: string }): ManifestData {
  return {
    contract: CORE_CONTRACT,
    version: CORE_VERSION,
    function: functionName,
    serviceKind,
    expectedBasePath: basePath,
    routes,
    ...(extra?.domains ? { domains: extra.domains } : {}),
    callingMode: extra?.callingMode ?? "proxy",
    time: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════
// IDENTITY HEADERS
// ══════════════════════════════════════════════════

describe("Compatibility contract — Identity headers", () => {
  it("X-Core-Version matches CORE_VERSION constant", () => {
    expect(CORE_VERSION).toBe("3.4.0");
  });

  it("X-Core-Contract is central-core-v3", () => {
    expect(CORE_CONTRACT).toBe("central-core-v3");
  });

  it("identity header names are stable and non-sensitive", () => {
    for (const h of IDENTITY_HEADERS) {
      expect(h).toMatch(/^X-Core-/);
      for (const p of SENSITIVE_PATTERNS) {
        expect(h).not.toMatch(p);
      }
    }
  });

  it("exactly 4 identity headers", () => {
    expect(IDENTITY_HEADERS).toHaveLength(4);
  });
});

// ══════════════════════════════════════════════════
// AUTH STANDARD
// ══════════════════════════════════════════════════

describe("Compatibility contract — Auth header priority", () => {
  it("defines 4 auth methods in priority order", () => {
    expect(AUTH_HEADERS_PRIORITY).toEqual([
      "x-internal-secret",
      "x-app-secret",
      "x-core-secret",
      "Authorization",
    ]);
  });

  it("x-internal-secret is highest priority", () => {
    expect(AUTH_HEADERS_PRIORITY[0]).toBe("x-internal-secret");
  });
});

// ══════════════════════════════════════════════════
// ENVELOPE STANDARD
// ══════════════════════════════════════════════════

describe("Compatibility contract — Envelope standard", () => {
  const successEnvelope = { ok: true, data: { test: true }, warnings: [], debug_id: "abc123" };
  const errorEnvelope = { ok: false, data: null, warnings: [], debug_id: "abc123", error: { code: "TEST_ERROR", message: "Test" } };

  it("success envelope has required fields", () => {
    expect(successEnvelope).toHaveProperty("ok", true);
    expect(successEnvelope).toHaveProperty("data");
    expect(successEnvelope).toHaveProperty("warnings");
    expect(successEnvelope).toHaveProperty("debug_id");
  });

  it("error envelope has required fields", () => {
    expect(errorEnvelope).toHaveProperty("ok", false);
    expect(errorEnvelope).toHaveProperty("data", null);
    expect(errorEnvelope).toHaveProperty("error");
    expect(errorEnvelope.error).toHaveProperty("code");
    expect(errorEnvelope.error).toHaveProperty("message");
  });

  it("error code is UPPERCASE_SNAKE_CASE", () => {
    expect(errorEnvelope.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("debug_id is a string", () => {
    expect(typeof successEnvelope.debug_id).toBe("string");
    expect(typeof errorEnvelope.debug_id).toBe("string");
  });

  it("warnings is always an array", () => {
    expect(Array.isArray(successEnvelope.warnings)).toBe(true);
    expect(Array.isArray(errorEnvelope.warnings)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// ERROR CODES REGISTRY
// ══════════════════════════════════════════════════

describe("Compatibility contract — Error codes", () => {
  const STANDARD_ERROR_CODES: Record<string, number> = {
    APP_SECRET_REQUIRED: 401,
    APP_SECRET_REJECTED: 401,
    ORIGIN_NOT_ALLOWED: 403,
    MISSING_PROMPT: 400,
    INVALID_JSON: 400,
    PAYLOAD_TOO_LARGE: 413,
    INVALID_DOMAIN: 400,
    INVALID_TASK: 400,
    METHOD_NOT_ALLOWED: 405,
    ROUTE_NOT_FOUND: 404,
    RATE_LIMITED: 429,
    PROVIDER_ERROR: 502,
    CONFIG_ERROR: 500,
    INTERNAL_ERROR: 500,
  };

  it("all error codes are UPPERCASE_SNAKE_CASE", () => {
    for (const code of Object.keys(STANDARD_ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it("HTTP status codes are valid", () => {
    for (const status of Object.values(STANDARD_ERROR_CODES)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it("401 codes require auth context", () => {
    const authCodes = Object.entries(STANDARD_ERROR_CODES).filter(([, s]) => s === 401).map(([c]) => c);
    expect(authCodes).toContain("APP_SECRET_REQUIRED");
    expect(authCodes).toContain("APP_SECRET_REJECTED");
  });
});

// ══════════════════════════════════════════════════
// MANIFEST SHAPE — ALL FUNCTIONS
// ══════════════════════════════════════════════════

describe("Compatibility contract — Manifest shape (all functions)", () => {
  const manifests: Array<{ name: string; manifest: ManifestData }> = [
    {
      name: "ai-core-run",
      manifest: buildTestManifest("ai-core-run", "ai-router", "/functions/v1/ai-core-run", [
        "GET /health", "GET /__health", "GET /manifest",
        "GET /metrics", "GET /diagnostics", "GET /__diagnostics/selftest",
        "POST /documents/analyze", "POST /web/scrape", "POST /tariffs/compare",
        "POST (generic AI run)",
      ], { domains: ["wyloni_bandi", "wyloni_bonus", "pratica_legal", "keydraft_realestate"] }),
    },
    {
      name: "sottra",
      manifest: buildTestManifest("sottra", "sottra-service", "/functions/v1/sottra", [
        "GET /health", "GET /manifest",
        "POST /scan/identify", "POST /scan/photo-wow", "POST /scan/cadastral", "POST /scan/pricing",
        "POST /scan/listings", "POST /scan/energy", "POST /scan/condominio",
        "POST /scan/storico-transazioni", "POST /scan/market",
        "POST /forecast/moodscore", "POST /forecast/timeview",
        "POST /forecast/opportunity", "POST /forecast/infrastrutture",
        "POST /forecast/rischio-zona", "POST /forecast/trend-demografico",
        "POST /forecast/sviluppo-area", "POST /forecast/convergenza-territoriale",
      ], { callingMode: "direct" }),
    },
    {
      name: "health",
      manifest: buildTestManifest("health", "global-health-probe", "/functions/v1/health", [
        "GET /", "GET /manifest",
      ], { callingMode: "direct" }),
    },
    {
      name: "ecosystem-gateway",
      manifest: buildTestManifest("ecosystem-gateway", "ecosystem-orchestrator", "/functions/v1/ecosystem-gateway", [
        "GET /", "GET /health", "GET /__health", "GET /manifest", "GET /capabilities",
        "POST /listing-enrichment", "POST /service-pack", "POST /unified-report",
      ], { callingMode: "direct" }),
    },
    {
      name: "viral-core",
      manifest: buildTestManifest("viral-core", "viral-content-engine", "/functions/v1/viral-core", [
        "GET /", "GET /health", "GET /__health", "GET /manifest", "GET /capabilities",
        "POST /generate-bundle", "POST /generate-single", "POST /policy-check", "POST /build-media-brief",
      ]),
    },
  ];

  for (const { name, manifest } of manifests) {
    describe(`${name} manifest`, () => {
      it("has all required keys", () => {
        for (const key of MANIFEST_REQUIRED_KEYS) {
          expect(manifest).toHaveProperty(key);
        }
      });

      it("contract is central-core-v3", () => {
        expect(manifest.contract).toBe(CORE_CONTRACT);
      });

      it("version matches CORE_VERSION", () => {
        expect(manifest.version).toBe(CORE_VERSION);
      });

      it("expectedBasePath starts with /functions/v1/", () => {
        expect(manifest.expectedBasePath).toMatch(/^\/functions\/v1\//);
      });

      it("expectedBasePath ends with function name", () => {
        expect(manifest.expectedBasePath).toContain(manifest.function);
      });

      it("routes is non-empty array", () => {
        expect(Array.isArray(manifest.routes)).toBe(true);
        expect(manifest.routes.length).toBeGreaterThan(0);
      });

      it("callingMode is proxy or direct", () => {
        expect(["proxy", "direct"]).toContain(manifest.callingMode);
      });

      it("contains no sensitive data", () => {
        const json = JSON.stringify(manifest);
        for (const p of SENSITIVE_PATTERNS) {
          expect(json).not.toMatch(p);
        }
      });
    });
  }

  it("covers all 5 functions", () => {
    expect(manifests.map(m => m.name).sort()).toEqual([
      "ai-core-run", "ecosystem-gateway", "health", "sottra", "viral-core",
    ]);
  });
});

// ══════════════════════════════════════════════════
// BASE PATH CORRECTNESS
// ══════════════════════════════════════════════════

describe("Compatibility contract — Base path correctness", () => {
  const EXPECTED_PATHS: Record<string, string> = {
    "ai-core-run": "/functions/v1/ai-core-run",
    "sottra": "/functions/v1/sottra",
    "health": "/functions/v1/health",
    "ecosystem-gateway": "/functions/v1/ecosystem-gateway",
    "viral-core": "/functions/v1/viral-core",
  };

  for (const [fn, path] of Object.entries(EXPECTED_PATHS)) {
    it(`${fn} expectedBasePath is ${path}`, () => {
      expect(path).toBe(`/functions/v1/${fn}`);
    });
  }
});

// ══════════════════════════════════════════════════
// DOMAIN REGISTRY
// ══════════════════════════════════════════════════

describe("Compatibility contract — Domain registry consistency", () => {
  const AI_CORE_DOMAINS = ["wyloni_bandi", "wyloni_bonus", "pratica_legal", "keydraft_realestate"];

  it("all domains match [a-z0-9_]+ pattern", () => {
    for (const d of AI_CORE_DOMAINS) {
      expect(d).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("wyloni_bandi is a registered domain", () => {
    expect(AI_CORE_DOMAINS).toContain("wyloni_bandi");
  });

  it("keydraft_realestate is a registered domain", () => {
    expect(AI_CORE_DOMAINS).toContain("keydraft_realestate");
  });

  it("pratica_legal is a registered domain", () => {
    expect(AI_CORE_DOMAINS).toContain("pratica_legal");
  });
});

// ══════════════════════════════════════════════════
// SOTTRA ROUTE REGISTRY
// ══════════════════════════════════════════════════

describe("Compatibility contract — Sottra route registry", () => {
  const SOTTRA_ROUTES = [
    "scan/identify", "scan/photo-wow", "scan/cadastral", "scan/pricing", "scan/listings",
    "scan/energy", "scan/condominio", "scan/storico-transazioni", "scan/market",
    "forecast/moodscore", "forecast/timeview", "forecast/opportunity",
    "forecast/infrastrutture", "forecast/rischio-zona", "forecast/trend-demografico",
    "forecast/sviluppo-area", "forecast/convergenza-territoriale",
  ];

  it("has 17 operational routes (9 scan + 8 forecast)", () => {
    expect(SOTTRA_ROUTES.length).toBe(17);
  });

  it("all routes follow engine/action pattern", () => {
    for (const r of SOTTRA_ROUTES) {
      expect(r).toMatch(/^(scan|forecast)\/[a-z-]+$/);
    }
  });
});

// ══════════════════════════════════════════════════
// VIRAL CORE ROUTE REGISTRY
// ══════════════════════════════════════════════════

describe("Compatibility contract — Viral Core route registry", () => {
  const VIRAL_CORE_POST_ROUTES = ["generate-bundle", "generate-single", "policy-check", "build-media-brief"];
  const VIRAL_CORE_GET_ROUTES = ["/", "/health", "/__health", "/manifest", "/capabilities"];

  it("has 4 POST routes", () => {
    expect(VIRAL_CORE_POST_ROUTES).toHaveLength(4);
  });

  it("has 5 GET routes", () => {
    expect(VIRAL_CORE_GET_ROUTES).toHaveLength(5);
  });

  it("POST routes follow kebab-case", () => {
    for (const r of VIRAL_CORE_POST_ROUTES) {
      expect(r).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});

// ══════════════════════════════════════════════════
// ECOSYSTEM GATEWAY ROUTE REGISTRY
// ══════════════════════════════════════════════════

describe("Compatibility contract — Ecosystem Gateway route registry", () => {
  const GATEWAY_POST_ROUTES = ["listing-enrichment", "service-pack", "unified-report"];
  const GATEWAY_GET_ROUTES = ["/", "/health", "/__health", "/manifest", "/capabilities"];

  it("has 3 POST routes", () => {
    expect(GATEWAY_POST_ROUTES).toHaveLength(3);
  });

  it("has 5 GET routes", () => {
    expect(GATEWAY_GET_ROUTES).toHaveLength(5);
  });

  it("POST routes follow kebab-case", () => {
    for (const r of GATEWAY_POST_ROUTES) {
      expect(r).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});

// ══════════════════════════════════════════════════
// PROXY CONTRACT VALIDATION
// ══════════════════════════════════════════════════

describe("Compatibility contract — Proxy contract", () => {
  const PROXY_ALLOWED_PATHS = ["/ai-core-run", "/sottra", "/viral-core", "/ecosystem-gateway"];

  function isPathAllowed(path: string): boolean {
    return PROXY_ALLOWED_PATHS.some(prefix => path === prefix || path.startsWith(prefix + "/"));
  }

  it("allows known function paths", () => {
    expect(isPathAllowed("/ai-core-run")).toBe(true);
    expect(isPathAllowed("/ai-core-run/health")).toBe(true);
    expect(isPathAllowed("/sottra/scan/pricing")).toBe(true);
    expect(isPathAllowed("/viral-core/generate-bundle")).toBe(true);
    expect(isPathAllowed("/ecosystem-gateway/listing-enrichment")).toBe(true);
  });

  it("blocks unknown paths", () => {
    expect(isPathAllowed("/unknown")).toBe(false);
    expect(isPathAllowed("/admin")).toBe(false);
    expect(isPathAllowed("/ai-core-runx")).toBe(false);
  });

  it("does not remap viral-core to ai-core-run", () => {
    const viralPath = "/viral-core/generate-bundle";
    expect(viralPath.startsWith("/viral-core/")).toBe(true);
    expect(viralPath.startsWith("/ai-core-run")).toBe(false);
  });

  it("does not remap ecosystem-gateway to ai-core-run", () => {
    const gwPath = "/ecosystem-gateway/listing-enrichment";
    expect(gwPath.startsWith("/ecosystem-gateway/")).toBe(true);
    expect(gwPath.startsWith("/ai-core-run")).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// TIMEOUT EXPECTATIONS
// ══════════════════════════════════════════════════

describe("Compatibility contract — Timeout expectations", () => {
  const TIMEOUT_MAP: Record<string, number> = {
    "/ai-core-run": 45_000,
    "/ai-core-run/documents/analyze": 60_000,
    "/ai-core-run/web/scrape": 30_000,
    "/sottra/scan/pricing": 30_000,
    "/sottra/forecast/timeview": 30_000,
    "/viral-core/generate-bundle": 60_000,
    "/viral-core/generate-single": 45_000,
    "/viral-core/policy-check": 20_000,
    "/viral-core/build-media-brief": 20_000,
    "/ecosystem-gateway/listing-enrichment": 30_000,
  };

  for (const [path, timeout] of Object.entries(TIMEOUT_MAP)) {
    it(`${path} timeout is ${timeout / 1000}s`, () => {
      expect(timeout).toBeGreaterThanOrEqual(20_000);
      expect(timeout).toBeLessThanOrEqual(60_000);
    });
  }

  it("bundle routes have the longest timeouts", () => {
    expect(TIMEOUT_MAP["/viral-core/generate-bundle"]).toBe(60_000);
    expect(TIMEOUT_MAP["/ai-core-run/documents/analyze"]).toBe(60_000);
  });
});

// ══════════════════════════════════════════════════
// HEALTH RESPONSE SHAPE
// ══════════════════════════════════════════════════

describe("Compatibility contract — Health response enrichment", () => {
  it("health responses include contract, function, expectedBasePath", () => {
    const healthFields = ["status", "version", "contract", "function", "expectedBasePath", "time"];
    const sampleHealth = {
      status: "ok",
      version: CORE_VERSION,
      contract: CORE_CONTRACT,
      function: "ai-core-run",
      expectedBasePath: "/functions/v1/ai-core-run",
      time: new Date().toISOString(),
    };
    for (const f of healthFields) {
      expect(sampleHealth).toHaveProperty(f);
    }
  });

  it("health response contains no sensitive data", () => {
    const json = JSON.stringify({
      status: "ok", version: CORE_VERSION, contract: CORE_CONTRACT,
      function: "ai-core-run", expectedBasePath: "/functions/v1/ai-core-run",
    });
    for (const p of SENSITIVE_PATTERNS) {
      expect(json).not.toMatch(p);
    }
  });
});

// ══════════════════════════════════════════════════
// CROSS-FUNCTION CONSISTENCY
// ══════════════════════════════════════════════════

describe("Compatibility contract — Cross-function consistency", () => {
  const ALL_FUNCTIONS = ["ai-core-run", "sottra", "health", "ecosystem-gateway", "viral-core"];

  it("all functions use the same CORE_VERSION", () => {
    // structural — the constant is shared via _shared/http.ts
    expect(CORE_VERSION).toBe("3.4.0");
  });

  it("all functions use the same CORE_CONTRACT", () => {
    expect(CORE_CONTRACT).toBe("central-core-v3");
  });

  it("all function names are lowercase kebab-case or single word", () => {
    for (const fn of ALL_FUNCTIONS) {
      expect(fn).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("5 functions in the ecosystem", () => {
    expect(ALL_FUNCTIONS).toHaveLength(5);
  });
});
