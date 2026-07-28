// civiko-zones-reserve — prenota una zona commerciale in trial (7gg) per l'agenzia chiamante.
// Auth: x-job-secret = CENTRAL_CORE_JOB_SECRET (server-to-server dal proxy Civiko One).
// I valori x-user-id / x-user-email / x-workspace-id arrivano già verificati dal proxy.
//
// Gate territoriale Padova Pilot v1: SOLO `centro-storico` prosegue.
// Il rifiuto (403 pilot_zone_locked) avviene PRIMA di qualsiasi insert,
// upsert o RPC: nessun client DB viene creato per gli slug respinti.

import {
  PADOVA_PILOT_ALLOWED_ZONE_SLUG,
  isPadovaPilotAllowedZoneSlug,
} from "../_shared/civikoTerritoryContractPadovaPilotV1.ts";

const civikoOneCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-source-app, x-job-secret, x-internal-secret, x-workspace-id, x-user-id, x-user-email",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...civikoOneCors, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getEnv(key: string): string {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  if (d?.env) return d.env.get(key) ?? "";
  const p = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  return p?.env?.[key] ?? "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Factory del client service-role: unico punto d'accesso al DB, iniettabile nei test. */
// deno-lint-ignore no-explicit-any
export type ServiceClientFactory = (url: string, key: string) => any;

const defaultServiceClientFactory: ServiceClientFactory = async (url, key) => {
  const spec: string = "https://esm.sh/@supabase/supabase-js@2.45.0";
  const { createClient } = await import(/* @vite-ignore */ spec);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

export async function handleZonesReserve(
  req: Request,
  createServiceClient: ServiceClientFactory = defaultServiceClientFactory,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "errore", message: "POST only" }, 405);
  }

  const debug_id = crypto.randomUUID();

  // --- 1) Auth server-to-server via shared secret ---
  const expected = getEnv("CENTRAL_CORE_JOB_SECRET");
  const provided =
    req.headers.get("x-job-secret") ??
    req.headers.get("x-internal-secret") ??
    "";
  if (!expected || !provided || !constantTimeEqual(provided, expected)) {
    return jsonResponse(
      { ok: false, error: "errore", message: "invalid or missing job secret", debug_id },
      401,
    );
  }

  // --- 2) Headers fidati (verificati a monte dal proxy Civiko One) ---
  const workspaceId = (req.headers.get("x-workspace-id") ?? "").trim();
  const userId = (req.headers.get("x-user-id") ?? "").trim();
  const userEmail = (req.headers.get("x-user-email") ?? "").trim() || null;

  if (!UUID_RE.test(workspaceId)) {
    return jsonResponse({ ok: false, error: "errore", message: "x-workspace-id missing or invalid", debug_id }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return jsonResponse({ ok: false, error: "errore", message: "x-user-id missing or invalid", debug_id }, 400);
  }

  // --- 3) Body ---
  let body: { slug?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "errore", message: "invalid JSON", debug_id }, 400);
  }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) {
    return jsonResponse({ ok: false, error: "errore", message: "slug required", debug_id }, 400);
  }
  // Territory Contract Padova Pilot v1 — fail-closed server-side:
  // solo `centro-storico` è riservabile nel pilot. Ogni altro slug
  // (inclusi slug legacy o manipolati dal client) viene respinto qui,
  // prima di qualsiasi scrittura o chiamata alle RPC.
  if (!isPadovaPilotAllowedZoneSlug(slug)) {
    return jsonResponse(
      {
        ok: false,
        error: "pilot_zone_locked",
        message: `Nel pilot v1 è riservabile solo la zona '${PADOVA_PILOT_ALLOWED_ZONE_SLUG}'.`,
        debug_id,
      },
      403,
    );
  }

  // --- 4) Service-role client ---
  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ ok: false, error: "errore", message: "core config missing", debug_id }, 500);
  }
  const svc = await createServiceClient(supabaseUrl, serviceKey);

  // --- 5) Ensure agency exists (UUID = workspaceId) ---
  try {
    const { data: existingAgency } = await svc
      .from("agencies")
      .select("id")
      .eq("id", workspaceId)
      .maybeSingle();

    if (!existingAgency) {
      const displayName = userEmail ?? `Agenzia ${workspaceId.slice(0, 8)}`;
      const { error: agencyErr } = await svc.from("agencies").insert({
        id: workspaceId,
        name: displayName,
        billing_email: userEmail,
        status: "active",
        plan: "civiko_one_trial",
      });
      if (agencyErr && agencyErr.code !== "23505") {
        return jsonResponse(
          { ok: false, error: "errore", message: `ensure_agency_failed: ${agencyErr.message}`, debug_id },
          500,
        );
      }
    }

    // --- 6) Ensure membership owner/active ---
    const { error: memErr } = await svc
      .from("agency_memberships")
      .upsert(
        { agency_id: workspaceId, user_id: userId, role: "owner", status: "active" },
        { onConflict: "agency_id,user_id", ignoreDuplicates: true },
      );
    if (memErr && memErr.code !== "23505") {
      return jsonResponse(
        { ok: false, error: "errore", message: `ensure_membership_failed: ${memErr.message}`, debug_id },
        500,
      );
    }
  } catch (e) {
    return jsonResponse(
      { ok: false, error: "errore", message: `ensure_step_failed: ${(e as Error).message}`, debug_id },
      500,
    );
  }

  // --- 7) Reserve commercial zone ---
  const { data, error } = await svc.rpc("reserve_commercial_zone", {
    p_slug: slug,
    p_agency_id: workspaceId,
  });

  if (error) {
    const msg = (error.message || "").toLowerCase();
    let code: "zona_in_trial" | "zona_occupata" | "errore" = "errore";
    if (msg.includes("trial") || msg.includes("reserved")) code = "zona_in_trial";
    else if (msg.includes("occup")) code = "zona_occupata";
    return jsonResponse({ ok: false, error: code, message: error.message, debug_id }, 409);
  }

  return jsonResponse({ ok: true, data, debug_id });
}

// Registrazione runtime solo in Deno (edge).
if (typeof (globalThis as { Deno?: unknown }).Deno !== "undefined") {
  const stdHttp: string = "https://deno.land/std@0.190.0/http/server.ts";
  const { serve } = await import(/* @vite-ignore */ stdHttp);
  serve((req: Request) => handleZonesReserve(req));
}
