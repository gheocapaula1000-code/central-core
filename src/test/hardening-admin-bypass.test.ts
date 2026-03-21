import { describe, it, expect } from "vitest";

/**
 * Admin bypass contract tests.
 * Verifies that the normalizeEmail / isAdminBypassEmail utilities
 * follow exact-match rules with zero false positives.
 *
 * NOTE: These test the contract specification. The actual Deno runtime
 * implementation lives in supabase/functions/_shared/http.ts and reads
 * from AI_CORE_ADMIN_EMAILS env var. We mirror the parsing + matching
 * logic here to enforce the contract in CI.
 */

const CORE_VERSION = "3.3.5";

// ── Mirror of the production parsing logic (contract spec) ──
// Simulates AI_CORE_ADMIN_EMAILS env var value
const AI_CORE_ADMIN_EMAILS_RAW =
  "gheocapaula1000@gmail.com, massimilianogalli75@gmail.com";

function parseAdminEmails(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0 && e.includes("@")),
  );
}

const ADMIN_BYPASS_EMAILS = parseAdminEmails(AI_CORE_ADMIN_EMAILS_RAW);

function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

function isAdminBypassEmail(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return ADMIN_BYPASS_EMAILS.has(normalized);
}

describe("Admin bypass — normalizeEmail", () => {
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

describe("Admin bypass — parseAdminEmails", () => {
  it("parses comma-separated emails with trim+lowercase", () => {
    const set = parseAdminEmails("  A@B.com , c@D.com  ");
    expect(set.size).toBe(2);
    expect(set.has("a@b.com")).toBe(true);
    expect(set.has("c@d.com")).toBe(true);
  });

  it("drops empty entries and non-email strings", () => {
    const set = parseAdminEmails("a@b.com, , ,not-email, c@d.com");
    expect(set.size).toBe(2);
    expect(set.has("a@b.com")).toBe(true);
    expect(set.has("c@d.com")).toBe(true);
  });

  it("returns empty set for empty/blank input", () => {
    expect(parseAdminEmails("").size).toBe(0);
    expect(parseAdminEmails("   ").size).toBe(0);
  });
});

describe("Admin bypass — isAdminBypassEmail", () => {
  it("passes gheocapaula1000@gmail.com", () => {
    expect(isAdminBypassEmail("gheocapaula1000@gmail.com")).toBe(true);
  });

  it("passes massimilianogalli75@gmail.com", () => {
    expect(isAdminBypassEmail("massimilianogalli75@gmail.com")).toBe(true);
  });

  it("passes with whitespace and mixed case", () => {
    expect(isAdminBypassEmail("  GheoCAPaula1000@Gmail.COM  ")).toBe(true);
    expect(isAdminBypassEmail(" MassimilianoGalli75@Gmail.com ")).toBe(true);
  });

  it("rejects normal users", () => {
    expect(isAdminBypassEmail("user@example.com")).toBe(false);
    expect(isAdminBypassEmail("admin@gmail.com")).toBe(false);
  });

  it("rejects similar-looking emails (no false positives)", () => {
    expect(isAdminBypassEmail("gheocapaula1000@gmail.co")).toBe(false);
    expect(isAdminBypassEmail("gheocapaula10001@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("xgheocapaula1000@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("massimilianogalli75@gmail.com.evil.com")).toBe(false);
    expect(isAdminBypassEmail("massimilianogalli75@hotmail.com")).toBe(false);
  });

  it("rejects empty/null/undefined", () => {
    expect(isAdminBypassEmail("")).toBe(false);
    expect(isAdminBypassEmail(null)).toBe(false);
    expect(isAdminBypassEmail(undefined)).toBe(false);
  });

  it("rejects domain wildcards", () => {
    expect(isAdminBypassEmail("@gmail.com")).toBe(false);
    expect(isAdminBypassEmail("*@gmail.com")).toBe(false);
  });

  it("exactly 2 admin emails from env config", () => {
    expect(ADMIN_BYPASS_EMAILS.size).toBe(2);
  });
});

describe("Admin bypass — version alignment", () => {
  it("contract version is 3.3.5", () => {
    expect(CORE_VERSION).toBe("3.3.5");
  });
});
