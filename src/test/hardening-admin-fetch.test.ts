import { describe, it, expect, vi } from "vitest";
import { coreAdminFetch } from "@/lib/coreAdminFetch";

describe("coreAdminFetch", () => {
  it("does not send x-core-secret header", async () => {
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
    expect(headers["x-core-secret"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");

    fetchSpy.mockRestore();
  });

  it("sends x-diagnostic-secret header when diagnosticSecret is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { metrics: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await coreAdminFetch("ai-core-run/metrics", { diagnosticSecret: "test-diag-key" });

    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["x-diagnostic-secret"]).toBe("test-diag-key");

    fetchSpy.mockRestore();
  });

  it("does NOT send x-diagnostic-secret header when diagnosticSecret is omitted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { status: "ok" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await coreAdminFetch("health");

    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["x-diagnostic-secret"]).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("throws on non-ok HTTP response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: { code: "DIAGNOSTIC_SECRET_REQUIRED", message: "Missing x-diagnostic-secret header" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(coreAdminFetch("ai-core-run/metrics")).rejects.toThrow("Missing x-diagnostic-secret header");

    fetchSpy.mockRestore();
  });
});
