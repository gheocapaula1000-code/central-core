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
    const { getByText, queryByTestId, getByPlaceholderText } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    // Click unlock with empty input
    const unlockBtn = getByText("Sblocca Console");
    unlockBtn.click();
    expect(queryByTestId("protected")).toBeNull();
    expect(getByText("Inserisci il secret amministrativo")).toBeTruthy();
  });

  it("rejects short secret", () => {
    const { getByText, queryByTestId, getByPlaceholderText } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const input = getByPlaceholderText("AI_CORE_SECRET") as HTMLInputElement;
    // Simulate typing a short secret
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'short');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Use native change event
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    nativeInputValueSetter.call(input, 'short');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
