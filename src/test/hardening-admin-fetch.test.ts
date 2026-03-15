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

  it("works without any secret or session setup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { metrics: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await coreAdminFetch("ai-core-run/metrics");
    expect(result).toEqual({ metrics: [] });

    fetchSpy.mockRestore();
  });

  it("throws on non-ok HTTP response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not in allowlist" } }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(coreAdminFetch("ai-core-run/metrics")).rejects.toThrow("Origin not in allowlist");

    fetchSpy.mockRestore();
  });
});
