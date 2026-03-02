export const CORE_VERSION = "3.2.0";

export function makeDebugId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];

export function isOriginAllowed(origin: string): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase();
  try {
    const u = new URL(o);
    if (u.hostname === "localhost" || u.hostname.startsWith("127.")) return true;
  } catch { /* not a valid URL */ }
  if (LOVABLE_SUFFIXES.some((s) => o.endsWith(s)) || o === "https://lovable.dev") return true;
  const allowed = (Deno.env.get("CORE_ALLOWED_ORIGINS") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return allowed.includes("*") || allowed.includes(o);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": isOriginAllowed(origin) ? origin : "null",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, " +
      "x-internal-secret, x-app-secret, x-core-secret, x-source-app, " +
      "x-supabase-client-platform, x-supabase-client-platform-version, " +
      "x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function handleOptions(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, status: number, body: unknown, debugId?: string): Response {
  const did = debugId ?? makeDebugId();
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "x-debug-id": did },
  });
}

export function ok(req: Request, data: unknown, warnings: string[] = [], debugId?: string): Response {
  const did = debugId ?? makeDebugId();
  return json(req, 200, { ok: true, data, warnings, debug_id: did }, did);
}

export function fail(req: Request, status: number, code: string, message: string, debugId?: string): Response {
  const did = debugId ?? makeDebugId();
  return json(req, status, { ok: false, data: null, warnings: [], debug_id: did, error: { code, message } }, did);
}

/** Checks all supported auth headers: x-internal-secret, x-app-secret, x-core-secret, Authorization Bearer */
export function requireSecret(req: Request, debugId: string): Response | null {
  const expected = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (!expected) {
    console.error("[requireSecret] CRITICAL: AI_CORE_SECRET env var is not set — all requests will be rejected with 500");
    return fail(req, 500, "CONFIG_ERROR", "AI_CORE_SECRET not configured", debugId);
  }
  const incoming =
    req.headers.get("x-internal-secret") ??
    req.headers.get("x-app-secret") ??
    req.headers.get("x-core-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") ??
    "";
  if (!incoming) return fail(req, 401, "APP_SECRET_REQUIRED", "Missing x-internal-secret", debugId);
  if (!constantTimeEqual(incoming, expected)) return fail(req, 401, "APP_SECRET_REJECTED", "Invalid secret", debugId);
  return null;
}
