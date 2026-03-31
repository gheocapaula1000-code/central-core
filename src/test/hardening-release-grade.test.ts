/**
 * Release-Grade Hardening Tests — Central Core V3
 *
 * Tests edge function auth model consistency, artifact hygiene,
 * contract stability, fail-closed behavior, and secret safety.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

// ══════════════════════════════════════════════════════════════
// A. Edge Function Auth Model — enforceOriginPolicy consistency
// ══════════════════════════════════════════════════════════════

describe("Edge Function Auth Model — origin policy", () => {
  const functionDirs = [
    "ai-core-run",
    "sottra",
    "ecosystem-gateway",
    "viral-core",
    "listing-bridge",
    "omi-import",
    "omi-import-storage",
    "istat-ispra-import",
    "omi-geometry-import",
    "health",
  ];

  for (const fn of functionDirs) {
    const indexPath = path.join(root, "supabase/functions", fn, "index.ts");
    if (!fs.existsSync(indexPath)) continue;
    const code = fs.readFileSync(indexPath, "utf-8");

    it(`${fn}/index.ts imports enforceOriginPolicy or handleOptions`, () => {
      const hasOriginPolicy = code.includes("enforceOriginPolicy");
      const hasHandleOptions = code.includes("handleOptions");
      expect(hasOriginPolicy || hasHandleOptions).toBe(true);
    });
  }

  // Functions that accept POST must use enforceOriginPolicy
  const postFunctions = [
    "ai-core-run",
    "sottra",
    "ecosystem-gateway",
    "viral-core",
    "listing-bridge",
    "omi-import",
    "omi-import-storage",
    "istat-ispra-import",
    "omi-geometry-import",
  ];

  for (const fn of postFunctions) {
    const indexPath = path.join(root, "supabase/functions", fn, "index.ts");
    if (!fs.existsSync(indexPath)) continue;
    const code = fs.readFileSync(indexPath, "utf-8");

    it(`${fn}/index.ts calls enforceOriginPolicy`, () => {
      expect(code).toContain("enforceOriginPolicy");
    });

    it(`${fn}/index.ts calls requireSecret`, () => {
      expect(code).toContain("requireSecret");
    });
  }
});

// ══════════════════════════════════════════════════════════════
// B. Edge Function Auth Model — requireSecret uses constant-time
// ══════════════════════════════════════════════════════════════

describe("Edge Function Auth — shared http.ts security", () => {
  const httpTs = fs.readFileSync(
    path.join(root, "supabase/functions/_shared/http.ts"),
    "utf-8",
  );

  it("uses constantTimeEqual for secret comparison", () => {
    expect(httpTs).toContain("constantTimeEqual");
  });

  it("isAdminBypassEmail always returns false", () => {
    expect(httpTs).toContain("return false");
    expect(httpTs).toMatch(/isAdminBypassEmail.*return false/s);
  });

  it("checkAdminBypass always returns { bypass: false }", () => {
    expect(httpTs).toContain("bypass: false");
  });

  it("redactSensitive covers all critical secret names", () => {
    const criticalSecrets = [
      "AI_CORE_SECRET",
      "DIAGNOSTIC_SECRET",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CORE_ADMIN_BOOTSTRAP_EMAILS",
    ];
    for (const s of criticalSecrets) {
      expect(httpTs).toContain(`"${s}"`);
    }
  });

  it("fail-closed on missing secret config (returns 500 CONFIG_ERROR)", () => {
    expect(httpTs).toContain("CONFIG_ERROR");
  });
});

// ══════════════════════════════════════════════════════════════
// C. Contract Stability — envelope shape
// ══════════════════════════════════════════════════════════════

describe("Contract Stability — envelope", () => {
  const httpTs = fs.readFileSync(
    path.join(root, "supabase/functions/_shared/http.ts"),
    "utf-8",
  );

  it("ok() returns { ok: true, data, warnings, debug_id }", () => {
    expect(httpTs).toMatch(/ok:\s*true/);
    expect(httpTs).toContain("data");
    expect(httpTs).toContain("warnings");
    expect(httpTs).toContain("debug_id");
  });

  it("fail() returns { ok: false, data: null, error: { code, message } }", () => {
    expect(httpTs).toMatch(/ok:\s*false/);
    expect(httpTs).toContain("data: null");
    expect(httpTs).toContain("error:");
    expect(httpTs).toContain("code");
    expect(httpTs).toContain("message");
  });

  it("identity headers include all required fields", () => {
    expect(httpTs).toContain("X-Core-Version");
    expect(httpTs).toContain("X-Core-Function");
    expect(httpTs).toContain("X-Core-Route");
    expect(httpTs).toContain("X-Core-Contract");
  });
});

// ══════════════════════════════════════════════════════════════
// D. Artifact Hygiene — verify scripts exist and are executable
// ══════════════════════════════════════════════════════════════

describe("Artifact Hygiene — scripts and docs", () => {
  it("verify-secrets.sh exists", () => {
    expect(fs.existsSync(path.join(root, "scripts/verify-secrets.sh"))).toBe(true);
  });

  it("verify-package.sh exists", () => {
    expect(fs.existsSync(path.join(root, "scripts/verify-package.sh"))).toBe(true);
  });

  it("audit-release.sh exists", () => {
    expect(fs.existsSync(path.join(root, "scripts/audit-release.sh"))).toBe(true);
  });

  it("verify-package.sh checks for edge-function-auth-matrix.md", () => {
    const script = fs.readFileSync(path.join(root, "scripts/verify-package.sh"), "utf-8");
    expect(script).toContain("edge-function-auth-matrix.md");
  });

  it("verify-package.sh checks for junk files", () => {
    const script = fs.readFileSync(path.join(root, "scripts/verify-package.sh"), "utf-8");
    expect(script).toContain("dump");
    expect(script).toContain("bak");
  });

  it("edge-function-auth-matrix.md exists", () => {
    expect(fs.existsSync(path.join(root, "docs/edge-function-auth-matrix.md"))).toBe(true);
  });

  it("release-acceptance-checklist.md contains BLOCKER severity", () => {
    const checklist = fs.readFileSync(path.join(root, "docs/release-acceptance-checklist.md"), "utf-8");
    expect(checklist).toContain("BLOCKER");
    expect(checklist).toContain("CRITICAL");
    expect(checklist).toContain("IMPORTANT");
    expect(checklist).toContain("IMPROVEMENT");
  });

  it("release-acceptance-checklist.md has PASS/FAIL verdict", () => {
    const checklist = fs.readFileSync(path.join(root, "docs/release-acceptance-checklist.md"), "utf-8");
    expect(checklist).toContain("**PASS**");
    expect(checklist).toContain("**FAIL**");
  });
});

// ══════════════════════════════════════════════════════════════
// E. Config.toml — all functions listed with verify_jwt = false
// ══════════════════════════════════════════════════════════════

describe("Config.toml — verify_jwt consistency", () => {
  const configToml = fs.readFileSync(path.join(root, "supabase/config.toml"), "utf-8");

  const expectedFunctions = [
    "ai-core-run",
    "health",
    "sottra",
    "omi-import",
    "omi-import-storage",
    "istat-ispra-import",
    "omi-geometry-import",
    "ecosystem-gateway",
    "viral-core",
    "listing-bridge",
  ];

  for (const fn of expectedFunctions) {
    it(`${fn} is listed in config.toml`, () => {
      expect(configToml).toContain(`[functions.${fn}]`);
    });
  }
});

// ══════════════════════════════════════════════════════════════
// F. Version Consistency
// ══════════════════════════════════════════════════════════════

describe("Version Consistency", () => {
  const httpTs = fs.readFileSync(
    path.join(root, "supabase/functions/_shared/http.ts"),
    "utf-8",
  );
  const changelog = fs.readFileSync(path.join(root, "docs/changelog.md"), "utf-8");

  it("CORE_VERSION in http.ts matches latest changelog entry", () => {
    const versionMatch = httpTs.match(/CORE_VERSION\s*=\s*"([^"]+)"/);
    expect(versionMatch).not.toBeNull();
    const coreVersion = versionMatch![1];
    // Changelog should contain this version
    expect(changelog).toContain(`[${coreVersion}]`);
  });

  it("contract-registry.md references current CORE_VERSION", () => {
    const registry = fs.readFileSync(path.join(root, "docs/contract-registry.md"), "utf-8");
    const versionMatch = httpTs.match(/CORE_VERSION\s*=\s*"([^"]+)"/);
    const coreVersion = versionMatch![1];
    expect(registry).toContain(coreVersion);
  });
});

// ══════════════════════════════════════════════════════════════
// G. Secret Safety — no hardcoded secrets in edge functions
// ══════════════════════════════════════════════════════════════

describe("Secret Safety — no hardcoded secrets in functions", () => {
  const functionsDir = path.join(root, "supabase/functions");

  function getAllTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        files.push(...getAllTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  const tsFiles = getAllTsFiles(functionsDir);

  it("no function file contains a hardcoded OpenAI key pattern", () => {
    for (const f of tsFiles) {
      const content = fs.readFileSync(f, "utf-8");
      expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    }
  });

  it("no function file contains console.log of a secret env var value", () => {
    for (const f of tsFiles) {
      const content = fs.readFileSync(f, "utf-8");
      // Check for patterns like console.log(Deno.env.get("SECRET"))
      expect(content).not.toMatch(/console\.log\(.*Deno\.env\.get\(/);
    }
  });
});
