import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleOptions, ok, fail, checkBootstrapAdmin, makeDebugId, addIdentityHeaders } from "../_shared/http.ts";

const FUNCTION_NAME = "civiko-admin-secrets";
const ROUTE = "/admin/secrets";

const ALLOWED_SECRETS = [
  "FIRECRAWL_API_KEY",
  "OPENAI_API_KEY",
  "MAPBOX_ACCESS_TOKEN",
  "PERPLEXITY_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_MAPS_API_KEY",
];

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const identity = { function: FUNCTION_NAME, route: ROUTE };

  try {
    // 1. Security: only bootstrap admins (verified JWT) can manage secrets
    const { isAdmin, email } = await checkBootstrapAdmin(req);
    if (!isAdmin) {
      return addIdentityHeaders(
        fail(req, 403, "FORBIDDEN", "Only administrators can manage secrets", debugId),
        identity,
      );
    }

    if (req.method !== "POST") {
      return addIdentityHeaders(
        fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST to save a secret", debugId),
        identity,
      );
    }

    // 2. Parse payload
    const body = await req.json().catch(() => null);
    if (!body || typeof body.name !== "string" || typeof body.value !== "string" || !body.value.trim()) {
      return addIdentityHeaders(
        fail(req, 400, "BAD_REQUEST", "Missing or invalid 'name' or 'value' in request body", debugId),
        identity,
      );
    }

    const name = body.name.trim();
    const value = body.value;

    // 3. Validate secret name against allowlist
    if (!ALLOWED_SECRETS.includes(name)) {
      return addIdentityHeaders(
        fail(req, 400, "SECRET_NOT_ALLOWED", `Secret name not allowed. Must be one of: ${ALLOWED_SECRETS.join(", ")}`, debugId),
        identity,
      );
    }

    // 4. Save via Supabase Management API
    const projectRef = Deno.env.get("SUPABASE_PROJECT_REF");
    const accessToken = Deno.env.get("SUPABASE_ACCESS_TOKEN");

    if (!projectRef || !accessToken) {
      console.error(`[${FUNCTION_NAME}] Missing SUPABASE_PROJECT_REF or SUPABASE_ACCESS_TOKEN`);
      return addIdentityHeaders(
        fail(req, 500, "CONFIG_ERROR", "Server misconfigured: missing management credentials", debugId),
        identity,
      );
    }

    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ name, value }]),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[${FUNCTION_NAME}] Supabase Management API error: ${res.status} ${errorText}`);
      return addIdentityHeaders(
        fail(req, 502, "UPSTREAM_ERROR", "Failed to save secret to Supabase", debugId),
        identity,
      );
    }

    console.log(`[${FUNCTION_NAME}] secret saved name=${name} by=${email ?? "unknown"} debug_id=${debugId}`);

    return addIdentityHeaders(
      ok(req, { success: true, name, message: `Secret ${name} saved successfully` }, [], debugId),
      identity,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[${FUNCTION_NAME}] Unhandled error: ${msg}`);
    return addIdentityHeaders(
      fail(req, 500, "INTERNAL_ERROR", "Internal server error", debugId),
      identity,
    );
  }
});
