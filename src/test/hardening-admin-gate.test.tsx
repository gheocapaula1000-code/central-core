import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
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

  it("rejects empty secret submission", async () => {
    const { getByText, queryByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const unlockBtn = getByText("Sblocca Console");
    fireEvent.click(unlockBtn);
    await waitFor(() => {
      expect(getByText("Inserisci il secret amministrativo")).toBeTruthy();
    });
    expect(queryByTestId("protected")).toBeNull();
  });

  it("rejects secret shorter than 8 characters", async () => {
    const { getByText, getByPlaceholderText, queryByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const input = getByPlaceholderText("AI_CORE_SECRET");
    fireEvent.change(input, { target: { value: "short" } });
    fireEvent.click(getByText("Sblocca Console"));
    await waitFor(() => {
      expect(getByText("Secret troppo corto")).toBeTruthy();
    });
    expect(queryByTestId("protected")).toBeNull();
  });

  it("unlocks with valid secret", async () => {
    const { getByText, getByPlaceholderText, getByTestId } = render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const input = getByPlaceholderText("AI_CORE_SECRET");
    fireEvent.change(input, { target: { value: "valid-secret-long-enough" } });
    fireEvent.click(getByText("Sblocca Console"));
    await waitFor(() => {
      expect(getByTestId("protected")).toBeTruthy();
    });
    expect(mockStorage["core_admin_secret"]).toBe("valid-secret-long-enough");
  });
});
