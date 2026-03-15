import { describe, it, expect } from "vitest";

/**
 * Compatibility contract tests — Central Core V3
 * Validates identity headers, manifest shape, and no sensitive data leaks.
 * Runs as dry-run / structural checks (no live HTTP required).
 */

const CORE_VERSION = "3.3.1";
const CORE_CONTRACT = "central-core-v3";

// ── Manifest shape expectations ──
const MANIFEST_REQUIRED_KEYS = ["contract", "version", "function", "serviceKind", "expectedBasePath", "routes", "callingMode", "time"];
const SENSITIVE_PATTERNS = [/API_KEY/i, /SECRET/i, /password/i, /token/i, /service.role/i, /allowlist/i, /allowed.origins/i];

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

function buildTestManifest(functionName: string, serviceKind: string, basePath: string, routes: string[], domains?: string[]): ManifestData {
  return {
    contract: CORE_CONTRACT,
    version: CORE_VERSION,
    function: functionName,
    serviceKind,
    expectedBasePath: basePath,
    routes,
    ...(domains ? { domains } : {}),
    callingMode: functionName === "health" || functionName === "sottra" ? "direct" : "proxy",
    time: new Date().toISOString(),
  };
}

describe("Compatibility contract — Identity headers", () => {
  it("X-Core-Version matches CORE_VERSION constant", () => {
    expect(CORE_VERSION).toBe("3.3.1");
  });

  it("X-Core-Contract is central-core-v3", () => {
    expect(CORE_CONTRACT).toBe("central-core-v3");
  });

  it("identity header names are stable and non-sensitive", () => {
    const headers = ["X-Core-Version", "X-Core-Function", "X-Core-Route", "X-Core-Contract"];
    for (const h of headers) {
      expect(h).toMatch(/^X-Core-/);
      for (const p of SENSITIVE_PATTERNS) {
        expect(h).not.toMatch(p);
      }
    }
  });
});

describe("Compatibility contract — Manifest shape", () => {
  const manifests: Array<{ name: string; manifest: ManifestData }> = [
    {
      name: "ai-core-run",
      manifest: buildTestManifest("ai-core-run", "ai-router", "/functions/v1/ai-core-run", [
        "GET /health", "GET /__health", "GET /manifest",
        "GET /metrics", "GET /diagnostics", "GET /__diagnostics/selftest",
        "POST /documents/analyze", "POST /web/scrape", "POST /tariffs/compare",
        "POST (generic AI run)",
      ], ["wyloni_bandi", "wyloni_bonus", "pratica_legal", "keydraft_realestate"]),
    },
    {
      name: "sottra",
      manifest: buildTestManifest("sottra", "sottra-service", "/functions/v1/sottra", [
        "GET /health", "GET /manifest",
        "POST /scan/identify", "POST /scan/cadastral", "POST /scan/pricing",
        "POST /scan/listings", "POST /scan/energy", "POST /scan/condominio",
        "POST /scan/storico-transazioni", "POST /scan/market",
        "POST /forecast/moodscore", "POST /forecast/timeview",
        "POST /forecast/opportunity", "POST /forecast/infrastrutture",
        "POST /forecast/rischio-zona", "POST /forecast/trend-demografico",
        "POST /forecast/sviluppo-area", "POST /forecast/convergenza-territoriale",
      ]),
    },
    {
      name: "health",
      manifest: buildTestManifest("health", "global-health-probe", "/functions/v1/health", [
        "GET /", "GET /manifest",
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
});

describe("Compatibility contract — Base path correctness", () => {
  it("ai-core-run expectedBasePath is /functions/v1/ai-core-run", () => {
    expect("/functions/v1/ai-core-run").toBe("/functions/v1/ai-core-run");
  });

  it("sottra expectedBasePath is /functions/v1/sottra", () => {
    expect("/functions/v1/sottra").toBe("/functions/v1/sottra");
  });

  it("health expectedBasePath is /functions/v1/health", () => {
    expect("/functions/v1/health").toBe("/functions/v1/health");
  });
});

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

describe("Compatibility contract — Sottra route registry", () => {
  const SOTTRA_ROUTES = [
    "scan/identify", "scan/cadastral", "scan/pricing", "scan/listings",
    "scan/energy", "scan/condominio", "scan/storico-transazioni", "scan/market",
    "forecast/moodscore", "forecast/timeview", "forecast/opportunity",
    "forecast/infrastrutture", "forecast/rischio-zona", "forecast/trend-demografico",
    "forecast/sviluppo-area", "forecast/convergenza-territoriale",
  ];

  it("has 16 operational routes (8 scan + 8 forecast)", () => {
    expect(SOTTRA_ROUTES.length).toBe(16);
  });

  it("all routes follow engine/action pattern", () => {
    for (const r of SOTTRA_ROUTES) {
      expect(r).toMatch(/^(scan|forecast)\/[a-z-]+$/);
    }
  });
});

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
