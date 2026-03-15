import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCoreSecret, setCoreSecret, clearCoreSecret, isCoreUnlocked, coreAdminFetch } from "@/lib/coreAdminFetch";

const mockStorage: Record<string, string> = {};
beforeEach(() => {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => mockStorage[key] ?? null);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, val) => { mockStorage[key] = val; });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => { delete mockStorage[key]; });
  vi.restoreAllMocks();
  // Re-apply storage mocks after restoreAllMocks
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => mockStorage[key] ?? null);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, val) => { mockStorage[key] = val; });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => { delete mockStorage[key]; });
});

describe("coreAdminFetch helpers", () => {
  it("getCoreSecret returns null when no secret stored", () => {
    expect(getCoreSecret()).toBeNull();
  });

  it("setCoreSecret stores and getCoreSecret retrieves", () => {
    setCoreSecret("test-secret-123");
    expect(getCoreSecret()).toBe("test-secret-123");
  });

  it("isCoreUnlocked returns false initially", () => {
    expect(isCoreUnlocked()).toBe(false);
  });

  it("isCoreUnlocked returns true after setCoreSecret", () => {
    setCoreSecret("my-secret");
    expect(isCoreUnlocked()).toBe(true);
  });

  it("clearCoreSecret removes the secret", () => {
    setCoreSecret("my-secret");
    expect(isCoreUnlocked()).toBe(true);
    clearCoreSecret();
    expect(isCoreUnlocked()).toBe(false);
    expect(getCoreSecret()).toBeNull();
  });
});

describe("coreAdminFetch", () => {
  it("throws if console is not unlocked (no secret)", async () => {
    await expect(coreAdminFetch("health")).rejects.toThrow(
      "Console non sbloccata"
    );
  });

  it("sends x-core-secret header when unlocked", async () => {
    setCoreSecret("my-test-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { status: "ok" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await coreAdminFetch("health");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["x-core-secret"]).toBe("my-test-secret");
    expect(headers["Content-Type"]).toBe("application/json");

    fetchSpy.mockRestore();
  });

  it("throws on non-ok HTTP response", async () => {
    setCoreSecret("my-test-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid secret" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(coreAdminFetch("metrics")).rejects.toThrow("Invalid secret");

    fetchSpy.mockRestore();
  });
});
