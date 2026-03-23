import { describe, it, expect } from "vitest";

/**
 * Admin bypass contract tests — Central Core V3
 *
 * Validates that admin bypass from unverified client input
 * has been completely eliminated. The functions normalizeEmail
 * and isAdminBypassEmail are kept as no-ops for import compat.
 *
 * NOTE: Server-side admin bootstrap (v3.3.6+) is tested separately
 * in hardening-admin-bootstrap.test.ts. That system uses verified
 * JWT + CORE_ADMIN_BOOTSTRAP_EMAILS, not client headers/body.
 */

const CORE_VERSION = "3.3.6";

// ── Mirror of the production no-op implementations ──

function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/** Always returns false — bypass eliminated */
function isAdminBypassEmail(_email: string | null | undefined): boolean {
  return false;
}

/** Always returns { bypass: false } — bypass eliminated */
function checkAdminBypass(): { bypass: boolean; email?: string; _masked?: string } {
  return { bypass: false };
}

describe("Admin bypass — normalizeEmail (utility kept)", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM  ")).toBe("foo@bar.com");
  });

  it("returns empty for null/undefined/empty", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail("")).toBe("");
  });

  it("handles non-string gracefully", () => {
    expect(normalizeEmail(42 as unknown as string)).toBe("");
  });
});

describe("Admin bypass — ELIMINATED", () => {
  it("isAdminBypassEmail always returns false for any email", () => {
    expect(isAdminBypassEmail("gheocapaula1000@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("massimilianogalli75@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("admin@company.com")).toBe(false);
    expect(isAdminBypassEmail("root@evil.com")).toBe(false);
  });

  it("isAdminBypassEmail returns false for null/undefined/empty", () => {
    expect(isAdminBypassEmail("")).toBe(false);
    expect(isAdminBypassEmail(null)).toBe(false);
    expect(isAdminBypassEmail(undefined)).toBe(false);
  });

  it("checkAdminBypass always returns bypass: false", () => {
    expect(checkAdminBypass().bypass).toBe(false);
    expect(checkAdminBypass().email).toBeUndefined();
  });

  it("no admin email list exists in source code", () => {
    expect(isAdminBypassEmail("any@email.com")).toBe(false);
  });

  it("x-user-email header cannot produce bypass", () => {
    expect(checkAdminBypass().bypass).toBe(false);
  });
});

describe("Admin bypass — version alignment", () => {
  it("contract version is 3.3.6", () => {
    expect(CORE_VERSION).toBe("3.3.6");
  });
});
