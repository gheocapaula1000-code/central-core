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

/**
 * Messaggi pubblici neutri: nessun codice interno, nome RPC, nome tabella,
 * eccezione PostgreSQL o dettaglio Supabase può finire nell'interfaccia.
 * Il `code` resta disponibile al client solo per classificare l'errore.
 */
const PUBLIC_MESSAGES: Record<string, string> = {
  errore: "Operazione non riuscita. Riprova più tardi.",
  richiesta_non_valida: "Richiesta non valida.",
  non_autorizzato: "Accesso non consentito.",
  parametri_non_validi: "Richiesta non valida.",
  zona_non_trovata: "Zona non disponibile.",
  pilot_zone_locked: "In questa fase è attivabile solo la zona Centro Storico.",
  zona_in_trial: "La zona è già assegnata a un'altra agenzia.",
  zona_occupata: "La zona è già assegnata a un'altra agenzia.",
  agency_ha_gia_zona: "L'agenzia ha già una zona attiva.",
  membership_incompatibile: "Non è possibile completare l'attivazione con questo account.",
};

function errorResponse(code: string, status: number, debug_id: string): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message: PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.errore,
      },
      debug_id,
    },
    status,
  );
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
  const { createServiceClient } = await import("../_shared/supabaseServiceClient.ts");
  return createServiceClient(url, key);
};

export async function handleZonesReserve(
  req: Request,
  createServiceClient: ServiceClientFactory = defaultServiceClientFactory,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: civikoOneCors });
  const debug_id = crypto.randomUUID();
  if (req.method !== "POST") {
    return errorResponse("richiesta_non_valida", 405, debug_id);
  }

  // --- 1) Auth server-to-server via shared secret ---
  const expected = getEnv("CENTRAL_CORE_JOB_SECRET");
  const provided =
    req.headers.get("x-job-secret") ??
    req.headers.get("x-internal-secret") ??
    "";
  if (!expected || !provided || !constantTimeEqual(provided, expected)) {
    console.error("[zones-reserve] auth_rejected", debug_id);
    return errorResponse("non_autorizzato", 401, debug_id);
  }

  // --- 2) Headers fidati (verificati a monte dal proxy Civiko One) ---
  const workspaceId = (req.headers.get("x-workspace-id") ?? "").trim();
  const userId = (req.headers.get("x-user-id") ?? "").trim();
  const userEmail = (req.headers.get("x-user-email") ?? "").trim() || null;

  if (!UUID_RE.test(workspaceId)) {
    console.error("[zones-reserve] invalid_workspace_header", debug_id);
    return errorResponse("richiesta_non_valida", 400, debug_id);
  }
  if (!UUID_RE.test(userId)) {
    console.error("[zones-reserve] invalid_user_header", debug_id);
    return errorResponse("richiesta_non_valida", 400, debug_id);
  }

  // --- 3) Body ---
  let body: { slug?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("richiesta_non_valida", 400, debug_id);
  }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) {
    return errorResponse("richiesta_non_valida", 400, debug_id);
  }
  // Territory Contract Padova Pilot v1 — fail-closed server-side:
  // solo `centro-storico` è riservabile nel pilot. Ogni altro slug
  // (inclusi slug legacy o manipolati dal client) viene respinto qui,
  // prima di qualsiasi scrittura o chiamata alle RPC.
  if (!isPadovaPilotAllowedZoneSlug(slug)) {
    console.warn("[zones-reserve] pilot_zone_locked", debug_id, PADOVA_PILOT_ALLOWED_ZONE_SLUG);
    return errorResponse("pilot_zone_locked", 403, debug_id);
  }

  // --- 4) Service-role client ---
  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[zones-reserve] core_config_missing", debug_id);
    return errorResponse("errore", 500, debug_id);
  }
  const svc = await createServiceClient(supabaseUrl, serviceKey);

  // --- 5) Prenotazione atomica e idempotente (unica chiamata RPC).
  // Agenzia, membership owner e prenotazione avvengono nella stessa
  // transazione DB: nessuna riga orfana se un passo fallisce.
  // Solo dati derivati dagli header verificati dal proxy vengono inoltrati.
  let data: unknown;
  let error: { message?: string } | null = null;
  try {
    const res = await svc.rpc("reserve_padova_pilot_zone_atomic", {
      p_slug: slug,
      p_agency_id: workspaceId,
      p_user_id: userId,
      p_user_email: userEmail,
    });
    data = res.data;
    error = res.error ?? null;
  } catch (e) {
    console.error("[zones-reserve] rpc_throw", debug_id, (e as Error)?.message);
    return errorResponse("errore", 500, debug_id);
  }

  // 5a) Errore tecnico: nessun dettaglio interno viene esposto al chiamante,
  // ma resta tracciato nei log server-side per la diagnosi operativa.
  if (error) {
    console.error("[zones-reserve] rpc_error", debug_id, error.message);
    return errorResponse("errore", 500, debug_id);
  }

  // 5b) Esito applicativo. Fail-closed: solo ok === true booleano è successo.
  const result = data as
    | { ok?: unknown; error?: unknown; already_mine?: unknown; zona?: unknown; trial_until?: unknown }
    | null;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    console.error("[zones-reserve] rpc_payload_invalid", debug_id);
    return errorResponse("errore", 500, debug_id);
  }

  if (result.ok === false) {
    const KNOWN = new Set([
      "zona_non_trovata",
      "pilot_zone_locked",
      "zona_in_trial",
      "zona_occupata",
      "agency_ha_gia_zona",
      "membership_incompatibile",
      "parametri_non_validi",
    ]);
    const raw = typeof result.error === "string" ? result.error : "";
    const appError = KNOWN.has(raw) ? raw : "errore";
    if (appError === "errore") {
      console.error("[zones-reserve] rpc_unknown_app_error", debug_id, raw);
    }
    const status = appError === "zona_non_trovata"
      ? 404
      : appError === "pilot_zone_locked"
      ? 403
      : appError === "errore" || appError === "parametri_non_validi"
      ? 400
      : 409;
    return errorResponse(appError, status, debug_id);
  }


  return jsonResponse({
    ok: true,
    already_mine: result.already_mine === true,
    data: {
      zona: result.zona ?? slug,
      already_mine: result.already_mine === true,
      trial_until: result.trial_until ?? null,
    },
    debug_id,
  });
}


// Registrazione runtime solo in Deno (edge).
const denoRuntime = (globalThis as { Deno?: { serve?: (h: (req: Request) => Response | Promise<Response>) => unknown } }).Deno;
if (denoRuntime?.serve) {
  denoRuntime.serve((req: Request) => handleZonesReserve(req));
}
