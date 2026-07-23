import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PATH = "docs/pending-migrations/20260723000000_freshness_fail_closed.sql";
const sql = readFileSync(PATH, "utf8");
const lower = sql.toLowerCase();

// Split by branch comment markers to isolate branches
const idealistaBranchStart = sql.indexOf("-- Branch 2: idealista");
const nonIdealistaBranch = sql.slice(sql.indexOf("-- Branch 1:"), idealistaBranchStart);
const idealistaBranch = sql.slice(idealistaBranchStart);

// Isolate expire function body
const expireStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.expire_padova_agency_listings");
const expireEnd = sql.indexOf("$function$;", expireStart) + "$function$;".length;
const expireFn = sql.slice(expireStart, expireEnd);

describe("Intervento 1 — freshness fail-closed migration", () => {
  it("1) expire_padova_agency_listings contains no UPDATE on padova_listings", () => {
    expect(/update\s+public\.padova_listings/i.test(expireFn)).toBe(false);
    expect(/update\s+padova_listings/i.test(expireFn)).toBe(false);
  });

  it("2) expire fn returns expired=0 and skipped_reason=provider_coverage_not_proven", () => {
    expect(expireFn).toMatch(/'expired'\s*,\s*0/);
    expect(expireFn).toMatch(/'skipped_reason'\s*,\s*'provider_coverage_not_proven'/);
  });

  it("3) Idealista branch uses ON CONFLICT ... DO UPDATE (not DO NOTHING)", () => {
    expect(idealistaBranch).toMatch(/on\s+conflict\s*\(\s*fonte\s*,\s*url\s*\)\s*do\s+update/i);
    expect(/on\s+conflict[^;]*do\s+nothing/i.test(idealistaBranch)).toBe(false);
  });

  it("4) Idealista branch sets last_seen_at=v_now and expired_at=NULL", () => {
    expect(idealistaBranch).toMatch(/last_seen_at\s*=\s*v_now/);
    expect(idealistaBranch).toMatch(/expired_at\s*=\s*NULL/);
  });

  it("5) Non-idealista branch remains intact (DO UPDATE + COALESCE merge preserved)", () => {
    expect(nonIdealistaBranch).toMatch(/lower\(portal\)\s*<>\s*'idealista'/);
    expect(nonIdealistaBranch).toMatch(/on\s+conflict\s*\(\s*fonte\s*,\s*url\s*\)\s*do\s+update/i);
    expect(nonIdealistaBranch).toMatch(/COALESCE\(EXCLUDED\.agency/);
  });

  it("6) No backfill DML present (no bare UPDATE/DELETE/INSERT outside function bodies)", () => {
    // Strip function bodies delimited by $function$ ... $function$
    const stripped = sql.replace(/\$function\$[\s\S]*?\$function\$/g, "");
    expect(/\bupdate\s+/i.test(stripped)).toBe(false);
    expect(/\bdelete\s+from\b/i.test(stripped)).toBe(false);
    expect(/\binsert\s+into\b/i.test(stripped)).toBe(false);
    // No massive un-expire
    expect(/expired_at\s*=\s*null\s+where/i.test(stripped)).toBe(false);
  });

  it("preserves SECURITY DEFINER and search_path on both functions", () => {
    const matches = sql.match(/SECURITY DEFINER/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const spMatches = sql.match(/SET search_path TO 'public'/g) ?? [];
    expect(spMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("migration is transactional", () => {
    expect(lower).toContain("begin;");
    expect(lower).toContain("commit;");
  });

  it("reports SHA-256 and line count (informational)", () => {
    const sha = createHash("sha256").update(sql).digest("hex");
    const lines = sql.split("\n").length;
    // eslint-disable-next-line no-console
    console.log(`[migration] lines=${lines} sha256=${sha}`);
    expect(sha).toHaveLength(64);
  });
});
