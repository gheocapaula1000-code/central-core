// Civiko One / Padova — audit fail-closed della sincronizzazione PWA.
//
// La PWA Civiko conferma qui l'esito reale del proprio sync. Il release gate
// legge SOLO questa tabella: nessuna prova indiretta, nessuna deduzione da
// altri job. Contratto di autenticazione già esistente:
//   x-source-app: civiko | civiko-one | civiko_one
//   x-internal-secret: AI_CORE_SECRET_CIVIKO (nessuna nuova secret)
//
// Isolato: non tocca civiko-one-signals-feed, auth condivisa, cron o provider.

import {
  corsHeaders,
  enforceOriginPolicy,
  fail,
  handleOptions,
  json,
  makeDebugId,
  ok,
  requireSecret,
} from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 16_384;

/** Perimetro territoriale ammesso: Padova e le sole 8 zone ufficiali. */
export const PADOVA_COMUNE = "Padova";
export const PADOVA_ZONE_SLUGS: readonly string[] = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

/** Source app ammesse dal contratto app-secret Civiko PWA. */
export const CIVIKO_SOURCE_APPS = new Set(["civiko", "civiko-one", "civiko_one"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Finestra di plausibilità dei timestamp dichiarati dalla PWA. */
export const MAX_PAST_MS = 24 * 60 * 60_000;
export const MAX_FUTURE_MS = 5 * 60_000;
export const MAX_DURATION_MS = 6 * 60 * 60_000;

export interface AckRecord {
  run_id: string;
  idempotency_key: string;
  source_app: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  counts: Record<string, number>;
  scope_comune: string;
  scope_slugs: string[];
  error_code: string | null;
}

export type ValidationResult =
  | { ok: true; record: AckRecord }
  | { ok: false; code: string; message: string };

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Schema limitato e fail-closed. Nessun campo extra accettato, nessun default
 * inventato: se una prova manca, l'ack non viene registrato.
 */
export function validateAck(
  input: unknown,
  sourceApp: string,
  nowMs: number,
): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Body must be a JSON object" };
  }
  const b = input as Record<string, unknown>;

  const allowed = new Set([
    "run_id",
    "idempotency_key",
    "started_at",
    "finished_at",
    "ok",
    "counts",
    "scope_comune",
    "scope_slugs",
    "error_code",
  ]);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) {
      return { ok: false, code: "UNKNOWN_FIELD", message: `Unexpected field: ${k}` };
    }
  }

  if (typeof b.run_id !== "string" || !UUID_RE.test(b.run_id)) {
    return { ok: false, code: "RUN_ID_INVALID", message: "run_id must be a UUID" };
  }
  const runId = b.run_id.toLowerCase();

  let idempotency = runId;
  if (b.idempotency_key !== undefined) {
    if (typeof b.idempotency_key !== "string" || !IDEMPOTENCY_RE.test(b.idempotency_key)) {
      return { ok: false, code: "IDEMPOTENCY_KEY_INVALID", message: "idempotency_key malformed" };
    }
    idempotency = b.idempotency_key;
  }

  if (typeof b.ok !== "boolean") {
    return { ok: false, code: "OK_INVALID", message: "ok must be a boolean" };
  }

  const started = parseTimestamp(b.started_at);
  const finished = parseTimestamp(b.finished_at);
  if (started === null || finished === null) {
    return { ok: false, code: "TIMESTAMP_INVALID", message: "started_at/finished_at must be ISO timestamps" };
  }
  if (finished < started) {
    return { ok: false, code: "TIMESTAMP_ORDER_INVALID", message: "finished_at precedes started_at" };
  }
  if (finished - started > MAX_DURATION_MS) {
    return { ok: false, code: "TIMESTAMP_WINDOW_INVALID", message: "sync duration not plausible" };
  }
  if (finished > nowMs + MAX_FUTURE_MS || started < nowMs - MAX_PAST_MS) {
    return { ok: false, code: "TIMESTAMP_WINDOW_INVALID", message: "timestamps outside plausible window" };
  }

  if (b.scope_comune !== PADOVA_COMUNE) {
    return { ok: false, code: "SCOPE_COMUNE_INVALID", message: "scope_comune must be Padova" };
  }
  if (!Array.isArray(b.scope_slugs) || b.scope_slugs.length === 0) {
    return { ok: false, code: "SCOPE_SLUGS_INVALID", message: "scope_slugs must be a non-empty array" };
  }
  const slugs: string[] = [];
  for (const s of b.scope_slugs) {
    if (typeof s !== "string" || !PADOVA_ZONE_SLUGS.includes(s)) {
      return { ok: false, code: "SCOPE_SLUGS_INVALID", message: "scope_slugs outside the 8 official zones" };
    }
    if (slugs.includes(s)) {
      return { ok: false, code: "SCOPE_SLUGS_INVALID", message: "scope_slugs contains duplicates" };
    }
    slugs.push(s);
  }

  const counts: Record<string, number> = {};
  if (b.counts !== undefined) {
    if (!b.counts || typeof b.counts !== "object" || Array.isArray(b.counts)) {
      return { ok: false, code: "COUNTS_INVALID", message: "counts must be an object" };
    }
    const entries = Object.entries(b.counts as Record<string, unknown>);
    if (entries.length > 32) {
      return { ok: false, code: "COUNTS_INVALID", message: "counts has too many keys" };
    }
    for (const [k, v] of entries) {
      if (!/^[a-z0-9_]{1,48}$/.test(k)) {
        return { ok: false, code: "COUNTS_INVALID", message: "counts key malformed" };
      }
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
        return { ok: false, code: "COUNTS_INVALID", message: "counts values must be non-negative integers" };
      }
      counts[k] = v;
    }
  }

  let errorCode: string | null = null;
  if (b.error_code !== undefined && b.error_code !== null) {
    if (typeof b.error_code !== "string" || !ERROR_CODE_RE.test(b.error_code)) {
      return { ok: false, code: "ERROR_CODE_INVALID", message: "error_code malformed" };
    }
    errorCode = b.error_code;
  }
  if (b.ok === true && errorCode !== null) {
    return { ok: false, code: "ACK_INCOHERENT", message: "ok=true cannot carry an error_code" };
  }
  if (b.ok === false && errorCode === null) {
    return { ok: false, code: "ACK_INCOHERENT", message: "ok=false requires an error_code" };
  }

  return {
    ok: true,
    record: {
      run_id: runId,
      idempotency_key: idempotency,
      source_app: sourceApp,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      ok: b.ok,
      counts,
      scope_comune: PADOVA_COMUNE,
      scope_slugs: slugs,
      error_code: errorCode,
    },
  };
}

async function upsertAck(record: AckRecord): Promise<{ ok: boolean; code?: string }> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/civiko_pwa_sync_acks?on_conflict=run_id`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([record]),
    },
  );
  if (!res.ok) {
    // Telemetria sanificata: mai il corpo del provider, mai secret.
    console.error(`[civiko-pwa-sync-ack] write failed status=${res.status}`);
    await res.body?.cancel();
    return { ok: false, code: res.status === 409 ? "ACK_CONFLICT" : "ACK_WRITE_FAILED" };
  }
  await res.body?.cancel();
  return { ok: true };
}

Deno.serve(async (req) => {
  const debugId = makeDebugId();

  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Only POST is accepted", debugId);
  }

  const originBlock = enforceOriginPolicy(req, debugId);
  if (originBlock) return originBlock;

  // Auth PRIMA di qualsiasi write: identità applicativa + app secret Civiko.
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();
  if (!CIVIKO_SOURCE_APPS.has(sourceApp)) {
    return fail(req, 401, "APP_SECRET_REQUIRED", "Missing or invalid application identity", debugId);
  }
  const authBlock = requireSecret(req, debugId);
  if (authBlock) return authBlock;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("[civiko-pwa-sync-ack] misconfigured");
    return fail(req, 500, "CONFIG_ERROR", "Storage not configured", debugId);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return fail(req, 413, "PAYLOAD_TOO_LARGE", "Body too large", debugId);
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId);
  }

  const validation = validateAck(parsed, sourceApp, Date.now());
  if (!validation.ok) {
    return fail(req, 400, validation.code, validation.message, debugId);
  }

  const written = await upsertAck(validation.record);
  if (!written.ok) {
    return fail(req, 502, written.code ?? "ACK_WRITE_FAILED", "Ack not persisted", debugId);
  }

  return ok(req, {
    run_id: validation.record.run_id,
    idempotency_key: validation.record.idempotency_key,
    ok: validation.record.ok,
    finished_at: validation.record.finished_at,
    scope_comune: validation.record.scope_comune,
    zones: validation.record.scope_slugs.length,
  }, [], debugId);
});

export { corsHeaders, json };
