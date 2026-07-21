// Static guarantees for the first-phase hardening of padova-contendibili-list.
// Verifies that both server-to-server gates (shared secret + x-workspace-id)
// run BEFORE any body parsing, Supabase client creation, or DB query.
// The zone-isolation filter is intentionally NOT covered here: it belongs
// to the next hardening step.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../supabase/functions/padova-contendibili-list/index.ts"),
  "utf8",
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("padova-contendibili-list — gate order", () => {
  it("handles OPTIONS before any gate runs", () => {
    const idxOptions = SRC.indexOf('req.method === "OPTIONS"');
    const idxSecret = SRC.indexOf("requireSecret(req, did)");
    expect(idxOptions).toBeGreaterThan(-1);
    expect(idxSecret).toBeGreaterThan(idxOptions);
  });

  it("calls requireSecret before body parsing, createClient, and any .from()", () => {
    const idxSecret = SRC.indexOf("requireSecret(req, did)");
    const idxBody = SRC.indexOf("await req.json()");
    const idxCreate = SRC.indexOf("createClient(");
    const idxFrom = SRC.indexOf(".from(");
    expect(idxSecret).toBeGreaterThan(-1);
    expect(idxBody).toBeGreaterThan(idxSecret);
    expect(idxCreate).toBeGreaterThan(idxSecret);
    expect(idxFrom).toBeGreaterThan(idxSecret);
  });

  it("returns the secret-failure Response immediately with no further work", () => {
    expect(SRC).toMatch(/const\s+secretFail\s*=\s*requireSecret\(req,\s*did\);\s*\n\s*if\s*\(secretFail\)\s*return\s+secretFail;/);
  });

  it("reads workspace identity EXCLUSIVELY from x-workspace-id header", () => {
    expect(SRC).toMatch(/req\.headers\.get\(["']x-workspace-id["']\)/);
    // Never sources workspace_id from body or query
    expect(SRC).not.toMatch(/body\.workspace_id/);
    expect(SRC).not.toMatch(/bodyPayload\.workspace_id/);
    expect(SRC).not.toMatch(/searchParams\.get\(["']workspace_id["']\)/);
  });

  it("validates x-workspace-id as UUID and fails-closed before DB access", () => {
    expect(SRC).toContain("UUID_RE.test(workspaceId)");
    expect(SRC).toContain("WORKSPACE_REQUIRED");
    // The workspace gate must sit between requireSecret and body parsing.
    const idxSecret = SRC.indexOf("requireSecret(req, did)");
    const idxUuid = SRC.indexOf("UUID_RE.test(workspaceId)");
    const idxBody = SRC.indexOf("await req.json()");
    expect(idxUuid).toBeGreaterThan(idxSecret);
    expect(idxBody).toBeGreaterThan(idxUuid);
  });

  it("workspace failure envelope matches padova-privati-list shape (401 + ok:false + code)", () => {
    expect(SRC).toMatch(/status:\s*401/);
    expect(SRC).toMatch(/"WORKSPACE_REQUIRED"/);
    expect(SRC).toMatch(/ok:\s*false/);
  });

  it("does not silently accept a body/query workspace_id as substitute for the header", () => {
    // A hypothetical fallback like `workspaceId ?? body.workspace_id` MUST NOT exist.
    expect(SRC).not.toMatch(/workspaceId\s*\|\|\s*body/);
    expect(SRC).not.toMatch(/workspaceId\s*\?\?\s*body/);
  });

  it("preserves the pre-existing response shape for the success path", () => {
    // Success path (still guarded by both gates) keeps items/total/hot_3plus/diagnostics.
    expect(SRC).toContain("items: filtered");
    expect(SRC).toContain("hot_3plus");
    expect(SRC).toContain("diagnostics");
  });

  it("preserves CORS contract for x-internal-secret and x-source-app", () => {
    expect(SRC).toMatch(/Access-Control-Allow-Headers[^\n]*x-internal-secret/);
    expect(SRC).toMatch(/Access-Control-Allow-Headers[^\n]*x-source-app/);
  });
});

describe("padova-contendibili-list — UUID_RE behaviour", () => {
  it("accepts a canonical UUID", () => {
    expect(UUID_RE.test("11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  it("rejects malformed workspace identifiers", () => {
    for (const bad of ["", "not-a-uuid", "12345", "workspace-1", "'; DROP TABLE"]) {
      expect(UUID_RE.test(bad)).toBe(false);
    }
  });
});
