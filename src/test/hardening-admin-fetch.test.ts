import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCoreSecret, setCoreSecret, clearCoreSecret, isCoreUnlocked } from "@/lib/coreAdminFetch";

const mockStorage: Record<string, string> = {};
beforeEach(() => {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
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
