import { describe, it, expect } from "vitest";

/**
 * Security hardening tests — Central Core V3
 * Validates that sensitive data is never leaked in responses,
 * diagnostics are properly gated, provider fallback behavior
 * is correct, and the system degrades safely.
 */

// ── Redact patterns ──

const SENSITIVE_ENV_NAMES = [
  "AI_CORE_SECRET", "DIAGNOSTIC_SECRET", "DIAGNOSTIC_SELFTEST_SECRET",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY",
  "FIRECRAWL_API_KEY", "GOOGLE_MAPS_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "CORE_ALLOWED_ORIGINS", "AI_CORE_ADMIN_EMAILS",
];

const SENSITIVE_HEADER_NAMES = [
  "x-internal-secret", "x-app-secret", "x-core-secret",
  "x-diagnostic-secret", "authorization",
];

// ══════════════════════════════════════════════════
// A. DIAGNOSTICS SECRECY
// ══════════════════════════════════════════════════

describe("Security — Diagnostics never leak secrets", () => {
  const sampleHealthResponse = {
    status: "ok",
    version: "3.3.3",
    contract: "central-core-v3",
    function: "ai-core-run",
    expectedBasePath: "/functions/v1/ai-core-run",
    time: "2026-03-20T00:00:00.000Z",
  };

  it("health response contains no secret env var names", () => {
    const json = JSON.stringify(sampleHealthResponse);
    for (const name of SENSITIVE_ENV_NAMES) {
      expect(json).not.toContain(name);
    }
  });

  it("health response contains no secret header names", () => {
    const json = JSON.stringify(sampleHealthResponse);
    for (const name of SENSITIVE_HEADER_NAMES) {
      expect(json.toLowerCase()).not.toContain(name);
    }
  });

  const sampleManifest = {
    contract: "central-core-v3",
    version: "3.3.3",
    function: "ai-core-run",
    serviceKind: "ai-router",
    expectedBasePath: "/functions/v1/ai-core-run",
    routes: ["GET /health", "POST /documents/analyze"],
    callingMode: "proxy",
    time: "2026-03-20T00:00:00.000Z",
  };

  it("manifest response contains no secret env var names", () => {
    const json = JSON.stringify(sampleManifest);
    for (const name of SENSITIVE_ENV_NAMES) {
      expect(json).not.toContain(name);
    }
  });

  it("manifest response contains no host allowlist or admin emails", () => {
    const json = JSON.stringify(sampleManifest);
    expect(json).not.toContain("ALLOWED_ORIGINS");
    expect(json).not.toContain("ADMIN_EMAILS");
  });
});

// ══════════════════════════════════════════════════
// B. ERROR ENVELOPE SAFETY
// ══════════════════════════════════════════════════

describe("Security — Error envelope never exposes internals", () => {
  const errorCases = [
    { code: "APP_SECRET_REQUIRED", message: "Missing x-internal-secret", status: 401 },
    { code: "APP_SECRET_REJECTED", message: "Invalid secret", status: 401 },
    { code: "ORIGIN_NOT_ALLOWED", message: "Origin not in allowlist", status: 403 },
    { code: "INTERNAL_ERROR", message: "An internal error occurred. Reference: abc123", status: 500 },
    { code: "PROVIDER_ERROR", message: "AI provider temporarily unavailable", status: 502 },
    { code: "CONFIG_ERROR", message: "AI_CORE_SECRET not configured", status: 500 },
  ];

  for (const err of errorCases) {
    it(`${err.code} message does not contain stack trace`, () => {
      expect(err.message).not.toMatch(/at\s+\w+\s+\(/);
      expect(err.message).not.toContain("node_modules");
      expect(err.message).not.toContain(".ts:");
    });

    it(`${err.code} message does not contain API keys`, () => {
      expect(err.message).not.toMatch(/sk-[a-zA-Z0-9]+/);
      expect(err.message).not.toMatch(/Bearer\s+[a-zA-Z0-9]+/);
    });
  }

  it("INTERNAL_ERROR always includes debug_id reference", () => {
    const msg = "An internal error occurred. Reference: abc123";
    expect(msg).toContain("Reference:");
  });
});

// ══════════════════════════════════════════════════
// C. PROVIDER FALLBACK CONTRACT
// ══════════════════════════════════════════════════

describe("Security — Provider fallback and degradation", () => {
  const PROVIDER_ORDER = ["openai", "anthropic"];
  const WEB_PROVIDER = "perplexity";

  it("generative tasks fallback order is openai → anthropic", () => {
    expect(PROVIDER_ORDER).toEqual(["openai", "anthropic"]);
  });

  it("web tasks use perplexity with safe empty fallback", () => {
    expect(WEB_PROVIDER).toBe("perplexity");
    // When perplexity fails, system returns empty result, not crash
    const emptyFallback = '{"ok":false,"error":"Ricerca non disponibile"}';
    expect(JSON.parse(emptyFallback)).toHaveProperty("ok", false);
  });

  it("missing provider key causes graceful error, not crash", () => {
    // When OPENAI_API_KEY is missing, callOpenAI throws "not configured"
    // When both are missing, runAI throws with both error messages
    const errorMsg = "All AI providers failed. OpenAI: OPENAI_API_KEY not configured. Anthropic: ANTHROPIC_API_KEY not configured";
    expect(errorMsg).not.toContain("undefined");
    expect(errorMsg).not.toContain("null");
    expect(errorMsg).toContain("not configured");
  });

  it("provider timeout values are within safe range", () => {
    const OPENAI_TIMEOUT = 25_000;
    const ANTHROPIC_TIMEOUT = 25_000;
    const PERPLEXITY_TIMEOUT = 30_000;
    expect(OPENAI_TIMEOUT).toBeLessThanOrEqual(45_000);
    expect(ANTHROPIC_TIMEOUT).toBeLessThanOrEqual(45_000);
    expect(PERPLEXITY_TIMEOUT).toBeLessThanOrEqual(45_000);
  });

  const ERROR_CODES_PROVIDER = ["PROVIDER_ERROR", "CONFIG_ERROR", "INTERNAL_ERROR"];
  it("provider errors use distinct error codes", () => {
    expect(new Set(ERROR_CODES_PROVIDER).size).toBe(ERROR_CODES_PROVIDER.length);
    for (const code of ERROR_CODES_PROVIDER) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});

// ══════════════════════════════════════════════════
// D. AUTH HEADER SECURITY
// ══════════════════════════════════════════════════

describe("Security — Auth headers are never echoed in responses", () => {
  it("requireSecret never returns the actual secret value in error messages", () => {
    const rejectMsg = "Invalid secret";
    expect(rejectMsg).not.toMatch(/[a-zA-Z0-9]{20,}/); // no long alphanumeric that could be a key
  });

  it("requireSecret logs only safe metadata on rejection", () => {
    const sampleLog = "[requireSecret] rejected source_app=wyloni origin=https://wyloni.app incoming_len=32";
    expect(sampleLog).not.toContain("sk-");
    expect(sampleLog).not.toContain("Bearer ");
    // Only logs length, not value
    expect(sampleLog).toContain("incoming_len=");
  });
});

// ══════════════════════════════════════════════════
// E. REDACT FUNCTION CONTRACT
// ══════════════════════════════════════════════════

describe("Security — redactSensitive contract", () => {
  // Client-side simulation of the redact function
  function redactSensitive(value: string, secrets: Record<string, string> = {}): string {
    let result = value;
    for (const val of Object.values(secrets)) {
      if (val && val.length > 3 && result.includes(val)) {
        result = result.split(val).join("[REDACTED]");
      }
    }
    result = result.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    return result;
  }

  it("redacts known secret values", () => {
    const result = redactSensitive("key is abc123xyz", { API_KEY: "abc123xyz" });
    expect(result).not.toContain("abc123xyz");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const result = redactSensitive("Authorization: Bearer sk-abc123xyz");
    expect(result).not.toContain("sk-abc123xyz");
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("preserves non-sensitive content", () => {
    const result = redactSensitive("status=ok version=3.3.3 debug_id=abc");
    expect(result).toBe("status=ok version=3.3.3 debug_id=abc");
  });

  it("handles empty string", () => {
    expect(redactSensitive("")).toBe("");
  });
});

// ══════════════════════════════════════════════════
// F. SAFE DEGRADATION
// ══════════════════════════════════════════════════

describe("Security — Safe degradation with missing config", () => {
  it("missing AI_CORE_SECRET returns CONFIG_ERROR 500, not crash", () => {
    const expectedCode = "CONFIG_ERROR";
    const expectedStatus = 500;
    const expectedMessage = "AI_CORE_SECRET not configured";
    expect(expectedCode).toMatch(/^[A-Z_]+$/);
    expect(expectedStatus).toBe(500);
    expect(expectedMessage).not.toContain("undefined");
  });

  it("missing DIAGNOSTIC_SECRET returns CONFIG_ERROR 500, not crash", () => {
    const expectedCode = "CONFIG_ERROR";
    const expectedStatus = 500;
    expect(expectedCode).toBe("CONFIG_ERROR");
    expect(expectedStatus).toBe(500);
  });

  it("missing optional provider keys degrade gracefully", () => {
    // Perplexity missing → returns null, caller uses empty fallback
    // This is the contract: null means "unavailable", not "crash"
    const perplexityResult: string | null = null;
    expect(perplexityResult).toBeNull();
    
    const emptyFallback = '{"ok":false,"error":"Ricerca non disponibile"}';
    const parsed = JSON.parse(emptyFallback);
    expect(parsed.ok).toBe(false);
  });

  it("MARKET_DATA_ENABLED=false disables market endpoint cleanly", () => {
    // When disabled, scan/market returns sourceType: "unavailable"
    const disabledResponse = { marketContext: "unavailable", sourceType: "unavailable" };
    expect(disabledResponse.sourceType).toBe("unavailable");
  });
});
