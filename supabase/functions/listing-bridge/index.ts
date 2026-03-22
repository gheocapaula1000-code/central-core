// ═══════════════════════════════════════════════════════════════
// Listing Bridge — Edge Function (Central Core V3)
// Isolated bridge: KeyDraft → validate → normalize → Sottra
// No direct coupling between KeyDraft and Sottra.
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId,
  handleOptions,
  ok,
  fail,
  requireSecret,
  resolveInternalSecret,
  CORE_VERSION,
  CORE_CONTRACT,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
} from "../_shared/http.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const FUNCTION_NAME = "listing-bridge";
const EXPECTED_BASE_PATH = "/functions/v1/listing-bridge";
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0"]);
const MAX_BODY_SIZE = 500_000;
const MAX_RETRY = 3;

// ═══════════════════════════════════════════════════════════════
// IDENTITY HELPER
// ═══════════════════════════════════════════════════════════════
function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE CLIENT (service_role for DB access)
// ═══════════════════════════════════════════════════════════════
function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// ═══════════════════════════════════════════════════════════════
// CANONICAL SCHEMA TYPES (v1.0)
// ═══════════════════════════════════════════════════════════════
interface BridgePayloadV1 {
  schema_version: string;
  source: {
    app: string;
    environment?: string;
    exported_at: string;
    bridge_trace_id: string;
  };
  listing: {
    listing_id: string;
    run_id: string;
    status: string;
  };
  property: {
    property_type?: string | null;
    rooms_estimated?: number | null;
    bathrooms_estimated?: number | null;
    photo_count?: number | null;
  };
  photo_derived?: {
    materials_detected?: string[];
    features_detected?: string[];
    confidence_flags?: string[];
  };
  agent_supplied?: {
    structured_features?: Record<string, boolean | null>;
    freeform_notes?: string | null;
  };
  generated_text: {
    primary_listing_text: string;
    listing_text_long?: string | null;
    listing_text_short?: string | null;
    listing_social_variants?: string[];
  };
  sharing?: {
    whatsapp_ready_summary?: string | null;
  };
  origin_map?: Record<string, { from: string[] }>;
  bridge_status?: {
    export_status?: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validatePayload(body: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!body || typeof body !== "object") {
    return { valid: false, errors: ["Body must be a JSON object"], warnings };
  }

  const p = body as Record<string, unknown>;

  // schema_version
  if (!p.schema_version || typeof p.schema_version !== "string") {
    errors.push("Missing or invalid schema_version");
  } else if (!SUPPORTED_SCHEMA_VERSIONS.has(p.schema_version)) {
    errors.push(`Unsupported schema_version: ${p.schema_version}. Supported: ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}`);
  }

  // source
  const src = p.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") {
    errors.push("Missing source object");
  } else {
    if (!src.app || typeof src.app !== "string") errors.push("Missing source.app");
    if (!src.exported_at || typeof src.exported_at !== "string") errors.push("Missing source.exported_at");
    if (!src.bridge_trace_id || typeof src.bridge_trace_id !== "string") errors.push("Missing source.bridge_trace_id");
  }

  // listing
  const lst = p.listing as Record<string, unknown> | undefined;
  if (!lst || typeof lst !== "object") {
    errors.push("Missing listing object");
  } else {
    if (!lst.listing_id || typeof lst.listing_id !== "string") errors.push("Missing listing.listing_id");
    if (!lst.run_id || typeof lst.run_id !== "string") errors.push("Missing listing.run_id");
  }

  // generated_text
  const gt = p.generated_text as Record<string, unknown> | undefined;
  if (!gt || typeof gt !== "object") {
    errors.push("Missing generated_text object");
  } else {
    if (!gt.primary_listing_text || typeof gt.primary_listing_text !== "string") {
      errors.push("Missing generated_text.primary_listing_text");
    }
  }

  // property (optional but warned if missing)
  if (!p.property || typeof p.property !== "object") {
    warnings.push("property object is missing — Sottra enrichment may be limited");
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════════════════════════════
// TRANSFORM: canonical → Sottra import payload
// Carries ALL useful fields — no silent data loss.
// ═══════════════════════════════════════════════════════════════
function transformToSottraPayload(payload: BridgePayloadV1): Record<string, unknown> {
  return {
    // ── Identity & Tracing ──
    bridge_trace_id: payload.source.bridge_trace_id,
    source_app: payload.source.app,
    source_environment: payload.source.environment ?? null,
    exported_at: payload.source.exported_at,
    schema_version: payload.schema_version,

    // ── Listing core ──
    listing_id: payload.listing.listing_id,
    run_id: payload.listing.run_id,
    listing_status: payload.listing.status,

    // ── Property ──
    property_type: payload.property?.property_type ?? null,
    rooms: payload.property?.rooms_estimated ?? null,
    bathrooms: payload.property?.bathrooms_estimated ?? null,
    photo_count: payload.property?.photo_count ?? null,

    // ── Photo-derived intelligence ──
    materials_detected: payload.photo_derived?.materials_detected ?? [],
    features_detected: payload.photo_derived?.features_detected ?? [],
    confidence_flags: payload.photo_derived?.confidence_flags ?? [],

    // ── Agent-supplied data ──
    structured_features: payload.agent_supplied?.structured_features ?? {},
    freeform_notes: payload.agent_supplied?.freeform_notes ?? null,

    // ── Generated text (complete) ──
    primary_text: payload.generated_text.primary_listing_text,
    text_long: payload.generated_text.listing_text_long ?? null,
    text_short: payload.generated_text.listing_text_short ?? null,
    social_variants: payload.generated_text.listing_social_variants ?? [],

    // ── Sharing ──
    whatsapp_summary: payload.sharing?.whatsapp_ready_summary ?? null,

    // ── Data origin traceability ──
    origin_map: payload.origin_map ?? null,

    // ── Bridge metadata ──
    imported_at: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// DB HELPERS
// ═══════════════════════════════════════════════════════════════
type JobStatus = "received" | "validated" | "transformed" | "delivered" | "imported" | "failed";

async function upsertJob(
  db: ReturnType<typeof createClient>,
  payload: BridgePayloadV1,
  status: JobStatus,
  extra?: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("listing_bridge_jobs")
    .upsert(
      {
        trace_id: payload.source.bridge_trace_id,
        listing_id: payload.listing.listing_id,
        run_id: payload.listing.run_id,
        schema_version: payload.schema_version,
        source_app: payload.source.app,
        source_environment: payload.source.environment ?? null,
        status,
        payload: payload as unknown,
        updated_at: now,
        ...extra,
      },
      { onConflict: "trace_id" },
    )
    .select("id, status")
    .single();

  if (error) throw new Error(`DB upsert failed: ${error.message}`);
  return data;
}

async function updateJobStatus(
  db: ReturnType<typeof createClient>,
  traceId: string,
  status: JobStatus,
  extra?: Record<string, unknown>,
) {
  const { error } = await db
    .from("listing_bridge_jobs")
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq("trace_id", traceId);
  if (error) console.error(`[listing-bridge] Failed to update job status: ${error.message}`);
}

// ═══════════════════════════════════════════════════════════════
// SOTTRA DELIVERY (internal call → scan/import)
// Target: dedicated import endpoint, NOT scan/identify.
// scan/identify is for building identification from photos/GPS.
// scan/import receives pre-processed listing data from the bridge.
// ═══════════════════════════════════════════════════════════════
async function deliverToSottra(
  req: Request,
  sottraPayload: Record<string, unknown>,
  _debugId: string,
): Promise<{ success: boolean; status: number; body: unknown }> {
  const baseUrl = new URL(req.url);
  const sottraUrl = `${baseUrl.protocol}//${baseUrl.host}/functions/v1/sottra/scan/import`;

  const secret = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (!secret) {
    return { success: false, status: 500, body: { error: "AI_CORE_SECRET not configured for Sottra delivery" } };
  }

  try {
    const res = await fetch(sottraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
        "x-source-app": "listing-bridge",
        "x-bridge-trace-id": String(sottraPayload.bridge_trace_id ?? ""),
      },
      body: JSON.stringify(sottraPayload),
    });

    const body = await res.json().catch(() => null);
    return { success: res.ok, status: res.status, body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[listing-bridge] Sottra delivery failed: ${msg}`);
    return { success: false, status: 0, body: { error: msg } };
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════

/** POST /ingest — main bridge entry point from KeyDraft */
async function handleIngest(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  // 1. Validate
  const validation = validatePayload(body);
  if (!validation.valid) {
    return fail(req, 400, "VALIDATION_FAILED", `Payload validation failed: ${validation.errors.join("; ")}`, debugId);
  }

  const payload = body as unknown as BridgePayloadV1;
  const db = getServiceClient();

  // 2. Idempotency check — if trace_id already processed, return existing result
  const { data: existing } = await db
    .from("listing_bridge_jobs")
    .select("id, status, trace_id")
    .eq("trace_id", payload.source.bridge_trace_id)
    .maybeSingle();

  if (existing && existing.status !== "failed") {
    return ok(req, {
      job_id: existing.id,
      trace_id: existing.trace_id,
      status: existing.status,
      idempotent: true,
    }, ["Job already exists — returning existing state"], debugId);
  }

  // 3. Create/update job → received
  const job = await upsertJob(db, payload, "received");

  // 4. Validate → validated
  await updateJobStatus(db, payload.source.bridge_trace_id, "validated");

  // 5. Transform → transformed
  const sottraPayload = transformToSottraPayload(payload);
  await updateJobStatus(db, payload.source.bridge_trace_id, "transformed", {
    sottra_payload: sottraPayload,
    warnings: validation.warnings,
  });

  // 6. Deliver to Sottra
  const delivery = await deliverToSottra(req, sottraPayload, debugId);

  if (delivery.success) {
    await updateJobStatus(db, payload.source.bridge_trace_id, "delivered", {
      sottra_response: delivery.body,
      delivered_at: new Date().toISOString(),
    });

    return ok(req, {
      job_id: job.id,
      trace_id: payload.source.bridge_trace_id,
      status: "delivered",
      sottra_status: delivery.status,
    }, validation.warnings, debugId);
  }

  // Delivery failed
  const retryCount = (existing?.status === "failed" ? 1 : 0);
  await updateJobStatus(db, payload.source.bridge_trace_id, "failed", {
    error_message: `Sottra delivery failed: HTTP ${delivery.status}`,
    sottra_response: delivery.body,
    retry_count: retryCount,
  });

  return fail(req, 502, "DELIVERY_FAILED",
    `Sottra delivery failed with status ${delivery.status}. Job saved for retry. trace_id=${payload.source.bridge_trace_id}`,
    debugId,
  );
}

/** GET /status/:trace_id — check job status */
async function handleStatus(req: Request, debugId: string): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const traceId = parts[parts.length - 1];

  if (!traceId || traceId === "status") {
    return fail(req, 400, "MISSING_TRACE_ID", "Provide trace_id in path: /status/{trace_id}", debugId);
  }

  const db = getServiceClient();
  const { data, error } = await db
    .from("listing_bridge_jobs")
    .select("id, trace_id, listing_id, run_id, status, warnings, error_message, retry_count, created_at, updated_at, delivered_at")
    .eq("trace_id", traceId)
    .maybeSingle();

  if (error) {
    return fail(req, 500, "DB_ERROR", "Failed to query job status", debugId);
  }

  if (!data) {
    return fail(req, 404, "JOB_NOT_FOUND", `No job found for trace_id=${traceId}`, debugId);
  }

  return ok(req, data, [], debugId);
}

/** POST /retry/:trace_id — retry a failed job */
async function handleRetry(req: Request, debugId: string): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const traceId = parts[parts.length - 1];

  if (!traceId || traceId === "retry") {
    return fail(req, 400, "MISSING_TRACE_ID", "Provide trace_id in path: /retry/{trace_id}", debugId);
  }

  const db = getServiceClient();
  const { data: job } = await db
    .from("listing_bridge_jobs")
    .select("*")
    .eq("trace_id", traceId)
    .maybeSingle();

  if (!job) {
    return fail(req, 404, "JOB_NOT_FOUND", `No job found for trace_id=${traceId}`, debugId);
  }

  if (job.status !== "failed") {
    return fail(req, 409, "JOB_NOT_RETRYABLE", `Job is in status '${job.status}', not 'failed'`, debugId);
  }

  if (job.retry_count >= MAX_RETRY) {
    return fail(req, 429, "MAX_RETRIES_EXCEEDED", `Job has reached maximum retries (${MAX_RETRY})`, debugId);
  }

  // Re-transform and deliver
  const payload = job.payload as unknown as BridgePayloadV1;
  const sottraPayload = transformToSottraPayload(payload);

  await updateJobStatus(db, traceId, "transformed", {
    retry_count: job.retry_count + 1,
  });

  const delivery = await deliverToSottra(req, sottraPayload, debugId);

  if (delivery.success) {
    await updateJobStatus(db, traceId, "delivered", {
      sottra_response: delivery.body,
      delivered_at: new Date().toISOString(),
      error_message: null,
    });
    return ok(req, {
      trace_id: traceId,
      status: "delivered",
      retry_count: job.retry_count + 1,
    }, [], debugId);
  }

  await updateJobStatus(db, traceId, "failed", {
    error_message: `Retry failed: HTTP ${delivery.status}`,
    sottra_response: delivery.body,
  });

  return fail(req, 502, "RETRY_DELIVERY_FAILED",
    `Retry delivery failed with status ${delivery.status}`,
    debugId,
  );
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[listing-bridge] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    // Origin policy
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    // Manifest — public, no auth
    if (req.method === "GET" && pathname.endsWith("/manifest")) {
      const manifest = buildManifest({
        functionName: FUNCTION_NAME,
        serviceKind: "listing-bridge",
        expectedBasePath: EXPECTED_BASE_PATH,
        routes: [
          "GET /health",
          "GET /manifest",
          "POST /ingest",
          "GET /status/:trace_id",
          "POST /retry/:trace_id",
        ],
        callingMode: "direct",
      });
      return withIdentity(ok(req, manifest, [], debugId), "manifest");
    }

    // Health — no auth
    if (req.method === "GET" && (pathname.endsWith("/health") || pathname === "/")) {
      return withIdentity(ok(req, {
        status: "healthy",
        engine: "listing-bridge",
        version: CORE_VERSION,
        contract: CORE_CONTRACT,
        function: FUNCTION_NAME,
        expectedBasePath: EXPECTED_BASE_PATH,
        routes: ["ingest", "status", "retry"],
        time: new Date().toISOString(),
      }, [], debugId), "health");
    }

    // Auth — all other routes require secret
    const authErr = requireSecret(req, debugId);
    if (authErr) return withIdentity(authErr, "auth-rejected");

    // GET /status/:trace_id
    if (req.method === "GET" && pathname.includes("/status/")) {
      const res = await handleStatus(req, debugId);
      return withIdentity(res, "status");
    }

    // POST routes
    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST for /ingest and /retry, GET for /status and /health", debugId), "error");
    }

    // Body parsing
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_SIZE) {
      return withIdentity(fail(req, 413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${MAX_BODY_SIZE} bytes`, debugId), "error");
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody);
    } catch {
      return withIdentity(fail(req, 400, "INVALID_JSON", "Body must be valid JSON", debugId), "error");
    }

    // POST /ingest
    if (pathname.endsWith("/ingest") || pathname.endsWith("/ingest/")) {
      const res = await handleIngest(req, body, debugId);
      return withIdentity(res, "ingest");
    }

    // POST /retry/:trace_id
    if (pathname.includes("/retry/")) {
      const res = await handleRetry(req, debugId);
      return withIdentity(res, "retry");
    }

    return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `No handler for ${pathname}. Available: /ingest, /status/:trace_id, /retry/:trace_id`, debugId), "error");

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[listing-bridge] Error debug_id=${debugId}:`, errMsg);
    return withIdentity(fail(req, 500, "INTERNAL_ERROR", `An internal error occurred. Reference: ${debugId}`, debugId), "error");
  }
});
