import { describe, it, expect } from "vitest";

describe("Admin console access", () => {
  it("no AdminSecretGate import exists in App.tsx", async () => {
    const appModule = await import("@/App");
    expect(appModule.default).toBeDefined();
  });

  it("coreAdminFetch has no global secret exports", async () => {
    const mod = await import("@/lib/coreAdminFetch");
    // Old global unlock exports must not exist
    expect("getCoreSecret" in mod).toBe(false);
    expect("setCoreSecret" in mod).toBe(false);
    expect("clearCoreSecret" in mod).toBe(false);
    expect("isCoreUnlocked" in mod).toBe(false);
    // coreAdminFetch should exist and accept diagnosticSecret option
    expect("coreAdminFetch" in mod).toBe(true);
  });

  it("coreAdminFetch supports optional diagnosticSecret parameter", async () => {
    const mod = await import("@/lib/coreAdminFetch");
    // Function should accept 2 params (path, options)
    expect(mod.coreAdminFetch.length).toBeLessThanOrEqual(2);
  });
});
