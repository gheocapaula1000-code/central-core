// Civiko One / Padova — validazione pura dell'ack di sincronizzazione PWA.
// Modulo isolato e senza I/O: testabile senza avviare il server.
//
// CONTRATTO CANONICO DEL SENDER PWA (nessun altro campo è ammesso):
//   {
//     run_id, started_at, finished_at, ok,
//     municipality: "Padova",
//     zone_slugs: [8 slug ufficiali],
//     counts: { 9 chiavi intere >= 0 },
//     error_code   // SOLO se ok === false
//   }
// Header obbligatorio: x-idempotency-key === run_id.
// Campi legacy (scope_comune, scope_slugs, idempotency_key) e pipeline_run_id
// dichiarato dal client sono RIFIUTATI: la pipeline la deriva il Core.

/** Perimetro territoriale ammesso: Padova e le sole 8 zone ufficiali. */
export const PADOVA_MUNICIPALITY = "Padova";
/** Alias legacy mantenuto per i consumatori interni già esistenti. */
export const PADOVA_COMUNE = PADOVA_MUNICIPALITY;

export const PADOVA_ZONE_SLUGS: readonly string[] = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
];

/**
 * Chiavi di conteggio obbligatorie: sono la prova firmata dalla PWA di aver
 * renderizzato ogni superficie. Zero è un valore lecito, l'assenza no.
 */
export const REQUIRED_COUNT_KEYS: readonly string[] = [
  "dashboard",
  "radar",
  "mappa",
  "contendibili",
  "privati",
  "ribassi",
  "cambi_agenzia",
  "offmarket",
  "quartieri",
];

/** Campi legacy/derivati esplicitamente vietati nel body canonico. */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "scope_comune",
  "scope_slugs",
  "idempotency_key",
  "pipeline_run_id",
  "comune",
  "zones",
  "source_app",
];

/** Identità canonica unica del sender PWA Civiko One. */
export const CIVIKO_SOURCE_APPS = new Set(["civiko-one"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

/** Finestra di plausibilità dei timestamp dichiarati dalla PWA. */
export const MAX_PAST_MS = 24 * 60 * 60_000;
export const MAX_FUTURE_MS = 5 * 60_000;
export const MAX_DURATION_MS = 6 * 60 * 60_000;

export interface AckRecord {
  run_id: string;
  source_app: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  counts: Record<string, number>;
  municipality: string;
  commercial_zone_slugs: string[];
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
 *
 * @param idempotencyHeader valore di x-idempotency-key: DEVE essere il run_id.
 */
export function validateAck(
  input: unknown,
  sourceApp: string,
  nowMs: number,
  idempotencyHeader: string | null,
): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Body must be a JSON object" };
  }
  const b = input as Record<string, unknown>;

  const allowed = new Set([
    "run_id",
    "started_at",
    "finished_at",
    "ok",
    "municipality",
    "zone_slugs",
    "counts",
    "error_code",
  ]);
  for (const k of Object.keys(b)) {
    if (FORBIDDEN_FIELDS.includes(k)) {
      return { ok: false, code: "LEGACY_FIELD_REJECTED", message: `Field not part of the canonical contract: ${k}` };
    }
    if (!allowed.has(k)) {
      return { ok: false, code: "UNKNOWN_FIELD", message: `Unexpected field: ${k}` };
    }
  }

  if (typeof b.run_id !== "string" || !UUID_RE.test(b.run_id)) {
    return { ok: false, code: "RUN_ID_INVALID", message: "run_id must be a UUID" };
  }
  const runId = b.run_id.toLowerCase();

  // L'idempotency key è l'header, e coincide esattamente con il run_id.
  const header = (idempotencyHeader ?? "").trim().toLowerCase();
  if (!header) {
    return { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "x-idempotency-key header is required" };
  }
  if (header !== runId) {
    return { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH", message: "x-idempotency-key must equal run_id" };
  }

  if (typeof b.ok !== "boolean") {
    return { ok: false, code: "OK_INVALID", message: "ok must be a boolean" };
  }

  const started = parseTimestamp(b.started_at);
  const finished = parseTimestamp(b.finished_at);
  if (started === null || finished === null) {
    return { ok: false, code: "TIMESTAMP_INVALID", message: "started_at/finished_at must be ISO timestamps" };
  }
  // Ordine STRETTO: un sync di durata nulla non è una prova di rendering.
  if (finished <= started) {
    return { ok: false, code: "TIMESTAMP_ORDER_INVALID", message: "finished_at must be strictly after started_at" };
  }
  if (finished - started > MAX_DURATION_MS) {
    return { ok: false, code: "TIMESTAMP_WINDOW_INVALID", message: "sync duration not plausible" };
  }
  if (finished > nowMs + MAX_FUTURE_MS || started < nowMs - MAX_PAST_MS) {
    return { ok: false, code: "TIMESTAMP_WINDOW_INVALID", message: "timestamps outside plausible window" };
  }

  if (b.municipality !== PADOVA_MUNICIPALITY) {
    return { ok: false, code: "MUNICIPALITY_INVALID", message: "municipality must be Padova" };
  }
  if (!Array.isArray(b.zone_slugs) || b.zone_slugs.length !== PADOVA_ZONE_SLUGS.length) {
    return { ok: false, code: "ZONE_SLUGS_INVALID", message: "zone_slugs must cover the 8 official zones" };
  }
  const slugs: string[] = [];
  for (const s of b.zone_slugs) {
    if (typeof s !== "string" || !PADOVA_ZONE_SLUGS.includes(s)) {
      return { ok: false, code: "ZONE_SLUGS_INVALID", message: "zone_slugs outside the 8 official zones" };
    }
    if (slugs.includes(s)) {
      return { ok: false, code: "ZONE_SLUGS_INVALID", message: "zone_slugs contains duplicates" };
    }
    slugs.push(s);
  }

  // Counts obbligatori con chiavi esatte: zero è ammesso, chiavi mancanti no.
  if (!b.counts || typeof b.counts !== "object" || Array.isArray(b.counts)) {
    return { ok: false, code: "COUNTS_INVALID", message: "counts must be an object" };
  }
  const counts: Record<string, number> = {};
  const provided = b.counts as Record<string, unknown>;
  for (const k of Object.keys(provided)) {
    if (!REQUIRED_COUNT_KEYS.includes(k)) {
      return { ok: false, code: "COUNTS_INVALID", message: `Unexpected counts key: ${k}` };
    }
  }
  for (const k of REQUIRED_COUNT_KEYS) {
    const v = provided[k];
    if (v === undefined) {
      return { ok: false, code: "COUNTS_MISSING_KEY", message: `counts.${k} is required` };
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000_000) {
      return { ok: false, code: "COUNTS_INVALID", message: `counts.${k} must be a non-negative integer` };
    }
    counts[k] = v;
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
      source_app: sourceApp,
      started_at: new Date(started).toISOString(),
      finished_at: new Date(finished).toISOString(),
      ok: b.ok,
      counts,
      municipality: PADOVA_MUNICIPALITY,
      commercial_zone_slugs: slugs,
      error_code: errorCode,
    },
  };
}

/**
 * Confronto immutabile: un replay è accettato solo se il payload persistito
 * è identico in OGNI campo di contratto e appartiene alla stessa pipeline.
 */
export function isIdenticalAck(
  stored: Record<string, unknown>,
  record: AckRecord,
  pipelineRunId: string,
): boolean {
  const sameTs = (a: unknown, b: string) =>
    typeof a === "string" && Date.parse(a) === Date.parse(b);
  if (!sameTs(stored.started_at, record.started_at)) return false;
  if (!sameTs(stored.finished_at, record.finished_at)) return false;
  if (stored.ok !== record.ok) return false;
  if ((stored.error_code ?? null) !== record.error_code) return false;
  if (String(stored.source_app ?? "").toLowerCase() !== record.source_app.toLowerCase()) return false;
  if (String(stored.pipeline_run_id ?? "").toLowerCase() !== pipelineRunId.toLowerCase()) return false;

  const municipality = stored.municipality ?? stored.scope_comune;
  if (municipality !== record.municipality) return false;

  const zonesRaw = stored.commercial_zone_slugs ?? stored.scope_slugs;
  if (!Array.isArray(zonesRaw)) return false;
  const a = [...zonesRaw].map(String).sort();
  const b = [...record.commercial_zone_slugs].sort();
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return false;

  const storedCounts = stored.counts;
  if (!storedCounts || typeof storedCounts !== "object" || Array.isArray(storedCounts)) return false;
  const sc = storedCounts as Record<string, unknown>;
  if (Object.keys(sc).length !== REQUIRED_COUNT_KEYS.length) return false;
  for (const k of REQUIRED_COUNT_KEYS) {
    if (sc[k] !== record.counts[k]) return false;
  }
  return true;
}

/**
 * Identità canonica del contratto PWA Civiko One.
 * La guard shared accetta anche `acquisitionradar` per compatibilità di costo:
 * questo endpoint NON la ammette mai.
 */
export function isCivikoSourceApp(sourceApp: string | null | undefined): boolean {
  const v = (sourceApp ?? "").toLowerCase().trim();
  if (!v || v === "acquisitionradar") return false;
  return CIVIKO_SOURCE_APPS.has(v);
}
