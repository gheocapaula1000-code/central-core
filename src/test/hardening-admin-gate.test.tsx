import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "@/App";

// Minimal wrapper to test App mounts directly without gate
function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Admin console access", () => {
  it("mounts directly without any unlock gate", () => {
    // App no longer wraps in AdminSecretGate, so sidebar should render immediately
    // We just verify the component doesn't throw and renders
    const { container } = renderApp();
    expect(container.querySelector(".min-h-screen")).toBeTruthy();
  });
});
