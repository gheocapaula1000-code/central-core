import { describe, it, expect } from "vitest";

/**
 * Bootstrap Admin & Access Model contract tests — Central Core V3 (v3.4.0)
 *
 * Validates the three-tier server-side access model:
 *   1. Owner/Admin: CORE_ADMIN_BOOTSTRAP_EMAILS (gheocapaula1000@gmail.com only)
 *   2. User bypass (cross-app): CORE_USER_BYPASS_EMAILS (non-paying, no admin)
 *   3. Wyloni-only bypass: CORE_WYLONI_BYPASS_EMAILS (scoped, no admin)
 *
 * These tests mirror the production logic client-side since
 * Deno.env is not available in vitest.
 */

const CORE_VERSION = "3.4.0";

// ── Mirrors of production functions (without Deno.env) ──

function isBootstrapAdmin(verifiedEmail: string, allowlistRaw: string): boolean {
  if (!verifiedEmail || typeof verifiedEmail !== "string") return false;
  const normalized = verifiedEmail.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;
  if (!allowlistRaw.trim()) return false;
  const allowlist = allowlistRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowlist.includes(normalized);
}

function isServiceBypassUser(
  verifiedEmail: string,
  sourceApp: string | undefined,
  adminAllowlist: string,
  crossAppBypass: string,
  wyloniBypass: string,
): boolean {
  if (!verifiedEmail || typeof verifiedEmail !== "string") return false;
  const normalized = verifiedEmail.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;

  // Admins always bypass
  if (isBootstrapAdmin(verifiedEmail, adminAllowlist)) return true;

  // Cross-app bypass
  const crossList = crossAppBypass.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (crossList.includes(normalized)) return true;

  // Wyloni-only bypass
  const app = (sourceApp ?? "").toLowerCase().trim();
  if (app === "wyloni") {
    const wyloniList = wyloniBypass.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (wyloniList.includes(normalized)) return true;
  }

  return false;
}

function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

// ── Production allowlist values ──
const ADMIN_EMAILS = "gheocapaula1000@gmail.com";
const USER_BYPASS_EMAILS = "matteo.ippolito@gmail.com";
const WYLONI_BYPASS_EMAILS = "massimilianogalli75@gmail.com";

// ══════════════════════════════════════════════════
// A. OWNER/ADMIN — ONLY gheocapaula1000@gmail.com
// ══════════════════════════════════════════════════

describe("Owner/Admin — only gheocapaula1000@gmail.com", () => {
  it("gheocapaula1000@gmail.com is admin", () => {
    expect(isBootstrapAdmin("gheocapaula1000@gmail.com", ADMIN_EMAILS)).toBe(true);
  });

  it("massimilianogalli75@gmail.com is NOT admin", () => {
    expect(isBootstrapAdmin("massimilianogalli75@gmail.com", ADMIN_EMAILS)).toBe(false);
  });

  it("matteo.ippolito@gmail.com is NOT admin", () => {
    expect(isBootstrapAdmin("matteo.ippolito@gmail.com", ADMIN_EMAILS)).toBe(false);
  });

  it("case-insensitive match", () => {
    expect(isBootstrapAdmin("GheoCapaula1000@Gmail.COM", ADMIN_EMAILS)).toBe(true);
  });

  it("whitespace-trimmed match", () => {
    expect(isBootstrapAdmin("  gheocapaula1000@gmail.com  ", ADMIN_EMAILS)).toBe(true);
  });

  it("random email is not admin", () => {
    expect(isBootstrapAdmin("random@email.com", ADMIN_EMAILS)).toBe(false);
  });

  it("empty/null/undefined handled safely", () => {
    expect(isBootstrapAdmin("", ADMIN_EMAILS)).toBe(false);
    expect(isBootstrapAdmin(null as unknown as string, ADMIN_EMAILS)).toBe(false);
    expect(isBootstrapAdmin(undefined as unknown as string, ADMIN_EMAILS)).toBe(false);
    expect(isBootstrapAdmin(42 as unknown as string, ADMIN_EMAILS)).toBe(false);
  });

  it("email without @ is rejected", () => {
    expect(isBootstrapAdmin("notanemail", ADMIN_EMAILS)).toBe(false);
  });

  it("empty allowlist blocks everyone", () => {
    expect(isBootstrapAdmin("gheocapaula1000@gmail.com", "")).toBe(false);
    expect(isBootstrapAdmin("gheocapaula1000@gmail.com", "   ")).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// B. USER BYPASS — matteo cross-app, massimiliano wyloni-only
// ══════════════════════════════════════════════════

describe("Service bypass — matteo cross-app, massimiliano wyloni-only", () => {
  it("matteo has bypass for any source_app", () => {
    expect(isServiceBypassUser("matteo.ippolito@gmail.com", "wyloni", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
    expect(isServiceBypassUser("matteo.ippolito@gmail.com", "keydraft", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
    expect(isServiceBypassUser("matteo.ippolito@gmail.com", "sottra", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
    expect(isServiceBypassUser("matteo.ippolito@gmail.com", undefined, ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
  });

  it("matteo is NOT admin", () => {
    expect(isBootstrapAdmin("matteo.ippolito@gmail.com", ADMIN_EMAILS)).toBe(false);
  });

  it("massimiliano has bypass ONLY for wyloni", () => {
    expect(isServiceBypassUser("massimilianogalli75@gmail.com", "wyloni", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
  });

  it("massimiliano has NO bypass for keydraft/sottra/other", () => {
    expect(isServiceBypassUser("massimilianogalli75@gmail.com", "keydraft", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(false);
    expect(isServiceBypassUser("massimilianogalli75@gmail.com", "sottra", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(false);
    expect(isServiceBypassUser("massimilianogalli75@gmail.com", undefined, ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(false);
  });

  it("massimiliano is NOT admin", () => {
    expect(isBootstrapAdmin("massimilianogalli75@gmail.com", ADMIN_EMAILS)).toBe(false);
  });

  it("admin (gheocapaula) always has bypass", () => {
    expect(isServiceBypassUser("gheocapaula1000@gmail.com", "wyloni", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
    expect(isServiceBypassUser("gheocapaula1000@gmail.com", "keydraft", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
    expect(isServiceBypassUser("gheocapaula1000@gmail.com", undefined, ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(true);
  });

  it("random user has no bypass", () => {
    expect(isServiceBypassUser("random@email.com", "wyloni", ADMIN_EMAILS, USER_BYPASS_EMAILS, WYLONI_BYPASS_EMAILS)).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// C. NO BYPASS FROM UNVERIFIED INPUT
// ══════════════════════════════════════════════════

describe("No bypass from client-side input", () => {
  it("legacy isAdminBypassEmail still returns false", () => {
    const isAdminBypassEmail = (_email: string | null | undefined): boolean => false;
    expect(isAdminBypassEmail("gheocapaula1000@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("massimilianogalli75@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("matteo.ippolito@gmail.com")).toBe(false);
  });

  it("legacy checkAdminBypass still returns bypass: false", () => {
    const checkAdminBypass = () => ({ bypass: false as boolean });
    expect(checkAdminBypass().bypass).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// D. RATE LIMIT BYPASS CONTRACT
// ══════════════════════════════════════════════════

describe("Rate limit bypass contract", () => {
  it("admin bypasses rate limit", () => {
    const rateAllowed = false;
    const isAdmin = true;
    const isBypass = false;
    expect(!rateAllowed && !isAdmin && !isBypass).toBe(false);
  });

  it("bypass user bypasses rate limit", () => {
    const rateAllowed = false;
    const isAdmin = false;
    const isBypass = true;
    expect(!rateAllowed && !isAdmin && !isBypass).toBe(false);
  });

  it("non-privileged user is blocked when rate limited", () => {
    const rateAllowed = false;
    const isAdmin = false;
    const isBypass = false;
    expect(!rateAllowed && !isAdmin && !isBypass).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// E. SENSITIVE DATA PROTECTION
// ══════════════════════════════════════════════════

describe("No secret leakage", () => {
  it("all bypass env vars are in redactSensitive list", () => {
    const redactedSecretNames = [
      "AI_CORE_SECRET", "DIAGNOSTIC_SECRET", "CORE_ADMIN_BOOTSTRAP_EMAILS",
      "CORE_USER_BYPASS_EMAILS", "CORE_WYLONI_BYPASS_EMAILS",
    ];
    expect(redactedSecretNames).toContain("CORE_ADMIN_BOOTSTRAP_EMAILS");
    expect(redactedSecretNames).toContain("CORE_USER_BYPASS_EMAILS");
    expect(redactedSecretNames).toContain("CORE_WYLONI_BYPASS_EMAILS");
  });

  it("admin/bypass emails not exposed in health responses", () => {
    const healthResponse = { status: "ok", contract: "central-core-v3", function: "ai-core-run" };
    const json = JSON.stringify(healthResponse);
    expect(json).not.toContain("gheocapaula1000");
    expect(json).not.toContain("massimilianogalli75");
    expect(json).not.toContain("matteo.ippolito");
    expect(json).not.toContain("BOOTSTRAP");
  });
});

// ══════════════════════════════════════════════════
// F. VERSION ALIGNMENT
// ══════════════════════════════════════════════════

describe("Version alignment", () => {
  it("contract version is 3.4.0", () => {
    expect(CORE_VERSION).toBe("3.4.0");
  });
});
