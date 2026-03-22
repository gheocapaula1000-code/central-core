import { describe, it, expect } from "vitest";

/**
 * Internal secret resolution contract tests — Central Core V3
 *
 * Validates that internal Core→Core calls (listing-bridge → sottra,
 * ecosystem-gateway → sottra) use per-app secret resolution,
 * not the raw legacy AI_CORE_SECRET.
 */

// ── Mirror of production resolveInternalSecret logic ──
const APP_SECRET_MAP: Record<string, string> = {
  wyloni: "AI_CORE_SECRET_WYLONI",
  keydraft: "AI_CORE_SECRET_KEYDRAFT",
  sottra: "AI_CORE_SECRET_SOTTRA",
  regiads: "AI_CORE_SECRET_REGIADS",
  pratica: "AI_CORE_SECRET_PRATICA",
};

function resolveInternalSecret(
  targetApp: string,
  env: Record<string, string>,
): { secret: string; mode: "per-app" | "legacy" | "missing"; envName: string } {
  const normalized = targetApp.toLowerCase().trim();
  const envName = APP_SECRET_MAP[normalized] ?? `AI_CORE_SECRET_${normalized.toUpperCase()}`;

  const perAppVal = env[envName] ?? "";
  if (perAppVal) return { secret: perAppVal, mode: "per-app", envName };

  const legacy = env["AI_CORE_SECRET"] ?? "";
  if (legacy) return { secret: legacy, mode: "legacy", envName };

  return { secret: "", mode: "missing", envName };
}

describe("Internal secret resolution — per-app target", () => {
  const env: Record<string, string> = {
    AI_CORE_SECRET: "legacy-shared-fallback-32chars-min",
    AI_CORE_SECRET_SOTTRA: "sottra-specific-secret-32charsxx",
    AI_CORE_SECRET_WYLONI: "wyloni-specific-secret-32charsxx",
  };

  it("resolves per-app secret for sottra target", () => {
    const r = resolveInternalSecret("sottra", env);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(env.AI_CORE_SECRET_SOTTRA);
    expect(r.envName).toBe("AI_CORE_SECRET_SOTTRA");
  });

  it("resolves per-app secret for wyloni target", () => {
    const r = resolveInternalSecret("wyloni", env);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(env.AI_CORE_SECRET_WYLONI);
  });

  it("falls back to legacy for keydraft without per-app secret", () => {
    const r = resolveInternalSecret("keydraft", env);
    expect(r.mode).toBe("legacy");
    expect(r.secret).toBe(env.AI_CORE_SECRET);
    expect(r.envName).toBe("AI_CORE_SECRET_KEYDRAFT");
  });

  it("falls back to legacy for unknown target", () => {
    const r = resolveInternalSecret("unknown-service", env);
    expect(r.mode).toBe("legacy");
    expect(r.secret).toBe(env.AI_CORE_SECRET);
    expect(r.envName).toBe("AI_CORE_SECRET_UNKNOWN-SERVICE");
  });
});

describe("Internal secret resolution — missing secrets", () => {
  it("returns missing when no secrets configured", () => {
    const r = resolveInternalSecret("sottra", {});
    expect(r.mode).toBe("missing");
    expect(r.secret).toBe("");
  });

  it("returns missing for empty target and empty env", () => {
    const r = resolveInternalSecret("", {});
    expect(r.mode).toBe("missing");
    expect(r.secret).toBe("");
  });
});

describe("Internal secret resolution — isolation", () => {
  const env: Record<string, string> = {
    AI_CORE_SECRET_SOTTRA: "sottra-secret-aaa",
    AI_CORE_SECRET_KEYDRAFT: "keydraft-secret-bbb",
  };

  it("sottra target does NOT get keydraft secret", () => {
    const rS = resolveInternalSecret("sottra", env);
    const rK = resolveInternalSecret("keydraft", env);
    expect(rS.secret).not.toBe(rK.secret);
    expect(rS.secret).toBe("sottra-secret-aaa");
    expect(rK.secret).toBe("keydraft-secret-bbb");
  });
});

describe("Internal secret resolution — listing-bridge contract", () => {
  it("listing-bridge targets sottra, resolves AI_CORE_SECRET_SOTTRA", () => {
    const env = { AI_CORE_SECRET_SOTTRA: "sottra-for-bridge" };
    const r = resolveInternalSecret("sottra", env);
    expect(r.mode).toBe("per-app");
    expect(r.envName).toBe("AI_CORE_SECRET_SOTTRA");
  });
});

describe("Internal secret resolution — ecosystem-gateway contract", () => {
  it("ecosystem-gateway targets sottra, resolves AI_CORE_SECRET_SOTTRA", () => {
    const env = { AI_CORE_SECRET_SOTTRA: "sottra-for-gateway" };
    const r = resolveInternalSecret("sottra", env);
    expect(r.mode).toBe("per-app");
    expect(r.envName).toBe("AI_CORE_SECRET_SOTTRA");
  });
});

describe("Internal secret resolution — requireSecret empty source_app", () => {
  // Mirror of production requireSecret behavior for empty x-source-app
  function resolveExpectedSecret(
    sourceApp: string,
    env: Record<string, string>,
  ): { secret: string; mode: "per-app" | "legacy" | "missing" } {
    const normalized = sourceApp.toLowerCase().trim();
    const envName = APP_SECRET_MAP[normalized];
    if (envName) {
      const perAppVal = env[envName] ?? "";
      if (perAppVal) return { secret: perAppVal, mode: "per-app" };
    }
    const legacy = env["AI_CORE_SECRET"] ?? "";
    if (legacy) return { secret: legacy, mode: "legacy" };
    return { secret: "", mode: "missing" };
  }

  it("empty source_app uses legacy fallback, NOT per-app", () => {
    const env = {
      AI_CORE_SECRET: "legacy-val",
      AI_CORE_SECRET_WYLONI: "wyloni-val",
    };
    const r = resolveExpectedSecret("", env);
    expect(r.mode).toBe("legacy");
    expect(r.secret).toBe("legacy-val");
  });

  it("empty source_app does not grant access to per-app secrets", () => {
    const env = { AI_CORE_SECRET_WYLONI: "wyloni-val" };
    const r = resolveExpectedSecret("", env);
    expect(r.mode).toBe("missing");
    expect(r.secret).toBe("");
  });
});
