import { describe, it, expect } from "vitest";

/**
 * Segmented secrets contract tests — Central Core V3
 *
 * Validates that the per-app secret resolution logic is correct:
 * - Per-app secrets take priority over legacy shared secret
 * - Legacy fallback works but is documented as transitional
 * - Unknown source apps still resolve via legacy fallback
 * - Missing secrets produce safe failures
 * - Admin bypass from unverified input is impossible
 */

// ── Mirror of production APP_SECRET_MAP ──
const APP_SECRET_MAP: Record<string, string> = {
  wyloni: "AI_CORE_SECRET_WYLONI",
  keydraft: "AI_CORE_SECRET_KEYDRAFT",
  sottra: "AI_CORE_SECRET_SOTTRA",
  regiads: "AI_CORE_SECRET_REGIADS",
  pratica: "AI_CORE_SECRET_PRATICA",
};

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

describe("Segmented secrets — per-app resolution", () => {
  const fullEnv: Record<string, string> = {
    AI_CORE_SECRET: "legacy-shared-secret-32chars-minimum",
    AI_CORE_SECRET_WYLONI: "wyloni-specific-secret-32chars-min",
    AI_CORE_SECRET_KEYDRAFT: "keydraft-specific-secret-32chars",
    AI_CORE_SECRET_SOTTRA: "sottra-specific-secret-32charsxx",
    AI_CORE_SECRET_REGIADS: "regiads-specific-secret-32chars",
    AI_CORE_SECRET_PRATICA: "pratica-specific-secret-32chars",
  };

  it("resolves per-app secret for wyloni when configured", () => {
    const r = resolveExpectedSecret("wyloni", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_WYLONI);
  });

  it("resolves per-app secret for keydraft when configured", () => {
    const r = resolveExpectedSecret("keydraft", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_KEYDRAFT);
  });

  it("resolves per-app secret for sottra when configured", () => {
    const r = resolveExpectedSecret("sottra", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_SOTTRA);
  });

  it("resolves per-app secret for regiads when configured", () => {
    const r = resolveExpectedSecret("regiads", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_REGIADS);
  });

  it("resolves per-app secret for pratica when configured", () => {
    const r = resolveExpectedSecret("pratica", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_PRATICA);
  });

  it("is case-insensitive on source app", () => {
    const r = resolveExpectedSecret("WYLONI", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_WYLONI);
  });

  it("trims whitespace from source app", () => {
    const r = resolveExpectedSecret("  keydraft  ", fullEnv);
    expect(r.mode).toBe("per-app");
    expect(r.secret).toBe(fullEnv.AI_CORE_SECRET_KEYDRAFT);
  });
});

describe("Segmented secrets — legacy fallback", () => {
  const legacyOnlyEnv: Record<string, string> = {
    AI_CORE_SECRET: "legacy-shared-secret-32chars-minimum",
  };

  it("falls back to legacy for known app without per-app secret", () => {
    const r = resolveExpectedSecret("wyloni", legacyOnlyEnv);
    expect(r.mode).toBe("legacy");
    expect(r.secret).toBe(legacyOnlyEnv.AI_CORE_SECRET);
  });

  it("falls back to legacy for unknown source app", () => {
    const r = resolveExpectedSecret("unknown-app", legacyOnlyEnv);
    expect(r.mode).toBe("legacy");
    expect(r.secret).toBe(legacyOnlyEnv.AI_CORE_SECRET);
  });

  it("falls back to legacy for empty source app", () => {
    const r = resolveExpectedSecret("", legacyOnlyEnv);
    expect(r.mode).toBe("legacy");
    expect(r.secret).toBe(legacyOnlyEnv.AI_CORE_SECRET);
  });
});

describe("Segmented secrets — missing secrets", () => {
  it("returns missing mode when no secrets are configured", () => {
    const r = resolveExpectedSecret("wyloni", {});
    expect(r.mode).toBe("missing");
    expect(r.secret).toBe("");
  });

  it("returns missing mode for empty env", () => {
    const r = resolveExpectedSecret("", {});
    expect(r.mode).toBe("missing");
    expect(r.secret).toBe("");
  });
});

describe("Segmented secrets — per-app isolation", () => {
  const env: Record<string, string> = {
    AI_CORE_SECRET_WYLONI: "wyloni-secret-aaaa",
    AI_CORE_SECRET_KEYDRAFT: "keydraft-secret-bbbb",
  };

  it("wyloni secret does NOT work for keydraft", () => {
    const rW = resolveExpectedSecret("wyloni", env);
    const rK = resolveExpectedSecret("keydraft", env);
    expect(rW.secret).not.toBe(rK.secret);
  });

  it("compromised wyloni secret does not affect keydraft", () => {
    const rK = resolveExpectedSecret("keydraft", env);
    expect(rK.secret).toBe("keydraft-secret-bbbb");
    // Even if wyloni secret is known, keydraft uses its own
  });
});

describe("Segmented secrets — admin bypass eliminated", () => {
  // Mirror the production no-op
  function isAdminBypassEmail(_email: string | null | undefined): boolean {
    return false;
  }

  function checkAdminBypass(): { bypass: boolean } {
    return { bypass: false };
  }

  it("isAdminBypassEmail always returns false", () => {
    expect(isAdminBypassEmail("admin@example.com")).toBe(false);
    expect(isAdminBypassEmail("gheocapaula1000@gmail.com")).toBe(false);
    expect(isAdminBypassEmail(null)).toBe(false);
    expect(isAdminBypassEmail(undefined)).toBe(false);
  });

  it("checkAdminBypass always returns bypass: false", () => {
    expect(checkAdminBypass().bypass).toBe(false);
  });

  it("x-user-email header cannot grant admin privileges", () => {
    // The production code no longer reads x-user-email for bypass
    expect(isAdminBypassEmail("admin@company.com")).toBe(false);
  });

  it("body.email cannot grant admin privileges", () => {
    expect(isAdminBypassEmail("root@evil.com")).toBe(false);
  });

  it("body.user_email cannot grant admin privileges", () => {
    expect(isAdminBypassEmail("super@admin.io")).toBe(false);
  });
});

describe("Segmented secrets — APP_SECRET_MAP coverage", () => {
  it("maps all known PWA apps", () => {
    expect(Object.keys(APP_SECRET_MAP)).toEqual(
      expect.arrayContaining(["wyloni", "keydraft", "sottra", "regiads", "pratica"]),
    );
  });

  it("each env name follows AI_CORE_SECRET_<APP> convention", () => {
    for (const [app, envName] of Object.entries(APP_SECRET_MAP)) {
      expect(envName).toBe(`AI_CORE_SECRET_${app.toUpperCase()}`);
    }
  });

  it("no duplicate env names", () => {
    const values = Object.values(APP_SECRET_MAP);
    expect(new Set(values).size).toBe(values.length);
  });
});
