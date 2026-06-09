// keydraft-bridge — ponte sicuro tra KeyDraft (Lovable app esterna) e Central Core.
// Auth: header x-internal-secret == KEYDRAFT_BRIDGE_SECRET (canale isolato).
// Non chiama Apify. Instrada solo verso endpoint esistenti via fetch interna.

import {
  corsHeaders,
  handleOptions,
  constantTimeEqual,
  makeDebugId,
  resolveInternalSecret,
} from "../_shared/http.ts";

const FUNCTION_NAME = "keydraft-bridge";

function respond(req: Request, status: number, body: unknown, debugId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "x-debug-id": debugId,
      "x-core-function": FUNCTION_NAME,
    },
  });
}

function okEnv(req: Request, data: unknown, debugId: string) {
  return respond(req, 200, { ok: true, data, debug_id: debugId }, debugId);
}
function failEnv(req: Request, status: number, code: string, message: string, debugId: string) {
  return respond(req, status, { ok: false, error: { code, message }, debug_id: debugId }, debugId);
}

function healthPayload() {
  return { ok: true, status: "healthy", service: "central-core", ts: new Date().toISOString() };
}

async function callInternal(targetFn: string, route: string, body: unknown, debugId: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${targetFn}${route}`;
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret) {
    throw new Error(`CENTRAL_CORE_JOB_SECRET not configured (target=${targetFn})`);
  }
  const { secret } = resolveInternalSecret("civiko");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-job-secret": jobSecret,
    "x-source-app": "civiko",
    "x-debug-id": debugId,
  };
  if (secret) headers["x-internal-secret"] = secret;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}


Deno.serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const pathname = url.pathname;

  // GET health endpoints — public, no auth (KeyDraft self-test probes /health and /__health)
  if (req.method === "GET") {
    if (pathname.endsWith("/health") || pathname.endsWith("/__health") || pathname.endsWith("/keydraft-bridge")) {
      return okEnv(req, healthPayload(), debugId);
    }
    return failEnv(req, 404, "NOT_FOUND", "Unknown GET route", debugId);
  }

  if (req.method !== "POST") {
    return failEnv(req, 405, "METHOD_NOT_ALLOWED", "Use POST or GET /health", debugId);
  }

  // Auth — x-internal-secret vs KEYDRAFT_BRIDGE_SECRET
  const expected = Deno.env.get("KEYDRAFT_BRIDGE_SECRET") ?? "";
  if (!expected) {
    console.error("[keydraft-bridge] KEYDRAFT_BRIDGE_SECRET not configured");
    return failEnv(req, 500, "CONFIG_ERROR", "Bridge secret not configured", debugId);
  }
  const incoming = req.headers.get("x-internal-secret") ?? "";
  if (!incoming || !constantTimeEqual(incoming, expected)) {
    return failEnv(req, 401, "UNAUTHORIZED", "Invalid or missing x-internal-secret", debugId);
  }

  const sourceApp = req.headers.get("x-source-app") ?? "(unset)";

  let body: { action?: string; payload?: Record<string, unknown> } = {};
  try { body = await req.json(); } catch { /* tolerate empty */ }

  const action = (body.action ?? "").trim();
  const payload = body.payload ?? {};
  console.log(`[keydraft-bridge] action=${action} source=${sourceApp} debug_id=${debugId}`);

  if (!action) return failEnv(req, 400, "BAD_REQUEST", "Missing 'action' in body", debugId);

  try {
    switch (action) {
      case "ping":
        return okEnv(req, { ok: true, app: "central-core", ts: new Date().toISOString() }, debugId);

      case "health":
        return okEnv(req, healthPayload(), debugId);

      case "zone-quartieri": {
        const r = await callInternal("civiko-radar-veneto", "/zone-quartieri", payload, debugId);
        return respond(req, r.status, r.body, debugId);
      }

      case "lead-quartiere": {
        const r = await callInternal("civiko-radar-veneto", "/lead-quartiere", payload, debugId);
        return respond(req, r.status, r.body, debugId);
      }

      default:
        return failEnv(req, 400, "UNKNOWN_ACTION", `Action '${action}' not supported`, debugId);
    }
  } catch (e) {
    console.error(`[keydraft-bridge] error action=${action}: ${e instanceof Error ? e.message : String(e)}`);
    return failEnv(req, 500, "BRIDGE_ERROR", e instanceof Error ? e.message : "Internal error", debugId);
  }
});
