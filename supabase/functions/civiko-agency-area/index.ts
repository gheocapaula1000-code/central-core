// civiko-agency-area
// Server-side proxy: PWA -> civiko-radar-veneto/agency/*
// - Verifies user JWT (anon key client + auth.getUser(token))
// - Injects x-job-secret, x-user-id, x-user-email server-side
// - Whitelists routes
// - Never trusts user_id from body
// - Never logs secrets
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders, handleOptions, isOriginAllowed } from "../_shared/http.ts";

const ALLOWED_ROUTES = new Set([
  "personal",
  "operating-areas/list",
  "operating-areas/create",
  "operating-areas/update",
  "operating-areas/deactivate",
  "signal-preferences/get",
  "signal-preferences/upsert",
]);

const TIMEOUT_MS = 20_000;

function jsonRes(req: Request, status: number, body: unknown, debug_id: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "x-debug-id": debug_id },
  });
}

function normalizeRoute(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let r = raw.trim().toLowerCase();
  r = r.replace(/^\/+/, "").replace(/^agency\//, "").replace(/\/+$/, "");
  if (!r) return null;
  return ALLOWED_ROUTES.has(r) ? r : null;
}

serve(async (req) => {
  const debug_id = (globalThis.crypto?.randomUUID?.() ?? `dbg-${Date.now()}`);

  if (req.method === "OPTIONS") return handleOptions(req);

  // Origin policy: allow missing Origin (server-to-server). Reject explicit invalid.
  const origin = req.headers.get("origin");
  if (origin && !isOriginAllowed(origin)) {
    return jsonRes(req, 403, { ok: false, error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not in allowlist" }, debug_id }, debug_id);
  }

  if (req.method !== "POST") {
    return jsonRes(req, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST allowed" }, debug_id }, debug_id);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !JOB_SECRET) {
    console.error("[agency-area] missing required env (names only)", {
      has_url: !!SUPABASE_URL, has_anon: !!SUPABASE_ANON_KEY, has_job_secret: !!JOB_SECRET, debug_id,
    });
    return jsonRes(req, 500, { ok: false, error: { code: "MISCONFIGURED", message: "Server misconfigured" }, debug_id }, debug_id);
  }

  // JWT auth
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return jsonRes(req, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Missing bearer token" }, debug_id }, debug_id);
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return jsonRes(req, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token" }, debug_id }, debug_id);
  }
  const userId = userData.user.id;
  const userEmail = (userData.user.email ?? "").trim();

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error("body must be object");
  } catch {
    return jsonRes(req, 400, { ok: false, error: { code: "INVALID_BODY", message: "Body must be JSON object" }, debug_id }, debug_id);
  }

  const route = normalizeRoute(body.route);
  if (!route) {
    return jsonRes(req, 403, { ok: false, error: { code: "ROUTE_NOT_ALLOWED", message: "Route not allowed" }, debug_id }, debug_id);
  }

  // Strip route from upstream payload; never trust user_id from body
  const { route: _r, user_id: _u, ...payload } = body;

  const upstreamUrl = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/agency/${route}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "x-job-secret": JOB_SECRET,
        "x-user-id": userId,
        "x-user-email": userEmail,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as { name?: string })?.name === "AbortError";
    console.error("[agency-area] upstream fetch failed", { debug_id, route, aborted });
    return jsonRes(req, aborted ? 504 : 502, {
      ok: false,
      error: { code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR", message: aborted ? "Upstream timeout" : "Upstream unreachable" },
      debug_id,
    }, debug_id);
  }
  clearTimeout(timer);

  const text = await upstreamRes.text();
  const headers = {
    ...corsHeaders(req),
    "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "x-debug-id": debug_id,
  };
  return new Response(text, { status: upstreamRes.status, headers });
});
