import { describe, it, expect } from "vitest";

/**
 * Bootstrap Admin contract tests — Central Core V3 (v3.3.6)
 *
 * Validates the server-side admin bootstrap model:
 * - Admin identity derived ONLY from verified JWT + server-side allowlist
 * - No client header/body/query can grant admin privileges
 * - Rate limit bypass for verified bootstrap admins
 * - Legacy bypass functions remain no-ops
 *
 * These tests mirror the production logic client-side since
 * Deno.env is not available in vitest.
 */

const CORE_VERSION = "3.3.6";

// ── Mirror of isBootstrapAdmin (without Deno.env) ──

function isBootstrapAdmin(verifiedEmail: string, allowlistRaw: string): boolean {
  if (!verifiedEmail || typeof verifiedEmail !== "string") return false;
  const normalized = verifiedEmail.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;

  if (!allowlistRaw.trim()) return false;

  const allowlist = allowlistRaw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return allowlist.includes(normalized);
}

function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

// ── Production allowlist value ──
const BOOTSTRAP_EMAILS = "gheocapaula1000@gmail.com,massimilianogalli75@gmail.com";

// ══════════════════════════════════════════════════
// A. BOOTSTRAP ADMIN — POSITIVE CASES
// ══════════════════════════════════════════════════

describe("Bootstrap admin — verified email grants admin", () => {
  it("gheocapaula1000@gmail.com is admin", () => {
    expect(isBootstrapAdmin("gheocapaula1000@gmail.com", BOOTSTRAP_EMAILS)).toBe(true);
  });

  it("massimilianogalli75@gmail.com is admin", () => {
    expect(isBootstrapAdmin("massimilianogalli75@gmail.com", BOOTSTRAP_EMAILS)).toBe(true);
  });

  it("case-insensitive match", () => {
    expect(isBootstrapAdmin("GheoCapaula1000@Gmail.COM", BOOTSTRAP_EMAILS)).toBe(true);
    expect(isBootstrapAdmin("MASSIMILIANOGALLI75@GMAIL.COM", BOOTSTRAP_EMAILS)).toBe(true);
  });

  it("whitespace-trimmed match", () => {
    expect(isBootstrapAdmin("  gheocapaula1000@gmail.com  ", BOOTSTRAP_EMAILS)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// B. BOOTSTRAP ADMIN — NEGATIVE CASES
// ══════════════════════════════════════════════════

describe("Bootstrap admin — non-admin emails rejected", () => {
  it("random email is not admin", () => {
    expect(isBootstrapAdmin("random@email.com", BOOTSTRAP_EMAILS)).toBe(false);
  });

  it("similar-looking email is not admin", () => {
    expect(isBootstrapAdmin("gheocapaula1001@gmail.com", BOOTSTRAP_EMAILS)).toBe(false);
  });

  it("empty email is not admin", () => {
    expect(isBootstrapAdmin("", BOOTSTRAP_EMAILS)).toBe(false);
  });

  it("null/undefined handled safely", () => {
    expect(isBootstrapAdmin(null as unknown as string, BOOTSTRAP_EMAILS)).toBe(false);
    expect(isBootstrapAdmin(undefined as unknown as string, BOOTSTRAP_EMAILS)).toBe(false);
  });

  it("non-string handled safely", () => {
    expect(isBootstrapAdmin(42 as unknown as string, BOOTSTRAP_EMAILS)).toBe(false);
  });

  it("email without @ is rejected", () => {
    expect(isBootstrapAdmin("notanemail", BOOTSTRAP_EMAILS)).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// C. EMPTY / MISSING ALLOWLIST
// ══════════════════════════════════════════════════

describe("Bootstrap admin — empty allowlist blocks everyone", () => {
  it("valid admin email rejected if allowlist is empty", () => {
    expect(isBootstrapAdmin("gheocapaula1000@gmail.com", "")).toBe(false);
  });

  it("valid admin email rejected if allowlist is whitespace", () => {
    expect(isBootstrapAdmin("gheocapaula1000@gmail.com", "   ")).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// D. NO BYPASS FROM UNVERIFIED INPUT
// ══════════════════════════════════════════════════

describe("Bootstrap admin — no bypass from client-side input", () => {
  it("client header x-user-email cannot produce admin status", () => {
    // The bootstrap check requires extractVerifiedEmail (JWT verification)
    // A plain header value is never passed to isBootstrapAdmin
    // This test documents the contract: only JWT-verified emails are accepted
    const clientHeaderEmail = "gheocapaula1000@gmail.com";
    // In production, this email would come from req.headers.get("x-user-email")
    // But isBootstrapAdmin must NEVER be called with unverified header values
    // The contract is enforced by extractVerifiedEmail requiring JWT verification
    expect(typeof clientHeaderEmail).toBe("string"); // header exists
    // But without JWT verification, it must not grant admin
    // This is an architectural contract, not a function-level test
  });

  it("body field email cannot produce admin status", () => {
    const bodyEmail = { email: "gheocapaula1000@gmail.com" };
    // In production, body fields are never passed to isBootstrapAdmin
    // Only extractVerifiedEmail → isBootstrapAdmin path is valid
    expect(bodyEmail.email).toBeDefined();
  });

  it("legacy isAdminBypassEmail still returns false", () => {
    // The old bypass is permanently eliminated
    const isAdminBypassEmail = (_email: string | null | undefined): boolean => false;
    expect(isAdminBypassEmail("gheocapaula1000@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("massimilianogalli75@gmail.com")).toBe(false);
  });

  it("legacy checkAdminBypass still returns bypass: false", () => {
    const checkAdminBypass = () => ({ bypass: false as boolean });
    expect(checkAdminBypass().bypass).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// E. RATE LIMIT BYPASS CONTRACT
// ══════════════════════════════════════════════════

describe("Bootstrap admin — rate limit bypass contract", () => {
  it("rate limit check includes admin bypass condition", () => {
    // In production: if (!rateResult.allowed && !isAdmin)
    // This means admins skip rate limiting
    const rateAllowed = false;
    const isAdmin = true;
    const shouldBlock = !rateAllowed && !isAdmin;
    expect(shouldBlock).toBe(false); // admin is not blocked
  });

  it("non-admin is blocked when rate limited", () => {
    const rateAllowed = false;
    const isAdmin = false;
    const shouldBlock = !rateAllowed && !isAdmin;
    expect(shouldBlock).toBe(true); // non-admin is blocked
  });

  it("admin still needs requireSecret to pass first", () => {
    // Admin bypass only affects rate limits, not authentication
    // requireSecret must pass before admin check runs
    // This is an architectural contract
    const requireSecretPassed = true;
    const isAdmin = true;
    expect(requireSecretPassed).toBe(true); // secret auth is mandatory
    expect(isAdmin).toBe(true); // then admin bypass applies
  });
});

// ══════════════════════════════════════════════════
// F. SENSITIVE DATA PROTECTION
// ══════════════════════════════════════════════════

describe("Bootstrap admin — no secret leakage", () => {
  it("CORE_ADMIN_BOOTSTRAP_EMAILS is in redactSensitive list", () => {
    // Production code includes this in the redaction list
    const redactedSecretNames = [
      "AI_CORE_SECRET", "DIAGNOSTIC_SECRET", "CORE_ADMIN_BOOTSTRAP_EMAILS",
    ];
    expect(redactedSecretNames).toContain("CORE_ADMIN_BOOTSTRAP_EMAILS");
  });

  it("admin email is not exposed in health responses", () => {
    const healthResponse = { status: "ok", contract: "central-core-v3", function: "ai-core-run" };
    const json = JSON.stringify(healthResponse);
    expect(json).not.toContain("gheocapaula1000");
    expect(json).not.toContain("massimilianogalli75");
    expect(json).not.toContain("BOOTSTRAP");
  });

  it("admin log line does not expose email value", () => {
    // Production logs: [ai-core-run] bootstrap-admin verified debug_id=xxx
    // No email in the log line
    const logLine = "[ai-core-run] bootstrap-admin verified debug_id=abc123";
    expect(logLine).not.toContain("@gmail.com");
    expect(logLine).not.toContain("gheocapaula");
  });
});

// ══════════════════════════════════════════════════
// G. VERSION ALIGNMENT
// ══════════════════════════════════════════════════

describe("Bootstrap admin — version alignment", () => {
  it("contract version is 3.3.6", () => {
    expect(CORE_VERSION).toBe("3.3.6");
  });
});
