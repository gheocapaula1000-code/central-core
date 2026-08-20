import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useIsMobile } from "@/hooks/use-mobile";

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

describe("useIsMobile", () => {
  it("is true under the 768px breakpoint and false at or above it", () => {
    setWidth(500);
    const mobile = renderHook(() => useIsMobile());
    expect(mobile.result.current).toBe(true);

    setWidth(1024);
    const desktop = renderHook(() => useIsMobile());
    expect(desktop.result.current).toBe(false);
  });

  it("updates when matchMedia fires change", () => {
    const listeners = new Set<(ev?: Event) => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, fn: (ev?: Event) => void) => listeners.add(fn),
        removeEventListener: (_type: string, fn: (ev?: Event) => void) => listeners.delete(fn),
        dispatchEvent: () => true,
      }),
    });
    setWidth(1024);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    setWidth(400);
    act(() => {
      listeners.forEach((fn) => fn());
    });
    expect(result.current).toBe(true);
  });
});
