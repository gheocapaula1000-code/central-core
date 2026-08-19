// Civiko One-only, cost-safe launch batch.
//
// All paid launch wrappers are called sequentially so their existing
// daily-budget checks cannot race each other.  The batch itself is one stage
// of pipeline_0510 and returns only correlated run/dataset identifiers.

import { isJobSecretAuthorized, jobAuthFailure, jobAuthHeaders } from "../_shared/jobAuth.ts";
import { isLockHeldEnvelope } from "../_shared/padovaPortalLaunch.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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


type IdentifierBundle = { run_id: string; dataset_id: string };

function identifierBundles(raw: unknown, depth = 0): IdentifierBundle[] {
  if (depth > 6 || raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.slice(0, 100).flatMap((value) => identifierBundles(value, depth + 1));
  }
  if (typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  const runId = [row.run_id, row.actor_run_id, row.actorRunId, row.existing_run_id, row.id]
    .find((value): value is string => typeof value === "string" && SAFE_ID.test(value));
  const datasetId = [row.dataset_id, row.default_dataset_id, row.defaultDatasetId, row.existing_dataset_id]
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

async function lookupRunBundle(runId: string): Promise<IdentifierBundle | null> {
  if (!SUPABASE_URL || !SERVICE_KEY || !SAFE_ID.test(runId)) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/padova_apify_runs?run_id=eq.${encodeURIComponent(runId)}&select=run_id,dataset_id&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const rows = await res.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
    const datasetId = typeof row?.dataset_id === "string" ? row.dataset_id : "";
    if (!datasetId || !SAFE_ID.test(datasetId)) return null;
    return { run_id: runId, dataset_id: datasetId };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !JOB_SECRET) return json(500, { ok: false, error: "config_missing" });
  if (!isJobSecretAuthorized(req.headers, JOB_SECRET)) {
    const auth = jobAuthFailure(Boolean(JOB_SECRET));
    return json(auth.status, { ok: false, error: auth.error });
  }

  const launched: Array<IdentifierBundle & { portal: string; status: "RUNNING" }> = [];
  for (const [portal, fn, body] of PORTALS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_PORTAL_TIMEOUT_MS);
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
        method: "POST",
        headers: jobAuthHeaders(JOB_SECRET),
        // Overrides are intentionally forbidden: the existing wrappers own
        // their paid caps and idempotency contract.
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* fail below */ }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json(response.ok ? 502 : response.status, {
          ok: false,
          error: `launch_${portal}_http_or_payload_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
        });
      }
      const envelope = payload as Record<string, unknown>;
      const lockHeld = isLockHeldEnvelope(response.status, envelope);
      if (!response.ok && !lockHeld) {
        return json(response.status, {
          ok: false,
          error: `launch_${portal}_http_or_payload_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
        });
      }
      if (!lockHeld && (envelope.ok !== true || envelope.error || Number(envelope.errors_count ?? 0) !== 0)) {
        return json(502, {
          ok: false,
          error: `launch_${portal}_semantic_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
        });
      }
      let bundles = uniqueIdentifierBundles(envelope);
      if (bundles.length === 0 && lockHeld) {
        const existing = typeof envelope.existing_run_id === "string" ? envelope.existing_run_id : "";
        const lookedUp = existing ? await lookupRunBundle(existing) : null;
        if (lookedUp) bundles = [lookedUp];
      }
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
