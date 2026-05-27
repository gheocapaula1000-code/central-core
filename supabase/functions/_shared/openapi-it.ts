// ═══════════════════════════════════════════════════════════════
// OpenAPI.it Real Estate — Server-only helper
// ───────────────────────────────────────────────────────────────
// REGOLE OBBLIGATORIE (vedi spec architettura premium):
//  - NON deve essere chiamato dal flusso standard del Dossier.
//  - Solo da endpoint premium/admin espliciti, dopo controllo:
//      utente autorizzato + piano abilitato + consenso esplicito.
//  - Cache obbligatoria: lookup per chiave normalizzata prima
//    di ogni chiamata. Se cache valida -> nessuna chiamata HTTP.
//  - Ogni chiamata viene loggata in openapi_it_call_log
//    con costo stimato, endpoint, user_id, agency_id, dossier_id.
//  - Mai throw verso il caller: in caso di errore -> null.
//  - Timeout 8 secondi (AbortController).
//  - Bearer token letto SOLO da Deno.env, mai loggato.
//  - Nessun testo user-facing prodotto qui.
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TIMEOUT_MS = 8000;
const DEFAULT_TTL_DAYS = 30;

// Costi stimati indicativi (in EUR) per logging/audit.
// Vanno aggiornati se OpenAPI modifica il listino.
const ESTIMATED_COST_EUR: Record<string, number> = {
  "real_estate/sqm-start": 0.10,
  "real_estate/sqm-advanced": 0.50,
  "real_estate/rmv": 1.00,
  "real_estate/catasto-lista": 0.20,
};

export type OpenApiEndpointKey =
  | "real_estate/sqm-start"
  | "real_estate/sqm-advanced"
  | "real_estate/rmv"
  | "real_estate/catasto-lista";

export interface OpenApiCallContext {
  /** ID dell'utente che ha richiesto la chiamata premium (richiesto). */
  userId: string;
  /** ID agenzia (per audit costi). */
  agencyId?: string;
  /** Dossier eventualmente collegato. */
  dossierId?: string;
  /** Conferma esplicita del consenso alla chiamata premium. */
  explicitConsent: true;
  /** Indirizzo già normalizzato (lowercase, no doppi spazi). */
  normalizedAddress?: string;
  /** Coordinate (opzionali, per chiave cache geografica). */
  lat?: number;
  lng?: number;
  /** Tipologia immobile (residenziale, commerciale, ecc.). */
  propertyType?: string;
  /** Contratto (vendita, affitto). */
  contract?: string;
  /** TTL personalizzato in giorni (default 30). */
  cacheTtlDays?: number;
  /** debug_id correlato alla request principale (per tracciatura). */
  debugId?: string;
}

interface CacheLookupInput {
  endpoint: OpenApiEndpointKey;
  normalizedAddress?: string;
  lat?: number;
  lng?: number;
  propertyType?: string;
  contract?: string;
  requestParams: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────
// Supabase service client (lazy)
// ───────────────────────────────────────────────────────────────
let _svc: SupabaseClient | null = null;
function svcClient(): SupabaseClient | null {
  if (_svc) return _svc;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("[openapi-it] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return null;
  }
  _svc = createClient(url, key, { auth: { persistSession: false } });
  return _svc;
}

// ───────────────────────────────────────────────────────────────
// Chiave cache
// ───────────────────────────────────────────────────────────────
function scaleCoord(v?: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // 4 decimali (~11m) per cache-key spaziale
  return Math.round(v * 10_000);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildCacheKey(input: CacheLookupInput): Promise<string> {
  const parts = {
    e: input.endpoint,
    a: (input.normalizedAddress ?? "").trim().toLowerCase(),
    la: scaleCoord(input.lat),
    ln: scaleCoord(input.lng),
    p: (input.propertyType ?? "").toLowerCase(),
    c: (input.contract ?? "").toLowerCase(),
    q: input.requestParams,
  };
  return await sha256Hex(JSON.stringify(parts));
}

// ───────────────────────────────────────────────────────────────
// Cache lookup / write
// ───────────────────────────────────────────────────────────────
async function cacheLookup(cacheKey: string): Promise<unknown | null> {
  const sb = svcClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("openapi_it_cache")
      .select("response_payload, expires_at")
      .eq("cache_key", cacheKey)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) {
      console.error("[openapi-it] cache lookup error");
      return null;
    }
    return data?.response_payload ?? null;
  } catch {
    console.error("[openapi-it] cache lookup exception");
    return null;
  }
}

async function cacheWrite(
  cacheKey: string,
  endpoint: OpenApiEndpointKey,
  input: CacheLookupInput,
  payload: unknown,
  ttlDays: number,
): Promise<void> {
  const sb = svcClient();
  if (!sb) return;
  const expires = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  try {
    await sb.from("openapi_it_cache").upsert(
      {
        cache_key: cacheKey,
        endpoint,
        normalized_address: input.normalizedAddress ?? null,
        lat_scaled: scaleCoord(input.lat),
        lng_scaled: scaleCoord(input.lng),
        property_type: input.propertyType ?? null,
        contract: input.contract ?? null,
        request_params: input.requestParams,
        response_payload: payload as Record<string, unknown>,
        expires_at: expires,
      },
      { onConflict: "cache_key" },
    );
  } catch {
    console.error("[openapi-it] cache write failed");
  }
}

// ───────────────────────────────────────────────────────────────
// Logging
// ───────────────────────────────────────────────────────────────
interface LogParams {
  endpoint: OpenApiEndpointKey;
  ctx: OpenApiCallContext;
  cacheHit: boolean;
  status: "ok" | "error" | "skipped";
  httpStatus?: number;
  errorCode?: string;
  durationMs?: number;
}

async function logCall(p: LogParams): Promise<void> {
  const sb = svcClient();
  if (!sb) return;
  const cost = p.cacheHit ? 0 : (ESTIMATED_COST_EUR[p.endpoint] ?? 0);
  try {
    await sb.from("openapi_it_call_log").insert({
      endpoint: p.endpoint,
      user_id: p.ctx.userId,
      agency_id: p.ctx.agencyId ?? null,
      dossier_id: p.ctx.dossierId ?? null,
      cache_hit: p.cacheHit,
      status: p.status,
      http_status: p.httpStatus ?? null,
      estimated_cost_eur: cost,
      debug_id: p.ctx.debugId ?? null,
      error_code: p.errorCode ?? null,
      duration_ms: p.durationMs ?? null,
    });
  } catch {
    console.error("[openapi-it] log insert failed");
  }
}

// ───────────────────────────────────────────────────────────────
// Validazione contesto premium (gate obbligatorio)
// ───────────────────────────────────────────────────────────────
function gateOk(ctx: OpenApiCallContext): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  if (!ctx.userId) {
    console.error("[openapi-it] premium gate failed: missing userId");
    return false;
  }
  if (ctx.explicitConsent !== true) {
    console.error("[openapi-it] premium gate failed: missing explicit consent");
    return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────
// Chiamata HTTP generica (mai throw)
// ───────────────────────────────────────────────────────────────
async function callOpenApi<T = unknown>(
  endpoint: OpenApiEndpointKey,
  params: Record<string, unknown>,
  ctx: OpenApiCallContext,
): Promise<T | null> {
  if (!gateOk(ctx)) {
    await logCall({ endpoint, ctx, cacheHit: false, status: "skipped", errorCode: "GATE_DENIED" });
    return null;
  }

  const token = Deno.env.get("OPENAPI_IT_TOKEN");
  const baseUrl = Deno.env.get("OPENAPI_IT_BASE_URL");
  if (!token || !baseUrl) {
    console.error("[openapi-it] missing token or base url");
    await logCall({ endpoint, ctx, cacheHit: false, status: "skipped", errorCode: "NOT_CONFIGURED" });
    return null;
  }

  const lookup: CacheLookupInput = {
    endpoint,
    normalizedAddress: ctx.normalizedAddress,
    lat: ctx.lat,
    lng: ctx.lng,
    propertyType: ctx.propertyType,
    contract: ctx.contract,
    requestParams: params,
  };

  const cacheKey = await buildCacheKey(lookup);
  const cached = await cacheLookup(cacheKey);
  if (cached !== null) {
    await logCall({ endpoint, ctx, cacheHit: true, status: "ok" });
    return cached as T;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;

    if (!res.ok) {
      console.error(`[openapi-it] http ${res.status} on ${endpoint}`);
      await logCall({
        endpoint, ctx, cacheHit: false, status: "error",
        httpStatus: res.status, errorCode: `HTTP_${res.status}`, durationMs,
      });
      return null;
    }

    const payload = await res.json().catch(() => null);
    if (payload == null) {
      await logCall({ endpoint, ctx, cacheHit: false, status: "error", errorCode: "INVALID_JSON", durationMs });
      return null;
    }

    await cacheWrite(cacheKey, endpoint, lookup, payload, ctx.cacheTtlDays ?? DEFAULT_TTL_DAYS);
    await logCall({ endpoint, ctx, cacheHit: false, status: "ok", httpStatus: res.status, durationMs });
    return payload as T;
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof DOMException && err.name === "AbortError";
    console.error(`[openapi-it] ${aborted ? "timeout" : "exception"} on ${endpoint}`);
    await logCall({
      endpoint, ctx, cacheHit: false, status: "error",
      errorCode: aborted ? "TIMEOUT" : "EXCEPTION",
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
}

// ───────────────────────────────────────────────────────────────
// API pubbliche (server-only)
// ───────────────────────────────────────────────────────────────
export async function openapiItGetSQMStart<T = unknown>(
  params: Record<string, unknown>,
  ctx: OpenApiCallContext,
): Promise<T | null> {
  return callOpenApi<T>("real_estate/sqm-start", params, ctx);
}

export async function openapiItGetSQMAdvanced<T = unknown>(
  params: Record<string, unknown>,
  ctx: OpenApiCallContext,
): Promise<T | null> {
  return callOpenApi<T>("real_estate/sqm-advanced", params, ctx);
}

export async function openapiItGetRMV<T = unknown>(
  params: Record<string, unknown>,
  ctx: OpenApiCallContext,
): Promise<T | null> {
  return callOpenApi<T>("real_estate/rmv", params, ctx);
}

export async function openapiItGetCatastoLista<T = unknown>(
  params: Record<string, unknown>,
  ctx: OpenApiCallContext,
): Promise<T | null> {
  return callOpenApi<T>("real_estate/catasto-lista", params, ctx);
}

// Esposto solo per test / monitoring interni.
export const __openApiItInternals = { buildCacheKey, scaleCoord };
