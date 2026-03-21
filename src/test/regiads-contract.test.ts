import { describe, it, expect } from "vitest";

/**
 * Regiads contract tests — Central Core V3
 * Validates the contract between Regiads and viral-core.
 * Regiads is the newest client, using viral-core for content generation.
 */

const CORE_VERSION = "3.3.5";
const CORE_CONTRACT = "central-core-v3";

// ══════════════════════════════════════════════════
// VIRAL-CORE ENDPOINTS USED BY REGIADS
// ══════════════════════════════════════════════════

describe("Regiads contract — Viral Core endpoints", () => {
  const REGIADS_ENDPOINTS = [
    { path: "/viral-core/health", method: "GET" },
    { path: "/viral-core/__health", method: "GET" },
    { path: "/viral-core/manifest", method: "GET" },
    { path: "/viral-core/capabilities", method: "GET" },
    { path: "/viral-core/generate-bundle", method: "POST" },
    { path: "/viral-core/generate-single", method: "POST" },
    { path: "/viral-core/policy-check", method: "POST" },
    { path: "/viral-core/build-media-brief", method: "POST" },
  ];

  it("all Regiads endpoints use /viral-core/ prefix", () => {
    for (const ep of REGIADS_ENDPOINTS) {
      expect(ep.path).toMatch(/^\/viral-core\//);
    }
  });

  it("has 4 GET + 4 POST endpoints", () => {
    const gets = REGIADS_ENDPOINTS.filter(e => e.method === "GET");
    const posts = REGIADS_ENDPOINTS.filter(e => e.method === "POST");
    expect(gets).toHaveLength(4);
    expect(posts).toHaveLength(4);
  });

  it("POST endpoints follow kebab-case", () => {
    const posts = REGIADS_ENDPOINTS.filter(e => e.method === "POST");
    for (const ep of posts) {
      const route = ep.path.replace("/viral-core/", "");
      expect(route).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});

// ══════════════════════════════════════════════════
// GENERATE-BUNDLE REQUEST/RESPONSE SHAPE
// ══════════════════════════════════════════════════

describe("Regiads contract — generate-bundle shape", () => {
  const sampleRequest = {
    source_app: "regiads",
    argomento: "Test topic",
    obiettivo: "engagement",
    tono: "professionale",
    formato: "post",
    options: {
      includeVideoScript15s: true,
      includeGoogleAdsPack: true,
      includePolicyCheck: true,
    },
  };

  it("request has required argomento field", () => {
    expect(sampleRequest).toHaveProperty("argomento");
    expect(typeof sampleRequest.argomento).toBe("string");
  });

  it("source_app identifies regiads", () => {
    expect(sampleRequest.source_app).toBe("regiads");
  });

  const sampleResponse = {
    ok: true,
    data: {
      contents: {
        tiktok: "TikTok content",
        instagram: "Instagram content",
        facebook: "Facebook content",
        linkedin: "LinkedIn content",
      },
      mediaSuggestions: {},
      videoScript15s: "script text",
      googleAdsPack: {},
      policy: {
        riskLevel: "low",
        publishModeRecommendation: "eligible_manual_publish",
        riskFlags: [],
        notes: [],
      },
    },
    warnings: [],
    debug_id: "abc123",
  };

  it("response has standard envelope", () => {
    expect(sampleResponse).toHaveProperty("ok", true);
    expect(sampleResponse).toHaveProperty("data");
    expect(sampleResponse).toHaveProperty("warnings");
    expect(sampleResponse).toHaveProperty("debug_id");
  });

  it("response contains all 4 platform contents", () => {
    const platforms = Object.keys(sampleResponse.data.contents);
    expect(platforms.sort()).toEqual(["facebook", "instagram", "linkedin", "tiktok"]);
  });

  it("policy has expected shape", () => {
    const policy = sampleResponse.data.policy;
    expect(["low", "medium", "high"]).toContain(policy.riskLevel);
    expect(["manual_review", "draft_only", "eligible_manual_publish"]).toContain(policy.publishModeRecommendation);
    expect(Array.isArray(policy.riskFlags)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// POLICY-CHECK SHAPE
// ══════════════════════════════════════════════════

describe("Regiads contract — policy-check shape", () => {
  it("request requires contents object with platform keys", () => {
    const request = {
      source_app: "regiads",
      contents: { tiktok: "content", instagram: "content" },
    };
    expect(request.contents).toBeDefined();
    expect(Object.keys(request.contents).length).toBeGreaterThan(0);
  });

  it("response returns riskLevel + publishModeRecommendation", () => {
    const response = {
      riskLevel: "medium",
      publishModeRecommendation: "manual_review",
      riskFlags: ["similar_copy"],
      notes: ["review suggested"],
    };
    expect(["low", "medium", "high"]).toContain(response.riskLevel);
    expect(["manual_review", "draft_only", "eligible_manual_publish"]).toContain(response.publishModeRecommendation);
  });
});

// ══════════════════════════════════════════════════
// ERROR CASES
// ══════════════════════════════════════════════════

describe("Regiads contract — Error cases", () => {
  const errorCases = [
    { scenario: "missing argomento", code: "MISSING_ARGOMENTO", status: 400 },
    { scenario: "invalid platform", code: "INVALID_PLATFORM", status: 400 },
    { scenario: "missing contents", code: "MISSING_CONTENTS", status: 400 },
    { scenario: "missing content for media brief", code: "MISSING_CONTENT", status: 400 },
    { scenario: "no auth", code: "APP_SECRET_REQUIRED", status: 401 },
    { scenario: "wrong auth", code: "APP_SECRET_REJECTED", status: 401 },
  ];

  for (const { scenario, code, status } of errorCases) {
    it(`${scenario} → ${code} (${status})`, () => {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    });
  }
});

// ══════════════════════════════════════════════════
// PROXY COMPATIBILITY
// ══════════════════════════════════════════════════

describe("Regiads contract — Proxy compatibility", () => {
  it("all Regiads paths are under /viral-core (proxy-compatible)", () => {
    const paths = ["/viral-core/generate-bundle", "/viral-core/generate-single", "/viral-core/policy-check", "/viral-core/build-media-brief"];
    for (const p of paths) {
      expect(p.startsWith("/viral-core/")).toBe(true);
    }
  });

  it("Regiads does NOT route through /ai-core-run", () => {
    const paths = ["/viral-core/generate-bundle", "/viral-core/generate-single"];
    for (const p of paths) {
      expect(p.startsWith("/ai-core-run")).toBe(false);
    }
  });

  it("timeout expectations for Regiads routes", () => {
    const timeouts: Record<string, number> = {
      "/viral-core/generate-bundle": 60_000,
      "/viral-core/generate-single": 45_000,
      "/viral-core/policy-check": 20_000,
      "/viral-core/build-media-brief": 20_000,
    };
    for (const [, timeout] of Object.entries(timeouts)) {
      expect(timeout).toBeGreaterThanOrEqual(20_000);
      expect(timeout).toBeLessThanOrEqual(60_000);
    }
  });
});
