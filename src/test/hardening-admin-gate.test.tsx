import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
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
    act(() => {
      unlockBtn.click();
    });
    expect(getByText("Inserisci il secret amministrativo")).toBeTruthy();
    expect(queryByTestId("protected")).toBeNull();
  });

  it("rejects secret shorter than 8 characters", () => {
    const { getByText, getByPlaceholderText, queryByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const input = getByPlaceholderText("AI_CORE_SECRET") as HTMLInputElement;
    act(() => {
      // Simulate typing by setting value and dispatching input event
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, "value"
      )?.set;
      nativeInputValueSetter?.call(input, "short");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      getByText("Sblocca Console").click();
    });
    expect(getByText("Secret troppo corto")).toBeTruthy();
    expect(queryByTestId("protected")).toBeNull();
  });

  it("unlocks with valid secret via session pre-set", () => {
    // Simulates the state after successful unlock by pre-setting session
    mockStorage["core_admin_secret"] = "valid-secret-long-enough";
    const { getByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    expect(getByTestId("protected")).toBeTruthy();
  });
});
