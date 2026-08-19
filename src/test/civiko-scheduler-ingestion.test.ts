// Tests for the scheduler ingestion fixes:
// - per-source auth headers
// - F11 defaults to Padova centro when no coords supplied
// - evidence_writer attaches to successful sources
// - F14/F15 stay blocked
// - one failing source does not stop others
//
// Pure-unit: no live HTTP, no real Supabase.

import { describe, it, expect, vi } from "vitest";
import {
  buildRequestPlan,
  runOne,
  runScheduledSources,
  FORBIDDEN_SCHEDULER_CODES,
} from "../../supabase/functions/_shared/sourceJobs.ts";
import { SOURCE_PLAN } from "../../supabase/functions/_shared/sourceScheduler.ts";

vi.mock(
  "../../supabase/functions/_shared/sourceEvidenceWriters.ts",
  () => ({
    hasEvidenceWriter: (code: string) => ["F7", "F10", "F13", "F16", "F21"].includes(code),
    runEvidenceWriter: vi.fn(async (_s: unknown, code: string) => ({
      rows_written: code === "F7" ? 12 : 5,
    })),
  }),
);

function fakeSupabase() {
  const patches: Record<string, Record<string, unknown>> = {};
  return {
    patches,
    from() {
      return {
        select() { return { range: async () => ({ data: [], error: null }) }; },
        update(patch: Record<string, unknown>) {
          return {
            async eq(_col: string, val: string) {
              patches[val] = { ...(patches[val] ?? {}), ...patch };
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };
}

const okFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
  return new Response(JSON.stringify({ ok: true, data: { records_processed: 0 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

describe("buildRequestPlan", () => {
  it("sends x-internal-secret + x-source-app for F2 / F6", () => {
    for (const code of ["F2", "F6"]) {
      const plan = buildRequestPlan(
        SOURCE_PLAN[code],
        { AI_CORE_SECRET_CIVIKO: "secret-civiko" },
        "job",
        null,
      );
      expect("headers" in plan).toBe(true);
      if ("headers" in plan) {
        expect(plan.headers["x-internal-secret"]).toBe("secret-civiko");
        expect(plan.headers["x-source-app"]).toBe("civiko");
      }
    }
  });

  it("skips F2 when AI_CORE_SECRET_CIVIKO missing instead of leaking job secret", () => {
    const plan = buildRequestPlan(SOURCE_PLAN.F2, {}, "job", null);
    expect("skip_reason" in plan).toBe(true);
  });

  it("uses Bearer service-role for F5 + F19", () => {
    for (const code of ["F5", "F19"]) {
      const plan = buildRequestPlan(
        SOURCE_PLAN[code],
        { SUPABASE_SERVICE_ROLE_KEY: "srv-key" },
        "job",
        null,
      );
      if ("headers" in plan) {
        expect(plan.headers["Authorization"]).toBe("Bearer srv-key");
        expect(plan.headers["x-job-secret"]).toBe("job");
      } else {
        throw new Error("expected headers");
      }
    }
  });

  it("F11 defaults to Padova centro when no coords supplied", () => {
    const plan = buildRequestPlan(SOURCE_PLAN.F11, {}, "job", null);
    expect("body" in plan).toBe(true);
    if ("body" in plan) {
      expect(plan.body.lat).toBeCloseTo(45.4064);
      expect(plan.body.lng).toBeCloseTo(11.8768);
      expect(plan.body.radiusMeters).toBeGreaterThanOrEqual(10000);
    }
  });

  it("F11 includes lat/lng/radius when coords resolved", () => {
    const plan = buildRequestPlan(SOURCE_PLAN.F11, {}, "job", { lat: 45.4, lng: 11.8 });
    if ("body" in plan) {
      expect(plan.body.lat).toBe(45.4);
      expect(plan.body.lng).toBe(11.8);
      expect(plan.body.radiusMeters).toBeGreaterThan(0);
    } else throw new Error("expected body");
  });

  it("F7 / F10 / F16 send persist flags for territorial collection", () => {
    for (const code of ["F7", "F10", "F16"]) {
      const plan = buildRequestPlan(SOURCE_PLAN[code], {}, "job", null);
      if ("body" in plan) {
        expect(plan.body.dryRun).toBe(false);
        expect(plan.body.import).toBe(true);
      } else throw new Error(`expected body for ${code}`);
    }
  });
});

describe("runOne — evidence writer attachment", () => {
  it("F7 success increments records_processed from evidence writer", async () => {
    const sb = fakeSupabase();
    const res = await runOne(SOURCE_PLAN.F7, {
      supabase: sb,
      baseUrl: "https://x.test",
      jobSecret: "job",
      fetchImpl: okFetch,
      attachEvidenceWriter: true,
    });
    expect(res.status).toBe("success");
    expect(res.records_processed).toBe(12);
    expect(sb.patches.F7?.record_count).toBe(12);
    expect(sb.patches.F7?.last_success_at).toBeTruthy();
  });

  it("F2 has no evidence writer attached → records from response payload only", async () => {
    const sb = fakeSupabase();
    const res = await runOne(SOURCE_PLAN.F2, {
      supabase: sb,
      baseUrl: "https://x.test",
      jobSecret: "job",
      fetchImpl: okFetch,
      secrets: { AI_CORE_SECRET_CIVIKO: "civiko-secret" },
      attachEvidenceWriter: true,
    });
    expect(res.status).toBe("success");
    expect(res.records_processed).toBe(0);
  });
});

describe("runScheduledSources isolation", () => {
  it("F14/F15 are never invoked", async () => {
    const sb = fakeSupabase();
    const seen: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await runScheduledSources({
      supabase: sb, baseUrl: "https://x.test", jobSecret: "job", fetchImpl: fetchSpy,
      secrets: { AI_CORE_SECRET_CIVIKO: "x", SUPABASE_SERVICE_ROLE_KEY: "y" },
      resolveCoords: async () => ({ lat: 45.4, lng: 11.8 }),
      attachEvidenceWriter: false,
    }, {});
    for (const f of FORBIDDEN_SCHEDULER_CODES) {
      expect(seen.some((u) => u.includes(SOURCE_PLAN[f].ingestion_endpoint ?? "/__never__"))).toBe(false);
    }
  });

  it("one failing fetch does not stop the others", async () => {
    const sb = fakeSupabase();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("network");
      return new Response(JSON.stringify({ ok: true, data: { records_processed: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runScheduledSources({
      supabase: sb, baseUrl: "https://x.test", jobSecret: "job", fetchImpl,
      secrets: { AI_CORE_SECRET_CIVIKO: "x", SUPABASE_SERVICE_ROLE_KEY: "y" },
      resolveCoords: async () => ({ lat: 45.4, lng: 11.8 }),
      attachEvidenceWriter: false,
    }, {});
    expect(result.summary.total).toBeGreaterThan(2);
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);
    expect(result.summary.success).toBeGreaterThanOrEqual(1);
  });
});
