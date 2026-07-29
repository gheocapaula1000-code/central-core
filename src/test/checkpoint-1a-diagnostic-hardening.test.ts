import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FN = (name: string) => resolve(process.cwd(), "supabase/functions", name, "index.ts");
const read = (name: string) => readFileSync(FN(name), "utf-8");

const PROTECTED_DIAGNOSTICS = [
  "core-cron-health-public",
  "casa-scrape-debug",
  "padova-discovery-diag",
  "debug-subito-dryrun",
  "debug-subito-schema",
];

/** Index of the first occurrence of any of the given patterns, or -1. */
function firstIndex(src: string, patterns: RegExp[]): number {
  let best = -1;
  for (const p of patterns) {
    const m = p.exec(src);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

describe("Checkpoint 1A — health is public but strictly passive", () => {
  const src = read("health");

  it("does not expose version, secret names or provider status", () => {
    expect(src).not.toMatch(/secrets_configured/);
    expect(src).not.toMatch(/api_status/);
    expect(src).not.toMatch(/check_apis/);
    expect(src).not.toMatch(/version:/);
    expect(src).not.toMatch(/_API_KEY|_API_TOKEN|SECRET/);
  });

  it("performs no external calls and no provider key reads", () => {
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/api\.openai\.com|api\.perplexity\.ai|api\.firecrawl\.dev/);
    expect(src).not.toMatch(/checkOpenAI|checkPerplexity|checkFirecrawl/);
  });

  it("does not log secret presence", () => {
    expect(src).not.toMatch(/console\.log/);
  });

  it("keeps the minimal compatible envelope", () => {
    expect(src).toMatch(/status: "healthy"/);
    expect(src).toMatch(/service: "central-core"/);
    expect(src).toMatch(/CORE_CONTRACT/);
  });

  it("returns 405 for unsupported methods and still handles OPTIONS", () => {
    expect(src).toMatch(/METHOD_NOT_ALLOWED/);
    expect(src).toMatch(/405/);
    expect(src).toMatch(/OPTIONS/);
  });

  it("keeps /manifest passive", () => {
    expect(src).toMatch(/\/manifest/);
    expect(src).not.toMatch(/check_apis=true/);
  });
});

describe("Checkpoint 1A — secret-fingerprint is neutralized", () => {
  const src = read("secret-fingerprint");

  it("reads no secret at all", () => {
    expect(src).not.toMatch(/Deno\.env\.get/);
  });

  it("has no hard-coded token and no fingerprinting", () => {
    expect(src).not.toMatch(/fp-civiko/);
    expect(src).not.toMatch(/x-fp-token/);
    expect(src).not.toMatch(/ANON_KEY_FULL/);
    expect(src).not.toMatch(/fingerprint\(/i);
    expect(src).not.toMatch(/\.slice\(/);
  });

  it("returns a generic tombstone after OPTIONS", () => {
    expect(src).toMatch(/status: 410|status: 404/);
    expect(src).toMatch(/OPTIONS/);
  });

  it("is configured with verify_jwt = true", () => {
    const cfg = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf-8");
    const block = cfg.split("[functions.secret-fingerprint]")[1] ?? "";
    expect(block.split("[functions.")[0]).toMatch(/verify_jwt\s*=\s*true/);
  });
});

describe.each(PROTECTED_DIAGNOSTICS)("Checkpoint 1A — %s is fail-closed", (fn) => {
  const src = read(fn);
  // Only the request handler body matters for ordering: top-level helper
  // declarations are not executed before the guard.
  const handler = src.slice(src.indexOf("Deno.serve("));

  it("imports and calls the shared diagnostic guard", () => {
    expect(src).toMatch(/requireDiagnosticSecret/);
    expect(src).toMatch(/from "\.\.\/_shared\/http\.ts"/);
    expect(src).toMatch(/const authFail = requireDiagnosticSecret\(req, makeDebugId\(\)\);\s*\n\s*if \(authFail\) return authFail;/);
  });

  it("does not substitute the job secret for the diagnostic guard", () => {
    const guardIdx = handler.indexOf("requireDiagnosticSecret(req");
    const jobIdx = handler.indexOf("CENTRAL_CORE_JOB_SECRET");
    if (jobIdx !== -1) expect(guardIdx).toBeLessThan(jobIdx);
  });

  it("runs the guard before any side effect", () => {
    const guardIdx = handler.indexOf("if (authFail) return authFail;");
    expect(guardIdx).toBeGreaterThan(-1);
    const sideEffects = firstIndex(handler, [
      /createClient\(\s*\n?\s*Deno\.env/,
      /\bfetch\(/,
      /getApifyToken\(\)/,
      /\.insert\(/,
      /\.upsert\(/,
      /\.update\(/,
      /\.delete\(/,
      /req\.json\(\)/,
      /\bnew URL\(req\.url\)/,
    ]);
    if (sideEffects !== -1) expect(guardIdx).toBeLessThan(sideEffects);
  });

  it("handles OPTIONS without triggering operations", () => {
    const optIdx = handler.indexOf('req.method === "OPTIONS"');
    expect(optIdx).toBeGreaterThan(-1);
    expect(optIdx).toBeLessThan(handler.indexOf("if (authFail) return authFail;"));
  });
});

describe("Checkpoint 1A — shared guard semantics", () => {
  const http = readFileSync(resolve(process.cwd(), "supabase/functions/_shared/http.ts"), "utf-8");
  const guard = http.split("export function requireDiagnosticSecret")[1].split("\nexport ")[0];

  it("fails closed when DIAGNOSTIC_SECRET is not configured", () => {
    expect(guard).toMatch(/if \(!expected\)/);
    expect(guard).toMatch(/500/);
  });

  it("rejects missing or wrong headers with 401 and no expected value", () => {
    expect(guard).toMatch(/DIAGNOSTIC_SECRET_REQUIRED/);
    expect(guard).toMatch(/DIAGNOSTIC_SECRET_REJECTED/);
    expect(guard).toMatch(/constantTimeEqual/);
    expect(guard).not.toMatch(/expected\}/);
  });
});

describe("Checkpoint 1A — no credential fragments in touched functions", () => {
  const touched = [
    "health",
    "secret-fingerprint",
    ...PROTECTED_DIAGNOSTICS,
    "provider-diagnostics",
    "padova-readiness",
  ];

  it.each(touched)("%s exposes no key preview / mask / fingerprint", (fn) => {
    const src = read(fn);
    expect(src).not.toMatch(/key_preview/);
    expect(src).not.toMatch(/stripe_key_masked/);
    expect(src).not.toMatch(/ANON_KEY_FULL/);
    expect(src).not.toMatch(/maskKey/);
    expect(src).not.toMatch(/fp-civiko/);
  });

  it("padova-readiness keeps only boolean/mode stripe fields behind the guard", () => {
    const src = read("padova-readiness");
    expect(src).toMatch(/stripe_configured/);
    expect(src).toMatch(/stripe_mode/);
    expect(src).toMatch(/stripe_webhook_configured/);
    expect(src).not.toMatch(/stripeKey\.slice/);
    expect(src).toMatch(/requireDiagnosticSecret/);
  });

  it("provider-diagnostics keeps its admin guard and logs no key fragments", () => {
    const src = read("provider-diagnostics");
    expect(src).toMatch(/isAdmin/);
    expect(src).not.toMatch(/key: maskKey/);
    expect(src).not.toMatch(/error_body/);
  });
});

describe("Checkpoint 1A — orphan test-apify-immobiliare-padova is a tombstone", () => {
  const cfg = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf-8");
  const src = read("test-apify-immobiliare-padova");

  it("exists as a neutralized function", () => {
    expect(existsSync(FN("test-apify-immobiliare-padova"))).toBe(true);
  });

  it("reads no env var and no secret", () => {
    expect(src).not.toMatch(/Deno\.env\.get/);
    expect(src).not.toMatch(/SECRET|_API_KEY|_TOKEN/);
  });

  it("performs no fetch and imports no backend client", () => {
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/supabase-js|createClient/);
  });

  it("references no provider", () => {
    expect(src).not.toMatch(/apify|firecrawl|openai|perplexity|immobiliare/i);
  });

  it("returns 410 and handles OPTIONS without side effects", () => {
    expect(src).toMatch(/status: 410/);
    expect(src).toMatch(/OPTIONS/);
    expect(src).not.toMatch(/\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
    expect(src).not.toMatch(/req\.json\(\)/);
  });

  it("is configured with verify_jwt = true", () => {
    const block = cfg.split("[functions.test-apify-immobiliare-padova]")[1] ?? "";
    expect(block.split("[functions.")[0]).toMatch(/verify_jwt\s*=\s*true/);
  });

  it("declares explicit blocks for the hardened diagnostics", () => {
    for (const fn of PROTECTED_DIAGNOSTICS) {
      expect(cfg).toContain(`[functions.${fn}]`);
    }
  });
});
