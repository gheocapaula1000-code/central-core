import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(
  resolve(__dirname, "../../docs/pending-migrations/20260723100000_freshness_rpc_acl_hardening.sql"),
  "utf8",
);

describe("freshness RPC ACL hardening migration", () => {
  it("wraps in a single BEGIN/COMMIT transaction", () => {
    expect((sql.match(/^BEGIN;/m) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;/m) || []).length).toBe(1);
  });

  it("REVOKEs from PUBLIC, anon, authenticated for expire_padova_agency_listings", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.expire_padova_agency_listings\(timestamptz\)\s+FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("REVOKEs from PUBLIC, anon, authenticated for promote_padova_collect_v2_to_listings", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.promote_padova_collect_v2_to_listings\(timestamptz\)\s+FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("GRANTs EXECUTE exclusively to service_role (no anon/authenticated GRANT)", () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.expire_padova_agency_listings\(timestamptz\)\s+TO service_role;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.promote_padova_collect_v2_to_listings\(timestamptz\)\s+TO service_role;/,
    );
    // No GRANT to anon/authenticated/PUBLIC
    expect(sql).not.toMatch(/GRANT[\s\S]*?TO[\s\S]*?\banon\b/);
    expect(sql).not.toMatch(/GRANT[\s\S]*?TO[\s\S]*?\bauthenticated\b/);
    expect(sql).not.toMatch(/GRANT[\s\S]*?TO[\s\S]*?\bPUBLIC\b/);
  });

  it("does not contain DDL/DML that mutates bodies or data", () => {
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bCASCADE\b/i);
  });

  it("does not revoke from postgres owner", () => {
    expect(sql).not.toMatch(/REVOKE[\s\S]*?FROM[\s\S]*?\bpostgres\b/);
  });
});
