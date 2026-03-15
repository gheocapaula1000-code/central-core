import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    render(
      <AdminSecretGate>
        <div data-testid="protected">Protected Content</div>
      </AdminSecretGate>
    );
    expect(screen.queryByTestId("protected")).toBeNull();
    expect(screen.getByText("Console Amministrativa")).toBeTruthy();
  });

  it("does not render children until secret is provided", () => {
    render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    expect(screen.queryByTestId("protected")).toBeNull();
  });

  it("unlocks and shows children after valid secret entry", () => {
    render(
      <AdminSecretGate>
        <div data-testid="protected">Protected Content</div>
      </AdminSecretGate>
    );
    const input = screen.getByPlaceholderText("AI_CORE_SECRET");
    fireEvent.change(input, { target: { value: "my-secret-value-12345" } });
    fireEvent.click(screen.getByText("Sblocca Console"));
    expect(screen.getByTestId("protected")).toBeTruthy();
  });

  it("rejects secret that is too short", () => {
    render(
      <AdminSecretGate>
        <div data-testid="protected">Protected</div>
      </AdminSecretGate>
    );
    const input = screen.getByPlaceholderText("AI_CORE_SECRET");
    fireEvent.change(input, { target: { value: "short" } });
    fireEvent.click(screen.getByText("Sblocca Console"));
    expect(screen.queryByTestId("protected")).toBeNull();
    expect(screen.getByText("Secret troppo corto")).toBeTruthy();
  });

  it("renders children immediately if session already has secret", () => {
    mockStorage["core_admin_secret"] = "already-unlocked-secret";
    render(
      <AdminSecretGate>
        <div data-testid="protected">Protected Content</div>
      </AdminSecretGate>
    );
    expect(screen.getByTestId("protected")).toBeTruthy();
  });
});
