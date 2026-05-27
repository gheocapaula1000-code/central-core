// ═══════════════════════════════════════════════════════════════
// civiko-openapi-admin-test
// ───────────────────────────────────────────────────────────────
// Endpoint admin-only per testare OpenAPI Real Estate in SANDBOX.
// Non collegato al Dossier base. Non chiamato in automatico.
// Richiede:
//   - JWT Supabase valido
//   - Utente con ruolo admin (has_role) OPPURE bootstrap admin
//   - OPENAPI_IT_ENV=sandbox
//   - OPENAPI_IT_SANDBOX_ENABLED=true
// ═══════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  handleOptions, ok, fail, makeDebugId, addIdentityHeaders, isBootstrapAdmin,
} from "../_shared/http.ts";
import {
  openapiItGetSQMStart, openapiItGetSQMAdvanced, openapiItGetRMV,
  getOpenApiEnvironment, type OpenApiCallContext,
} from "../_shared/openapi-it.ts";

const FUNCTION_NAME = "civiko-openapi-admin-test";
const ROUTE = "/admin/openapi-test";
const IDENTITY = { function: FUNCTION_NAME, route: ROUTE };

const DAILY_LIMIT = 5;

// Costi teorici dichiarati nello spec del test admin (EUR).
const SPEC_COST_EUR: Record<string, number> = {
  sqm_start: 2,
  sqm_advanced: 3,
  rm_value: 4,
};

type EndpointKey = "sqm_start" | "sqm_advanced" | "rm_value";
type ContractType = "sale" | "rent";

interface Body {
  endpoint: EndpointKey;
  address: string;
  contractType: ContractType;
  propertyType: string;
  forceRefresh?: boolean;
}

function validate(body: unknown): { ok: true; data: Body } | { ok: false; msg: string } {
  if (!body || typeof body !== "object") return { ok: false, msg: "missing body" };
  const b = body as Record<string, unknown>;
  const endpoint = b.endpoint;
  if (endpoint !== "sqm_start" && endpoint !== "sqm_advanced" && endpoint !== "rm_value") {
    return { ok: false, msg: "endpoint must be sqm_start|sqm_advanced|rm_value" };
  }
  const address = typeof b.address === "string" ? b.address.trim() : "";
  if (!address) return { ok: false, msg: "address required" };
  if (address.length > 250) return { ok: false, msg: "address too long (max 250)" };

  // Restrizione geografica: solo Padova / CAP 351xx
  const lower = address.toLowerCase();
  const hasPadova = lower.includes("padova");
  const hasCap = /\b351\d{2}\b/.test(address);
  if (!hasPadova && !hasCap) {
    return { ok: false, msg: "address must contain 'Padova' or CAP 351xx" };
  }

  const contractType = b.contractType;
  if (contractType !== "sale" && contractType !== "rent") {
    return { ok: false, msg: "contractType must be sale|rent" };
  }
  const propertyType = typeof b.propertyType === "string" ? b.propertyType.trim() : "";
  if (!propertyType) return { ok: false, msg: "propertyType required" };

  const forceRefresh = b.forceRefresh === true;
  return { ok: true, data: { endpoint, address, contractType, propertyType, propertyType_: undefined as never, forceRefresh } as Body };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  try {
    if (req.method !== "POST") {
      return addIdentityHeaders(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), IDENTITY);
    }

    // 1. AuthN: JWT obbligatorio
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return addIdentityHeaders(fail(req, 401, "UNAUTHORIZED", "Missing bearer token", debugId), IDENTITY);
    }
    const token = authHeader.slice(7).trim();
    if (!token.startsWith("eyJ")) {
      return addIdentityHeaders(fail(req, 401, "UNAUTHORIZED", "Invalid token format", debugId), IDENTITY);
    }

    const supaUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supaUrl || !anonKey || !svcKey) {
      return addIdentityHeaders(fail(req, 500, "CONFIG_ERROR", "Server misconfigured", debugId), IDENTITY);
    }

    const userClient = createClient(supaUrl, anonKey);
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return addIdentityHeaders(fail(req, 401, "UNAUTHORIZED", "Invalid JWT", debugId), IDENTITY);
    }
    const userId = userData.user.id;
    const email = userData.user.email ?? "";

    // 2. AuthZ: admin via has_role oppure bootstrap admin
    const svc = createClient(supaUrl, svcKey, { auth: { persistSession: false } });
    let isAdmin = isBootstrapAdmin(email);
    if (!isAdmin) {
      const { data: roleData } = await svc.rpc("has_role", { _user_id: userId, _role: "admin" });
      isAdmin = roleData === true;
    }
    if (!isAdmin) {
      const { data: superRole } = await svc.rpc("has_role", { _user_id: userId, _role: "super_admin" }).catch(() => ({ data: null }));
      if (superRole === true) isAdmin = true;
    }
    if (!isAdmin) {
      return addIdentityHeaders(fail(req, 403, "FORBIDDEN", "admin role required", debugId), IDENTITY);
    }

    // 3. Environment gate (sandbox only)
    const env = getOpenApiEnvironment();
    if (env !== "sandbox") {
      return addIdentityHeaders(
        fail(req, 403, "ENV_BLOCKED", "OpenAPI admin test allowed only in sandbox", debugId),
        IDENTITY,
      );
    }
    const sandboxEnabled = (Deno.env.get("OPENAPI_IT_SANDBOX_ENABLED") ?? "").trim().toLowerCase() === "true";
    if (!sandboxEnabled) {
      return addIdentityHeaders(
        fail(req, 403, "SANDBOX_DISABLED", "OPENAPI_IT_SANDBOX_ENABLED must be true", debugId),
        IDENTITY,
      );
    }

    // 4. Parse + validate body
    const rawBody = await req.json().catch(() => null);
    const v = validate(rawBody);
    if (!v.ok) {
      return addIdentityHeaders(fail(req, 400, "BAD_REQUEST", v.msg, debugId), IDENTITY);
    }
    const body = v.data;

    // 5. Rate limit: 5 chiamate/giorno per admin in sandbox
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const { count: usedToday, error: rlErr } = await svc
      .from("openapi_it_call_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("environment", "sandbox")
      .gte("created_at", startOfDay.toISOString());
    if (rlErr) {
      console.error(`[${FUNCTION_NAME}] rate-limit query failed`);
    } else if ((usedToday ?? 0) >= DAILY_LIMIT) {
      return addIdentityHeaders(
        fail(req, 429, "RATE_LIMITED", `Daily sandbox limit reached (${DAILY_LIMIT})`, debugId),
        IDENTITY,
      );
    }

    // 6. Costruisci contesto premium + params
    const normalizedAddress = body.address.toLowerCase().replace(/\s+/g, " ").trim();
    const ctx: OpenApiCallContext = {
      userId,
      dossierId: undefined,
      explicitConsent: true,
      normalizedAddress,
      propertyType: body.propertyType,
      contract: body.contractType,
      debugId,
      // forceRefresh: bypassa cache azzerando TTL = 0 non basta (cache lookup salta solo se expires_at>now).
      // L'helper non espone bypass: per forceRefresh facciamo un primo round e, se cache_hit, ripetiamo
      // dopo aver invalidato la riga di cache via service client.
    };

    const params: Record<string, unknown> = {
      address: body.address,
      contract: body.contractType,
      property_type: body.propertyType,
    };

    // forceRefresh: invalida cache prima della chiamata (best-effort)
    if (body.forceRefresh) {
      try {
        await svc
          .from("openapi_it_cache")
          .delete()
          .eq("endpoint",
            body.endpoint === "sqm_start" ? "real_estate/sqm-start"
            : body.endpoint === "sqm_advanced" ? "real_estate/sqm-advanced"
            : "real_estate/rmv")
          .eq("normalized_address", normalizedAddress);
      } catch {
        console.error(`[${FUNCTION_NAME}] forceRefresh cache invalidation failed`);
      }
    }

    // Conta log PRE-chiamata per dedurre cache_hit
    const { count: logsBefore } = await svc
      .from("openapi_it_call_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("environment", "sandbox");

    let data: unknown = null;
    if (body.endpoint === "sqm_start") {
      data = await openapiItGetSQMStart(params, ctx);
    } else if (body.endpoint === "sqm_advanced") {
      data = await openapiItGetSQMAdvanced(params, ctx);
    } else {
      data = await openapiItGetRMV(params, ctx);
    }

    // Recupera l'ultimo log per leggere cache_hit reale
    const { data: lastLog } = await svc
      .from("openapi_it_call_log")
      .select("cache_hit, status, error_code")
      .eq("user_id", userId)
      .eq("environment", "sandbox")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const cacheHit = lastLog?.cache_hit === true;
    const estimatedCost = cacheHit ? 0 : (SPEC_COST_EUR[body.endpoint] ?? 0);

    return addIdentityHeaders(
      ok(req, {
        environment: "sandbox",
        endpoint: body.endpoint,
        cache_hit: cacheHit,
        estimated_cost_eur: estimatedCost,
        real_cost_eur: 0,
        status: lastLog?.status ?? "unknown",
        error_code: lastLog?.error_code ?? null,
        daily_used: (logsBefore ?? 0) + 1,
        daily_limit: DAILY_LIMIT,
        data,
      }, [], debugId),
      IDENTITY,
    );
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] exception`, err instanceof Error ? err.message : "unknown");
    return addIdentityHeaders(fail(req, 500, "INTERNAL_ERROR", "Unexpected error", debugId), IDENTITY);
  }
});
