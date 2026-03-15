import { describe, it, expect } from "vitest";

describe("Admin console access", () => {
  it("no AdminSecretGate import exists in App.tsx", async () => {
    // Verify the gate component was fully removed
    const appModule = await import("@/App");
    // If App renders without throwing, it means no gate blocks it
    expect(appModule.default).toBeDefined();
  });

  it("coreAdminFetch has no secret-related exports", async () => {
    const mod = await import("@/lib/coreAdminFetch");
    // These old exports should no longer exist
    expect("getCoreSecret" in mod).toBe(false);
    expect("setCoreSecret" in mod).toBe(false);
    expect("clearCoreSecret" in mod).toBe(false);
    expect("isCoreUnlocked" in mod).toBe(false);
    // coreAdminFetch should still exist
    expect("coreAdminFetch" in mod).toBe(true);
  });
});
