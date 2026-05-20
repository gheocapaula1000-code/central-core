// ═══════════════════════════════════════════════════════════════
// padova-bootstrap-cycle — one-click orchestrator
//
// POST /functions/v1/padova-bootstrap-cycle
// Auth: x-diagnostic-secret (same gate as padova-readiness)
//
// Purpose: Paula calls this ONE endpoint from the admin UI. It runs,
// server-side, the full Padova cycle using CENTRAL_CORE_JOB_SECRET
// kept in env (never exposed to client):
//
//   1. refresh-padova-auctions (Firecrawl + Apify fallback)
//   2. build-padova-early-warning (aggregator)
//   3. padova-readiness (final snapshot)
//
// Returns a combined report. Idempotent and safe to repeat.
//
// HARD RULES:
//   - No mock. No data invention.
//   - Job secret read from env only; never echoed back.
//   - If a stage fails, subsequent stages still run and errors are
//     collected; the response is 207 Multi-Status (envelope `ok=false`)
//     so the UI can show partial progress.
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { makeDebugId, requireDiagnosticSecret, ok, handleOptions } from "../_shared/http.ts";

const FUNCTION_NAME = "padova-bootstrap-cycle";

interface StageResult {
  stage: string;
  ok: boolean;
  status: number;
  duration_ms: number;
  body: unknown;
  error?: string;
}

function functionUrl(path: string): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/${path.replace(/^\/+/, "")}`;
}

async function runStage(stage: string, url: string, init: RequestInit): Promise<StageResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return {
      stage,
      ok: r.ok,
      status: r.status,
      duration_ms: Date.now() - t0,
      body,
    };
  } catch (e) {
    return {
      stage,
      ok: false,
      status: 0,
      duration_ms: Date.now() - t0,
      body: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const authErr = requireDiagnosticSecret(req, debugId);
  if (authErr) return authErr;

  if (req.method !== "POST" && req.method !== "GET") {
    return ok(req, { error: "method_not_allowed" }, ["method_not_allowed"], debugId);
  }

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const diagSecret = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  const warnings: string[] = [];

  if (!jobSecret) {
    return ok(req, {
      cycle_ok: false,
      error: "CENTRAL_CORE_JOB_SECRET not configured",
      stages: [],
    }, ["job_secret_missing"], debugId);
  }

  // Parse optional body { dryRun?: boolean, includeNeedsReview?: boolean }
  let body: { dryRun?: boolean; includeNeedsReview?: boolean } = {};
  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* ignore */ }
  const dryRun = body.dryRun === true;
  const includeNeedsReview = body.includeNeedsReview === true;

  const stages: StageResult[] = [];
  const jobHeaders = {
    "Content-Type": "application/json",
    "x-job-secret": jobSecret,
  };

  // Stage 1: refresh auctions
  const s1 = await runStage(
    "refresh-padova-auctions",
    functionUrl("civiko-radar-veneto/jobs/refresh-padova-auctions"),
    {
      method: "POST",
      headers: jobHeaders,
      body: JSON.stringify({ dryRun, includeNeedsReview, maxPagesPerSource: 8 }),
    },
  );
  stages.push(s1);
  if (!s1.ok) warnings.push(`stage_refresh_auctions_failed:${s1.status}`);

  // Stage 2: dry_run early-warning (sanity)
  const s2 = await runStage(
    "build-padova-early-warning-dry-run",
    functionUrl("civiko-radar-veneto/jobs/build-padova-early-warning"),
    {
      method: "POST",
      headers: jobHeaders,
      body: JSON.stringify({ dryRun: true }),
    },
  );
  stages.push(s2);

  // Stage 3: real early-warning build (skip if dryRun)
  if (!dryRun) {
    const s3 = await runStage(
      "build-padova-early-warning",
      functionUrl("civiko-radar-veneto/jobs/build-padova-early-warning"),
      {
        method: "POST",
        headers: jobHeaders,
        body: JSON.stringify({ dryRun: false }),
      },
    );
    stages.push(s3);
    if (!s3.ok) warnings.push(`stage_build_early_warning_failed:${s3.status}`);
  } else {
    warnings.push("dry_run_mode_real_build_skipped");
  }

  // Stage 4: final readiness snapshot
  if (diagSecret) {
    const s4 = await runStage(
      "padova-readiness",
      functionUrl("padova-readiness"),
      {
        method: "GET",
        headers: { "x-diagnostic-secret": diagSecret },
      },
    );
    stages.push(s4);
  } else {
    warnings.push("diagnostic_secret_missing_readiness_skipped");
  }

  const cycleOk = stages.every((s) => s.ok);

  return ok(req, {
    cycle_ok: cycleOk,
    dry_run: dryRun,
    started_at: new Date(Date.now() - stages.reduce((a, s) => a + s.duration_ms, 0)).toISOString(),
    finished_at: new Date().toISOString(),
    total_duration_ms: stages.reduce((a, s) => a + s.duration_ms, 0),
    function: FUNCTION_NAME,
    stages: stages.map((s) => ({
      stage: s.stage,
      ok: s.ok,
      status: s.status,
      duration_ms: s.duration_ms,
      // Limit body size in response — keep top-level fields only
      summary: typeof s.body === "object" && s.body !== null
        ? (s.body as Record<string, unknown>)
        : { raw: String(s.body).slice(0, 500) },
      error: s.error,
    })),
    notes: [
      "Cycle is idempotent; safe to re-run.",
      "No personal data exposed in response.",
      "For scheduled execution, use pg_cron to POST to this endpoint with x-diagnostic-secret header.",
    ],
  }, warnings, debugId);
});
