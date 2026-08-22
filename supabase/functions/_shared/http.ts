export const CORE_VERSION = "3.4.6";
export const CORE_CONTRACT = "central-core-v3";

// ═══════════════════════════════════════════════════════════════
// Admin Bypass — REMOVED
// Admin bypass based on unverified client headers/body has been
// eliminated. Any privileged operation must use a verified JWT
// or server-to-server secret. The functions normalizeEmail and
// isAdminBypassEmail are kept as no-ops for import compatibility
// but always return safe defaults.
// ═══════════════════════════════════════════════════════════════

/** Normalize email: trim + lowercase. Kept for import compat. */
export function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/**
 * DEPRECATED — always returns false.
 * Admin bypass from unverified input has been removed.
 * Use verified JWT or server-to-server auth instead.
 */
export function isAdminBypassEmail(_email: string | null | undefined): boolean {
  return false;
}

/**
 * DEPRECATED — always returns { bypass: false }.
 * Admin bypass from unverified headers/body has been removed.
 */
export function checkAdminBypass(
  _req: Request,
  _body?: Record<string, unknown>,
): { bypass: boolean; email?: string; _masked?: string } {
  return { bypass: false };
}

// ═══════════════════════════════════════════════════════════════
// Per-App Secret Resolution
// Reduces blast radius: each PWA uses its own secret.
// Falls back to legacy AI_CORE_SECRET with a warning.
// ═══════════════════════════════════════════════════════════════

export const APP_SECRET_MAP: Record<string, string> = {
  wyloni: "AI_CORE_SECRET_WYLONI",
  keydraft: "AI_CORE_SECRET_KEYDRAFT",
  sottra: "AI_CORE_SECRET_SOTTRA",
  regiads: "AI_CORE_SECRET_REGIADS",
  pratica: "AI_CORE_SECRET_PRATICA",
  civiko: "AI_CORE_SECRET_CIVIKO",
  "civiko-one": "AI_CORE_SECRET_CIVIKO",
  civiko_one: "AI_CORE_SECRET_CIVIKO",
  acquisitionradar: "AI_CORE_SECRET_ACQUISITIONRADAR",
};

const KNOWN_APPS = new Set(Object.keys(APP_SECRET_MAP));

/**
 * Resolve the expected secret for a given source app.
 * Priority:
 *   1. Per-app secret (AI_CORE_SECRET_WYLONI, etc.) if configured
 *   2. Legacy shared AI_CORE_SECRET (transitional fallback, with warning)
 *   3. Empty string → will cause auth rejection
 */
function resolveExpectedSecret(sourceApp: string): { secret: string; mode: "per-app" | "legacy" | "missing" } {
  const normalized = sourceApp.toLowerCase().trim();

  // Try per-app secret first
  const envName = APP_SECRET_MAP[normalized];
  if (envName) {
    const perAppVal = Deno.env.get(envName) ?? "";
    if (perAppVal) return { secret: perAppVal, mode: "per-app" };
  }

  // Fallback to legacy shared secret
  const legacy = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (legacy) {
    if (KNOWN_APPS.has(normalized)) {
      console.warn(`[requireSecret] DEPRECATION: source_app=${normalized} using legacy AI_CORE_SECRET — configure ${envName} for segmented auth`);
    } else if (!normalized) {
      console.warn(`[requireSecret] DEPRECATION: empty x-source-app using legacy AI_CORE_SECRET — x-source-app will become mandatory`);
    }
    return { secret: legacy, mode: "legacy" };
  }

  return { secret: "", mode: "missing" };
}

/**
 * Resolve secret for internal Core→Core calls (e.g. listing-bridge → sottra).
 * Uses the per-app secret for the TARGET service, falling back to legacy.
 * This is the canonical helper for all internal edge-function-to-edge-function calls.
 */
export function resolveInternalSecret(targetApp: string): { secret: string; mode: "per-app" | "legacy" | "missing"; envName: string } {
  const normalized = targetApp.toLowerCase().trim();
  const envName = APP_SECRET_MAP[normalized] ?? `AI_CORE_SECRET_${normalized.toUpperCase()}`;

  // Try per-app secret for the target
  const perAppVal = Deno.env.get(envName) ?? "";
  if (perAppVal) return { secret: perAppVal, mode: "per-app", envName };

  // Fallback to legacy shared secret
  const legacy = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (legacy) {
    console.warn(`[resolveInternalSecret] DEPRECATION: target=${normalized} using legacy AI_CORE_SECRET — configure ${envName} for segmented auth`);
    return { secret: legacy, mode: "legacy", envName };
  }

  return { secret: "", mode: "missing", envName };
}

// ═══════════════════════════════════════════════════════════════
// Bootstrap Admin — server-side only, verified-JWT identity
// No client header/body/query can grant admin privileges.
//
// Access tiers:
//   1. Owner/Admin: CORE_ADMIN_BOOTSTRAP_EMAILS (only gheocapaula1000@gmail.com)
//      → Full admin, diagnostics, rate-limit bypass, all routes
//   2. User bypass (cross-app): CORE_USER_BYPASS_EMAILS
//      → Non-paying user with full user-facing access, NO admin
//   3. Wyloni-only bypass: CORE_WYLONI_BYPASS_EMAILS
//      → Non-paying user bypass ONLY when x-source-app=wyloni, NO admin
// ═══════════════════════════════════════════════════════════════

/** Parse a comma-separated email allowlist from an env var */
function parseEmailAllowlist(envName: string): string[] {
  const raw = Deno.env.get(envName) ?? "";
  if (!raw.trim()) return [];
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Validate and normalize an email for comparison */
function normalizeVerifiedEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return "";
  return normalized;
}

/**
 * Check if a verified email belongs to a bootstrap admin/owner.
 * The email MUST come from a verified source (JWT or server-side).
 * NEVER pass emails from client headers, body, or query strings.
 *
 * Reads CORE_ADMIN_BOOTSTRAP_EMAILS from env (comma-separated).
 * Returns false if the env var is not set or empty.
 */
export function isBootstrapAdmin(verifiedEmail: string): boolean {
  const normalized = normalizeVerifiedEmail(verifiedEmail);
  if (!normalized) return false;
  const allowlist = parseEmailAllowlist("CORE_ADMIN_BOOTSTRAP_EMAILS");
  return allowlist.includes(normalized);
}

/**
 * Check if a verified email has user-facing service bypass (non-paying user).
 * This does NOT grant admin privileges — only bypasses trial/plan/quota/paywall.
 *
 * Cross-app bypass: CORE_USER_BYPASS_EMAILS (e.g. matteo.ippolito@gmail.com)
 * Wyloni-only bypass: CORE_WYLONI_BYPASS_EMAILS (only when sourceApp is "wyloni")
 *
 * Admin emails always get bypass too (superset).
 */
export function isServiceBypassUser(verifiedEmail: string, sourceApp?: string): boolean {
  const normalized = normalizeVerifiedEmail(verifiedEmail);
  if (!normalized) return false;

  // Admins always bypass
  if (isBootstrapAdmin(verifiedEmail)) return true;

  // Cross-app bypass users
  const crossAppList = parseEmailAllowlist("CORE_USER_BYPASS_EMAILS");
  if (crossAppList.includes(normalized)) return true;

  // Wyloni-only bypass users (only if sourceApp is verifiably "wyloni")
  const app = (sourceApp ?? "").toLowerCase().trim();
  if (app === "wyloni") {
    const wyloniList = parseEmailAllowlist("CORE_WYLONI_BYPASS_EMAILS");
    if (wyloniList.includes(normalized)) return true;
  }

  return false;
}

/**
 * Extract verified email from Supabase JWT (Authorization: Bearer <jwt>).
 * Returns null if no valid JWT, verification fails, or no Supabase config.
 * This is the ONLY approved method to obtain user identity for admin/bypass checks.
 */
export async function extractVerifiedEmail(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  // JWTs start with eyJ — skip non-JWT tokens (e.g. app secrets)
  if (!token.startsWith("eyJ")) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) return null;
    return user.email;
  } catch {
    return null;
  }
}

/**
 * Combined check: extract verified JWT email + check bootstrap admin.
 * Returns { isAdmin, isBypass, email } with the verified privilege level.
 * Best-effort: failures default to non-admin, non-bypass (safe default).
 */
export async function checkBootstrapAdmin(req: Request, sourceApp?: string): Promise<{
  isAdmin: boolean;
  isBypass: boolean;
  email?: string;
}> {
  try {
    const email = await extractVerifiedEmail(req);
    if (!email) return { isAdmin: false, isBypass: false };
    const norm = normalizeEmail(email);
    const isAdmin = isBootstrapAdmin(email);
    const isBypass = isServiceBypassUser(email, sourceApp);
    if (isAdmin) console.log(`[bootstrap] admin verified debug_source=checkBootstrapAdmin`);
    else if (isBypass) console.log(`[bootstrap] service-bypass verified source_app=${sourceApp ?? "unknown"}`);
    return { isAdmin, isBypass, email: norm };
  } catch {
    return { isAdmin: false, isBypass: false };
  }
}

// ═══════════════════════════════════════════════════════════════
// Identity headers — non-sensitive, diagnostic-only
// ═══════════════════════════════════════════════════════════════
export interface CoreIdentity {
  function: string;
  route: string;
}

export function addIdentityHeaders(res: Response, identity: CoreIdentity): Response {
  res.headers.set("X-Core-Version", CORE_VERSION);
  res.headers.set("X-Core-Function", identity.function);
  res.headers.set("X-Core-Route", identity.route);
  res.headers.set("X-Core-Contract", CORE_CONTRACT);
  return res;
}

// ═══════════════════════════════════════════════════════════════
// Manifest builder — public, non-sensitive self-description
// ═══════════════════════════════════════════════════════════════
export interface ManifestOptions {
  functionName: string;
  serviceKind: string;
  expectedBasePath: string;
  routes: string[];
  domains?: string[];
  callingMode?: "proxy" | "direct";
}

export function buildManifest(opts: ManifestOptions): Record<string, unknown> {
  return {
    contract: CORE_CONTRACT,
    function: opts.functionName,
    serviceKind: opts.serviceKind,
    expectedBasePath: opts.expectedBasePath,
    routes: opts.routes,
    ...(opts.domains ? { domains: opts.domains } : {}),
    callingMode: opts.callingMode ?? "proxy",
  };
}

export function makeDebugId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// ═══════════════════════════════════════════════════════════════
// Sensitive data redaction — used by diagnostics, logging, error payloads
// ═══════════════════════════════════════════════════════════════
const _REDACT_PATTERNS = [
  /API[_-]?KEY/i,
  /SECRET/i,
  /PASSWORD/i,
  /TOKEN/i,
  /SERVICE[_-]?ROLE/i,
  /AUTHORIZATION/i,
  /ALLOWED[_-]?ORIGINS/i,
  /ADMIN[_-]?EMAILS/i,
];

/**
 * Redact sensitive values from a string.
 * Replaces env var values and patterns that look like secrets with [REDACTED].
 * Safe to use in logs, diagnostics, and error messages.
 */
export function redactSensitive(value: string): string {
  if (!value) return value;
  let result = value;

  // Redact known secret env var values (including per-app secrets)
  const secretNames = [
    "AI_CORE_SECRET", "AI_CORE_SECRET_WYLONI", "AI_CORE_SECRET_KEYDRAFT",
    "AI_CORE_SECRET_SOTTRA", "AI_CORE_SECRET_REGIADS", "AI_CORE_SECRET_PRATICA",
    "AI_CORE_SECRET_CIVIKO", "AI_CORE_SECRET_ACQUISITIONRADAR",
    "DIAGNOSTIC_SECRET", "DIAGNOSTIC_SELFTEST_SECRET",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY",
    "FIRECRAWL_API_KEY", "GOOGLE_MAPS_API_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "CORE_ALLOWED_ORIGINS",
    "AI_CORE_ADMIN_EMAILS", "CORE_ADMIN_BOOTSTRAP_EMAILS",
    "CORE_USER_BYPASS_EMAILS", "CORE_WYLONI_BYPASS_EMAILS",
  ];
  for (const name of secretNames) {
    const val = Deno.env.get(name);
    if (val && val.length > 3 && result.includes(val)) {
      result = result.replaceAll(val, "[REDACTED]");
    }
  }

  // Redact Bearer tokens
  result = result.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

  return result;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

/** True when x-job-secret matches CENTRAL_CORE_JOB_SECRET (both non-empty). */
export function isJobSecretAuthorized(req: Request, expected?: string): boolean {
  const exp = expected ?? Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const incoming = req.headers.get("x-job-secret") ?? "";
  return Boolean(exp && incoming && constantTimeEqual(incoming, exp));
}

const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];
const TRUSTED_APP_HOSTS = new Set(["keydraft.app", "www.keydraft.app", "wyloni.app", "www.wyloni.app", "wyloni.com", "www.wyloni.com", "sottra.app", "www.sottra.app", "civikoone.com", "www.civikoone.com", "ueradar.com", "www.ueradar.com"]);

function normalizeOrigin(value: string): string {
  const raw = value.toLowerCase().trim().replace(/\/+$/, "");

  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${host}${port}`;
  } catch {
    const hostOnly = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (hostOnly) return `https://${hostOnly}`;
    return raw;
  }
}

export function isOriginAllowed(origin: string): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase().trim();

  try {
    const u = new URL(o);
    if (u.hostname === "localhost" || u.hostname.startsWith("127.")) return true;
    if (TRUSTED_APP_HOSTS.has(u.hostname)) return true;
  } catch { /* not a valid URL */ }

  if (LOVABLE_SUFFIXES.some((s) => o.endsWith(s)) || o === "https://lovable.dev") return true;

  const normalizedOrigin = normalizeOrigin(o);
  const allowed = (Deno.env.get("CORE_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.includes("*")) return true;
  return allowed.some((entry) => normalizeOrigin(entry) === normalizedOrigin);
}

/**
 * Build CORS headers — no blind echo.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const requestedHeaders = (req.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const baseAllowedHeaders = [
    "authorization",
    "apikey",
    "content-type",
    "x-client-info",
    "x-client-device",
    "x-internal-secret",
    "x-app-secret",
    "x-core-secret",
    "x-diagnostic-secret",
    "x-source-app",
    "x-workspace-id",
    "x-tenant-id",
    "x-user-id",
    "x-supabase-client-platform",
    "x-supabase-client-platform-version",
    "x-supabase-client-runtime",
    "x-supabase-client-runtime-version",
  ];

  const allowHeaders = Array.from(new Set([...baseAllowedHeaders, ...requestedHeaders])).join(", ");

  let allowOrigin: string;
  if (!origin) {
    allowOrigin = "*";
  } else if (isOriginAllowed(origin)) {
    allowOrigin = origin;
  } else {
    allowOrigin = "";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function enforceOriginPolicy(req: Request, debugId: string): Response | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (isOriginAllowed(origin)) return null;
  console.warn(`[origin-policy] rejected origin=${origin} debug_id=${debugId}`);
  return fail(req, 403, "ORIGIN_NOT_ALLOWED", "Origin not in allowlist", debugId);
}

export function handleOptions(req: Request): Response {
  const origin = req.headers.get("origin");
  if (origin && !isOriginAllowed(origin)) {
    console.warn(`[options] rejected origin=${origin}`);
    return new Response(JSON.stringify({ ok: false, data: null, error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not in allowlist" } }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Vary": "Origin" },
    });
  }
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

/**
 * Per-app secret authentication.
 * Resolves the correct secret based on x-source-app header:
 *   1. Per-app secret (AI_CORE_SECRET_WYLONI, etc.)
 *   2. Legacy AI_CORE_SECRET fallback (with deprecation warning)
 * Checks all supported auth headers: x-internal-secret, x-app-secret, x-core-secret, Authorization Bearer.
 */
export function requireSecret(req: Request, debugId: string): Response | null {
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();

  const { secret: expected, mode } = resolveExpectedSecret(sourceApp);
  if (!expected) {
    const detail = mode === "missing" ? "No secret configured" : "Secret resolution failed";
    console.error(`[requireSecret] CRITICAL: ${detail} for source_app=${sourceApp || "(empty)"} — rejecting with 500`);
    return fail(req, 500, "CONFIG_ERROR", "Authentication not configured", debugId);
  }

  const incoming =
    req.headers.get("x-internal-secret") ??
    req.headers.get("x-app-secret") ??
    req.headers.get("x-core-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") ??
    "";
  if (!incoming) return fail(req, 401, "APP_SECRET_REQUIRED", "Missing x-internal-secret", debugId);
  if (!constantTimeEqual(incoming, expected)) {
    const origin = req.headers.get("origin") ?? "";
    console.warn(`[requireSecret] rejected source_app=${sourceApp || "(empty)"} origin=${origin} incoming_len=${incoming.length} mode=${mode}`);
    return fail(req, 401, "APP_SECRET_REJECTED", "Invalid secret", debugId);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Checkpoint 1B — Civiko cost-bearing endpoints guard
//
// Restricted guard used ONLY by the expensive Civiko endpoints
// (content studio, property-from-photo). It does not change the
// behaviour of requireSecret, resolveExpectedSecret, or any other
// application mapping.
//
// TEMPORARY CORE_INTERNAL_SECRET FALLBACK:
//   The existing Civiko One PWA proxy (supabase/functions/core-proxy)
//   always sends x-internal-secret using CORE_INTERNAL_SECRET, with
//   x-source-app defaulting to "acquisitionradar". The values of
//   CORE_INTERNAL_SECRET and the canonical per-app secrets are NOT
//   assumed to be equal, so CORE_INTERNAL_SECRET is accepted as an
//   additional candidate for compatibility with that proxy only.
//   This fallback is restricted to the Civiko source apps below and
//   MUST be removed after Checkpoint 1C.
// ═══════════════════════════════════════════════════════════════

/** Source apps allowed to reach the cost-bearing Civiko endpoints. */
const CIVIKO_COST_SOURCE_APPS = new Set([
  "civiko",
  "civiko-one",
  "civiko_one",
  // transitional: default x-source-app of the existing Civiko PWA proxy
  "acquisitionradar",
]);

/**
 * Guard for cost-bearing Civiko endpoints.
 * Accepts the canonical per-app secret resolved for x-source-app, or —
 * temporarily — CORE_INTERNAL_SECRET (see note above).
 * Never accepts DIAGNOSTIC_SECRET or CENTRAL_CORE_JOB_SECRET.
 * Never logs values, lengths, prefixes, suffixes, fingerprints, or which
 * candidate matched.
 */
export function requireCivikoCostSecret(req: Request, debugId: string): Response | null {
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();
  if (!sourceApp || !CIVIKO_COST_SOURCE_APPS.has(sourceApp)) {
    return fail(req, 401, "APP_SECRET_REQUIRED", "Missing or invalid application identity", debugId);
  }

  const candidates: string[] = [];
  const { secret: canonical } = resolveExpectedSecret(sourceApp);
  if (canonical) candidates.push(canonical);
  const proxyCompat = Deno.env.get("CORE_INTERNAL_SECRET") ?? "";
  if (proxyCompat) candidates.push(proxyCompat);

  if (candidates.length === 0) {
    console.error("[requireCivikoCostSecret] CRITICAL: no server-side candidate configured — rejecting with 500");
    return fail(req, 500, "CONFIG_ERROR", "Authentication not configured", debugId);
  }

  const incoming =
    req.headers.get("x-internal-secret") ??
    req.headers.get("x-app-secret") ??
    req.headers.get("x-core-secret") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!incoming) return fail(req, 401, "APP_SECRET_REQUIRED", "Missing application secret", debugId);

  let matched = false;
  for (const candidate of candidates) {
    // constant-time comparison; no early exit on match
    if (constantTimeEqual(incoming, candidate)) matched = true;
  }
  if (!matched) {
    console.warn(`[requireCivikoCostSecret] rejected source_app=${sourceApp} debug_id=${debugId}`);
    return fail(req, 401, "APP_SECRET_REJECTED", "Invalid secret", debugId);
  }
  return null;
}


/** Checks diagnostic secret header: x-diagnostic-secret */
export function requireDiagnosticSecret(req: Request, debugId: string): Response | null {
  const expected = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  if (!expected) {
    console.error("[requireDiagnosticSecret] DIAGNOSTIC_SECRET env var is not set");
    return fail(req, 500, "CONFIG_ERROR", "DIAGNOSTIC_SECRET not configured", debugId);
  }
  const incoming = req.headers.get("x-diagnostic-secret") ?? "";
  if (!incoming) return fail(req, 401, "DIAGNOSTIC_SECRET_REQUIRED", "Missing x-diagnostic-secret header", debugId);
  if (!constantTimeEqual(incoming, expected)) {
    console.warn(`[requireDiagnosticSecret] rejected debug_id=${debugId} incoming_len=${incoming.length}`);
    return fail(req, 401, "DIAGNOSTIC_SECRET_REJECTED", "Invalid diagnostic secret", debugId);
  }
  return null;
}
