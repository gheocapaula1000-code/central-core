import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isOriginAllowed } from "@/lib/httpUtils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P0 backend hardening checks (Mapbox fallback removal, Apify token
 * centralization, CORS origin policy). The tests run in a Node/Vitest
 * context, so we assert against the source code and the pure
 * client-side mirror of isOriginAllowed.
 */

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("P0 — Mapbox placeholder fallback removed", () => {
  const src = read("supabase/functions/civiko-property-from-photo/index.ts");

  it("does not contain a hard-coded pk.* placeholder token", () => {
    expect(src).not.toMatch(/pk\.[A-Za-z0-9_-]{10,}/);
  });

  it("warns and skips heatmap when MAPBOX_API_KEY is missing", () => {
    expect(src).toMatch(/MAPBOX_API_KEY non configurata/);
    expect(src).toMatch(/Deno\.env\.get\("MAPBOX_API_KEY"\)/);
  });
});

describe("P0 — Apify token centralization", () => {
  const helper = read("supabase/functions/_shared/apify.ts");

  it("prefers APIFY_API_TOKEN as canonical", () => {
    expect(helper).toMatch(/APIFY_API_TOKEN/);
    expect(helper).toMatch(/const CANONICAL = "APIFY_API_TOKEN"/);
  });

  it("keeps legacy fallbacks documented as deprecated", () => {
    expect(helper).toMatch(/APIFY_TOKEN/);
    expect(helper).toMatch(/APIFY_API_KEY/);
    expect(helper).toMatch(/legacy/i);
  });

  it("call sites use getApifyToken() instead of raw Deno.env reads", () => {
    const callSites = [
      "supabase/functions/sottra/scan.ts",
      "supabase/functions/civiko-property-from-photo/apifyPhotoEnrichment.ts",
      "supabase/functions/civiko-opportunity-engine/index.ts",
      "supabase/functions/civiko-radar-veneto/portalScrapers.ts",
      "supabase/functions/civiko-radar-veneto/apify/apifyClient.ts",
      "supabase/functions/civiko-radar-veneto/apify/apifyAdapter.ts",
    ];
    for (const path of callSites) {
      const code = read(path);
      expect(code, path).toMatch(/getApifyToken/);
    }
  });
});

describe("P0 — CORS origin policy", () => {
  it("allows configured production PWA domain", () => {
    expect(isOriginAllowed("https://civikoone.com")).toBe(true);
    expect(isOriginAllowed("https://www.civikoone.com")).toBe(true);
    expect(isOriginAllowed("https://ueradar.com")).toBe(true);
    expect(isOriginAllowed("https://www.ueradar.com")).toBe(true);
  });

  it("edge CORS helper hardcodes UERADAR hosts without replacing CORE_ALLOWED_ORIGINS", () => {
    const http = read("supabase/functions/_shared/http.ts");
    expect(http).toContain('"ueradar.com"');
    expect(http).toContain('"www.ueradar.com"');
    expect(http).toContain('"keydraft.app"');
    expect(http).toContain('"wyloni.app"');
    expect(http).toContain('"sottra.app"');
    expect(http).toMatch(/Deno\.env\.get\("CORE_ALLOWED_ORIGINS"\)/);
  });

  it("rejects disallowed origins (would yield 403 in edge functions)", () => {
    expect(isOriginAllowed("https://evil.example")).toBe(false);
  });

  it("server-to-server requests without Origin are handled by the proxy explicitly", () => {
    const proxy = read("supabase/functions/core-proxy/index.ts");
    expect(proxy).toMatch(/if \(origin && !isOriginAllowed\(origin\)\)/);
    expect(proxy).toMatch(/ORIGIN_NOT_ALLOWED/);
  });

  it("core-proxy no longer hard-codes Access-Control-Allow-Origin: *", () => {
    const proxy = read("supabase/functions/core-proxy/index.ts");
    expect(proxy).not.toMatch(/Access-Control-Allow-Origin"\s*:\s*"\*"/);
  });
});

describe("P0 — CORE_ALLOWED_ORIGINS env parsing", () => {
  const ORIGINAL = process.env.CORE_ALLOWED_ORIGINS;
  beforeEach(() => { /* noop — isOriginAllowed in client mirror does not read env */ });
  afterEach(() => { process.env.CORE_ALLOWED_ORIGINS = ORIGINAL; });

  it("client mirror still gates unknown hosts via the allowedOrigins param", () => {
    expect(isOriginAllowed("https://partner.example", ["https://partner.example"])).toBe(true);
    expect(isOriginAllowed("https://partner.example", ["https://other.example"])).toBe(false);
  });
});
