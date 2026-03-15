import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { AdminSecretGate } from "@/components/AdminSecretGate";

// Mock sessionStorage
const mockStorage: Record<string, string> = {};
beforeEach(() => {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => mockStorage[key] ?? null);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, val) => { mockStorage[key] = val; });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => { delete mockStorage[key]; });
});

describe("AdminSecretGate", () => {
  it("shows lock screen initially when no secret in session", () => {
    const { queryByTestId, getByText } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected Content</div>
      </AdminSecretGate>
    );
    expect(queryByTestId("protected")).toBeNull();
    expect(getByText("Console Amministrativa")).toBeTruthy();
  });

  it("does not render children until secret is provided", () => {
    const { queryByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    expect(queryByTestId("protected")).toBeNull();
  });

  it("renders children immediately if session already has secret", () => {
    mockStorage["core_admin_secret"] = "already-unlocked-secret";
    const { getByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected Content</div>
      </AdminSecretGate>
    );
    expect(getByTestId("protected")).toBeTruthy();
  });

  it("rejects empty secret submission", () => {
    const { getByText, queryByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const unlockBtn = getByText("Sblocca Console");
    unlockBtn.click();
    expect(queryByTestId("protected")).toBeNull();
    expect(getByText("Inserisci il secret amministrativo")).toBeTruthy();
  });
});
