// b2b-finder dedicated CORS helper.
// Isolated from other modules. Reads B2B_FINDER_ALLOWED_ORIGINS only.

const ALLOWED = (Deno.env.get("B2B_FINDER_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-source-app, x-internal-secret, x-debug-id";

export function pickOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (ALLOWED.length === 0) return null;
  return ALLOWED.includes(origin) ? origin : null;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = pickOrigin(req);
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function handlePreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = pickOrigin(req);
  if (!origin) {
    return new Response("forbidden origin", { status: 403 });
  }
  return new Response("ok", { headers: corsHeaders(req) });
}
