  serve: (handler: (req: Request) => Response | Promise<Response>) => unknown;
};
// Civiko One-only, cost-safe launch batch.
//
// All paid launch wrappers are called sequentially so their existing
// daily-budget checks cannot race each other.  The batch itself is one stage
// of pipeline_0510 and returns only correlated run/dataset identifiers.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const PER_PORTAL_TIMEOUT_MS = 34_000;
const PORTALS = [
  ["immobiliare", "cron-apify-immobiliare-nightly", {}],
  ["idealista", "cron-apify-idealista-nightly", {}],
  ["subito", "cron-apify-subito-nightly", {}],
  ["private_leads", "civiko-private-leads-nightly", { trigger: "orchestrator" }],
] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let mismatch = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) mismatch |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

type IdentifierBundle = { run_id: string; dataset_id: string };

function identifierBundles(raw: unknown, depth = 0): IdentifierBundle[] {
  if (depth > 6 || raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.slice(0, 100).flatMap((value) => identifierBundles(value, depth + 1));
  }
  if (typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  const runId = [row.run_id, row.actor_run_id, row.actorRunId, row.id]
    .find((value): value is string => typeof value === "string" && SAFE_ID.test(value));
  const datasetId = [row.dataset_id, row.default_dataset_id, row.defaultDatasetId]
    .find((value): value is string => typeof value === "string" && SAFE_ID.test(value));
  const own = runId && datasetId
    ? [{ run_id: runId, dataset_id: datasetId }]
    : [];
  return own.concat(
    Object.values(row).flatMap((value) => identifierBundles(value, depth + 1)),
  );
}

export function uniqueIdentifierBundles(raw: unknown): IdentifierBundle[] {
  const seen = new Set<string>();
  return identifierBundles(raw).filter(({ run_id, dataset_id }) => {
    const key = `${run_id}\u0000${dataset_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !JOB_SECRET) return json(500, { ok: false, error: "config_missing" });
  if (!safeEqual(req.headers.get("x-job-secret") ?? "", JOB_SECRET)) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const launched: Array<IdentifierBundle & { portal: string; status: "RUNNING" }> = [];
  for (const [portal, fn, body] of PORTALS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_PORTAL_TIMEOUT_MS);
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-job-secret": JOB_SECRET },
        // Overrides are intentionally forbidden: the existing wrappers own
        // their paid caps and idempotency contract.
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* fail below */ }
      if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json(response.ok ? 502 : response.status, {
          ok: false,
          error: `launch_${portal}_http_or_payload_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
        });
      }
      const envelope = payload as Record<string, unknown>;
      if (envelope.ok !== true || envelope.error || Number(envelope.errors_count ?? 0) !== 0) {
        return json(502, {
          ok: false,
          error: `launch_${portal}_semantic_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
        });
      }
      const bundles = uniqueIdentifierBundles(envelope);
      if (bundles.length === 0) {
        return json(502, {
          ok: false,
          error: `launch_${portal}_identifiers_missing`,
          started_count: launched.length,
          errors_count: 1,
          launched,
        });
      }
      for (const bundle of bundles) launched.push({ portal, ...bundle, status: "RUNNING" });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      return json(timeout ? 504 : 502, {
        ok: false,
        error: timeout ? `launch_${portal}_timeout` : `launch_${portal}_network_failed`,
        started_count: launched.length,
        errors_count: 1,
        launched,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const families = new Set(launched.map((row) => row.portal));
  const ok = PORTALS.every(([portal]) => families.has(portal));
  return json(ok ? 200 : 502, {
    ok,
    started_count: launched.length,
    completed_portals: families.size,
    required_portals_complete: ok,
    errors_count: ok ? 0 : 1,
    launched,
  });
});
