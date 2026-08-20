/**
 * core-proxy — server-side secret injection for civiko/property-marketing-pack.
 *
 * Invariants verified statically (no live HTTP):
 *  - The proxy reads AI_CORE_SECRET_CIVIKO from env and injects it as
 *    `x-internal-secret` only for the marketing-pack route.
 *  - The proxy sets `x-source-app: civiko` for that route.
 *  - The proxy never forwards a client-supplied `x-internal-secret`.
 *  - When the secret is missing, the proxy returns a clean envelope with
 *    code UPSTREAM_AUTH_NOT_CONFIGURED (no secret name leaked, no stack).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const proxySrc = readFileSync(
  join(process.cwd(), "supabase/functions/core-proxy/index.ts"),
  "utf-8",
);

describe("core-proxy — marketing-pack secret injection", () => {
  it("registers civiko/property-marketing-pack in the whitelist", () => {
    expect(proxySrc).toMatch(/"civiko\/property-marketing-pack"\s*:\s*"property-marketing-pack"/);
  });

  it("injects x-internal-secret from AI_CORE_SECRET_CIVIKO only for that route", () => {
    expect(proxySrc).toContain('"civiko/property-marketing-pack"');
    expect(proxySrc).toContain("CIVIKO_ONE_SECRET_ROUTES.has(normalizedEndpoint)");
    expect(proxySrc).toMatch(/Deno\.env\.get\(\s*"AI_CORE_SECRET_CIVIKO"\s*\)/);
    expect(proxySrc).toMatch(/upstreamHeaders\["x-internal-secret"\]\s*=\s*civikoSecret/);
    expect(proxySrc).toMatch(/upstreamHeaders\["x-source-app"\]\s*=/);
  });

  it("never forwards a client-supplied x-internal-secret header", () => {
    // The proxy builds upstreamHeaders from a fixed allowlist. It must not
    // read x-internal-secret from req.headers anywhere.
    expect(proxySrc).not.toMatch(/req\.headers\.get\(\s*["']x-internal-secret["']/i);
  });

  it("returns a clean standard envelope when the secret is missing", () => {
    expect(proxySrc).toMatch(/UPSTREAM_AUTH_NOT_CONFIGURED/);
    // The error message must not leak the secret name.
    const block = proxySrc.split("UPSTREAM_AUTH_NOT_CONFIGURED")[1] ?? "";
    expect(block.slice(0, 400)).not.toMatch(/AI_CORE_SECRET_CIVIKO/);
  });

  it("keeps Authorization and apikey forwarding intact", () => {
    expect(proxySrc).toMatch(/"Authorization"\s*:\s*authHeader/);
    expect(proxySrc).toMatch(/"apikey"\s*:\s*ANON_KEY/);
  });
});
