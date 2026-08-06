// Civiko One / Padova — validazione pura dell'ack di sincronizzazione PWA.
// Modulo isolato e senza I/O: testabile senza avviare il server.

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
