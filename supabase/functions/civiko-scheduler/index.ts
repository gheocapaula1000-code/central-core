// civiko-scheduler
// Official (Class A) ingest runner. The mixed nightly master used to invoke
// portal scrapers in the same pass; portal antibot failures must not gate
// OMI / ISTAT / OSM / civici. Class C portals stay on their existing
// fail-closed crons and are refused here.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET (constant-time).
// Live Core: jpunnzgixcghuydstdlt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleOptions,
  ok,
  fail,
  makeDebugId,
  constantTimeEqual,
} from "../_shared/http.ts";
import { runScheduledSources } from "../_shared/sourceJobs.ts";
import type { PipelineClass } from "../_shared/sourceScheduler.ts";

const FUNCTION_NAME = "civiko-scheduler";
const PADOVA_COORDS = { lat: 45.4064, lng: 11.8768 };

function requireJobSecret(req: Request, debugId: string): string | Response {
  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!expected) {
    return fail(req, 500, "CONFIG_ERROR", "job secret not configured", debugId);
  }
  const incoming = req.headers.get("x-job-secret") ?? "";
  if (!incoming || !constantTimeEqual(incoming, expected)) {
    return fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-job-secret", debugId);
  }
  return expected;
}

function routePath(req: Request): string {
  const url = new URL(req.url);
  const idx = url.pathname.indexOf(FUNCTION_NAME);
  const rest = idx >= 0 ? url.pathname.slice(idx + FUNCTION_NAME.length) : url.pathname;
  return rest.replace(/\/+$/, "") || "/";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const auth = requireJobSecret(req, debugId);
  if (auth instanceof Response) return auth;
  const jobSecret = auth;

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
  }

  const path = routePath(req);
  if (path !== "/" && path !== "/run-scheduled") {
    return fail(req, 404, "ROUTE_NOT_FOUND", "Use POST /run-scheduled", debugId);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId);
  }

  const requestedClass = body.pipeline_class;
  if (requestedClass === "C" || requestedClass === "all") {
    return fail(
      req,
      400,
      "PORTAL_PIPELINE_REFUSED",
      "Class C portals are not invoked from civiko-scheduler. Use existing portal crons.",
      debugId,
    );
  }
  const pipeline_class: PipelineClass = "A";

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return fail(req, 500, "MISSING_CONFIG", "Service role not configured", debugId);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const result = await runScheduledSources(
    {
      supabase,
      baseUrl: `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`,
      jobSecret,
      secrets: {
        AI_CORE_SECRET_CIVIKO: Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "",
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      },
      resolveCoords: async () => PADOVA_COORDS,
    },
    {
      due_only: body.due_only !== false,
      dry_run: Boolean(body.dry_run),
      source_code: typeof body.source_code === "string" ? body.source_code : undefined,
      pipeline_class,
    },
  );

  return ok(req, { ...result, pipeline_class, function: FUNCTION_NAME }, [], debugId);
});
