// Civiko-only capped launch batch (stage of pipeline_0510_capped).
//
// Additive and isolated: civiko-padova-apify-launch-batch (pipeline_0510) is
// untouched. Differences here, all mandatory:
//   - hard total Apify cap of 2.00 USD for the single execution;
//   - at most 25 items per Apify portal and one search URL where applicable;
//   - caps are hardcoded, never taken from the request body;
//   - the cap is verified provider-side and enforced with automatic abort;
//   - if the cap cannot be verified, or evidence is missing, nothing is
//     reported as successful: the batch fails closed.

import { getApifyToken } from "../_shared/apify.ts";
import {
  CAPPED_PORTAL_SPECS,
  evaluatePreflight,
  evaluateProviderCap,
  isTerminalRunStatus,
  MAX_ITEMS_PER_PORTAL,
  MAX_SEARCH_URLS,
  providerUsageUsd,
  RUN_COST_CAP_USD,
} from "./costCap.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const APIFY_BASE = "https://api.apify.com/v2";
const PER_PORTAL_TIMEOUT_MS = 34_000;
const VERIFY_TIMEOUT_MS = 8_000;
const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 2_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
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
  const own = runId && datasetId ? [{ run_id: runId, dataset_id: datasetId }] : [];
  return own.concat(Object.values(row).flatMap((value) => identifierBundles(value, depth + 1)));
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

async function abortRun(runId: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}/abort?token=${encodeURIComponent(token)}`,
      { method: "POST", signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
    );
    await res.text().catch(() => "");
    return res.ok;
  } catch {
    return false;
  }
}

async function readRun(
  runId: string,
  token: string,
): Promise<{ usage_usd: number | null; status: unknown }> {
  try {
    const res = await fetch(
      `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
    );
    const text = await res.text().catch(() => "");
    if (!res.ok || !text) return { usage_usd: null, status: null };
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const data = (parsed?.data ?? null) as Record<string, unknown> | null;
    return { usage_usd: providerUsageUsd(data), status: data?.status ?? null };
  } catch {
    return { usage_usd: null, status: null };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !JOB_SECRET) return json(500, { ok: false, error: "config_missing" });
  if (!safeEqual(req.headers.get("x-job-secret") ?? "", JOB_SECRET)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  // Body is intentionally never read: the caps of this batch are not widenable.

  const token = getApifyToken();
  const capsApplied = {
    cost_cap_usd: RUN_COST_CAP_USD,
    max_items_per_portal: MAX_ITEMS_PER_PORTAL,
    max_search_urls: MAX_SEARCH_URLS,
    per_portal: CAPPED_PORTAL_SPECS.map((spec) => ({ portal: spec.portal, ...spec.caps })),
  };
  const preflight = evaluatePreflight();
  const echo = {
    cost_cap_usd: RUN_COST_CAP_USD,
    estimated_cost_usd: preflight.estimated_cost_usd,
    per_portal_estimates: preflight.per_portal_estimates,
    caps_applied: capsApplied,
  };

  if (!preflight.allowed) {
    return json(402, { ok: false, error: preflight.reason, errors_count: 1, launched: [], ...echo });
  }
  if (!token) {
    // No token means the provider-side cap can never be verified or enforced.
    return json(409, {
      ok: false,
      error: "provider_cap_unenforceable",
      errors_count: 1,
      launched: [],
      ...echo,
    });
  }

  const launched: Array<IdentifierBundle & { portal: string; status: "RUNNING" }> = [];
  for (const spec of CAPPED_PORTAL_SPECS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_PORTAL_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
      };
      if (ANON_KEY) headers.apikey = ANON_KEY;
      const response = await fetch(`${SUPABASE_URL}/functions/v1/${spec.fn}`, {
        method: "POST",
        headers,
        body: JSON.stringify(spec.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* fail below */ }
      if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json(response.ok ? 502 : response.status, {
          ok: false,
          error: `launch_${spec.portal}_http_or_payload_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
          ...echo,
        });
      }
      const envelope = payload as Record<string, unknown>;
      if (envelope.ok !== true || envelope.error || Number(envelope.errors_count ?? 0) !== 0) {
        return json(502, {
          ok: false,
          error: `launch_${spec.portal}_semantic_failed`,
          started_count: launched.length,
          errors_count: 1,
          launched,
          ...echo,
        });
      }
      const bundles = uniqueIdentifierBundles(envelope);
      if (bundles.length === 0) {
        return json(502, {
          ok: false,
          error: `launch_${spec.portal}_identifiers_missing`,
          started_count: launched.length,
          errors_count: 1,
          launched,
          ...echo,
        });
      }
      for (const bundle of bundles) launched.push({ portal: spec.portal, ...bundle, status: "RUNNING" });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      return json(timeout ? 504 : 502, {
        ok: false,
        error: timeout ? `launch_${spec.portal}_timeout` : `launch_${spec.portal}_network_failed`,
        started_count: launched.length,
        errors_count: 1,
        launched,
        ...echo,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Provider-side verification of the hard cap, with automatic abort.
  const apifyRunIds = Array.from(new Set(
    launched.filter((row) => row.portal !== "private_leads").map((row) => row.run_id),
  ));
  let verdict = evaluateProviderCap(apifyRunIds.map((run_id) => ({ run_id, usage_usd: null })));
  const observed: Array<{ run_id: string; usage_usd: number | null; status: unknown }> = [];
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    const reads = await Promise.all(apifyRunIds.map(async (run_id) => {
      const read = await readRun(run_id, token);
      return { run_id, ...read };
    }));
    observed.length = 0;
    observed.push(...reads);
    verdict = evaluateProviderCap(reads.map(({ run_id, usage_usd }) => ({ run_id, usage_usd })));
    if (verdict.verified) break;
    if (attempt < VERIFY_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
    }
  }

  if (!verdict.verified || !verdict.within_cap) {
    const aborted: string[] = [];
    for (const row of observed.length > 0 ? observed : apifyRunIds.map((run_id) => ({ run_id, status: null }))) {
      if (isTerminalRunStatus((row as { status?: unknown }).status)) continue;
      if (await abortRun(row.run_id, token)) aborted.push(row.run_id);
    }
    return json(409, {
      ok: false,
      error: verdict.reason ?? "provider_cap_unverifiable",
      errors_count: 1,
      started_count: launched.length,
      launched,
      cost_cap_respected: false,
      provider_cap_verified: verdict.verified,
      observed_cost_usd: verdict.observed_total_usd,
      unverifiable_run_ids: verdict.unverifiable_run_ids,
      aborted_run_ids: aborted,
      ...echo,
    });
  }

  const families = new Set(launched.map((row) => row.portal));
  const ok = CAPPED_PORTAL_SPECS.every((spec) => families.has(spec.portal));
  return json(ok ? 200 : 502, {
    ok,
    started_count: launched.length,
    completed_portals: families.size,
    required_portals_complete: ok,
    errors_count: ok ? 0 : 1,
    launched,
    cost_cap_respected: true,
    provider_cap_verified: true,
    observed_cost_usd: verdict.observed_total_usd,
    provider_runs_observed: observed.map(({ run_id, usage_usd, status }) => ({
      run_id,
      usage_usd,
      status,
    })),
    ...echo,
  });
});
