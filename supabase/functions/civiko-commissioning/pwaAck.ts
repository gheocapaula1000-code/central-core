// Civiko One — ack PWA autoritativo read-only (Civiko-specific, isolato).
//
// Causa reale del `pwa_ack_missing`: lo step `sync_pwa` leggeva SOLO la tabella
// `civiko_pwa_sync_acks`, che è alimentata esclusivamente dalla PWA tramite
// POST /civiko-pwa-sync-ack. Se nessuna istanza PWA gira durante il
// commissioning, la tabella resta vuota e lo step resta PARTIAL per sempre,
// pur essendo i dati realmente leggibili dal feed autenticato.
//
// Qui si certifica in sola lettura che i dati siano davvero leggibili dalla
// PWA (stesso feed, stesso scope admin full-city): conteggi reali + freshness
// attribuibile. Nessuna scrittura, nessuna prova inventata: se la verifica non
// è possibile o i dati sono assenti/stantii, lo step resta fail-closed.

/** Finestra massima di freschezza dei dati serviti alla PWA. */
export const PWA_DATA_MAX_AGE_MS = 24 * 60 * 60_000;

/** Categorie che la PWA deve poter leggere per considerare il sync certificato. */
export const PWA_REQUIRED_COUNT_KEYS = [
  "classificazione",
  "contendibili",
  "ribassi",
  "off_market",
  "cambi_agenzia",
  "privati",
  "multi_portale",
] as const;

export interface PwaAckInput {
  /** HTTP status della lettura del feed autenticato. */
  httpStatus: number;
  /** Envelope ok del feed. */
  feedOk: boolean;
  counts: Record<string, unknown> | null | undefined;
  freshness:
    | {
      generated_at?: unknown;
      newest_source_updated_at?: unknown;
      last_provider_refresh_at?: unknown;
    }
    | null
    | undefined;
  /** Ack persistito dalla PWA, se esiste (evidenza addizionale, non richiesta). */
  clientAck: Record<string, unknown> | null | undefined;
  chainRunId: string;
  now: number;
}

export interface PwaAckEvidence {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  error_code: string | null;
  ack_source: "pwa_client_ack" | "core_authoritative_read" | null;
  chain_run_id: string;
  counts: Record<string, number> | null;
  total_readable: number | null;
  generated_at: string | null;
  newest_source_updated_at: string | null;
  last_provider_refresh_at: string | null;
  data_age_ms: number | null;
  client_ack_run_id: string | null;
  client_ack_ok: boolean | null;
  verified_at: string;
}

function parseTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Valuta l'ack in sola lettura. SUCCESS solo se il feed risponde 200/ok, tutti
 * i conteggi richiesti sono numerici, esiste almeno un dato realmente leggibile
 * e la freschezza è attribuibile e dentro finestra. Altrimenti fail-closed.
 */
export function evaluatePwaAck(input: PwaAckInput): PwaAckEvidence {
  const clientAck = input.clientAck ?? null;
  const base: PwaAckEvidence = {
    status: "PARTIAL",
    error_code: null,
    ack_source: null,
    chain_run_id: input.chainRunId,
    counts: null,
    total_readable: null,
    generated_at: asString(input.freshness?.generated_at),
    newest_source_updated_at: asString(input.freshness?.newest_source_updated_at),
    last_provider_refresh_at: asString(input.freshness?.last_provider_refresh_at),
    data_age_ms: null,
    client_ack_run_id: asString(clientAck?.run_id),
    client_ack_ok: typeof clientAck?.ok === "boolean" ? clientAck.ok as boolean : null,
    verified_at: new Date(input.now).toISOString(),
  };

  if (input.httpStatus !== 200) {
    return { ...base, status: "FAILED", error_code: "pwa_feed_unreadable" };
  }
  if (input.feedOk !== true) {
    return { ...base, error_code: "pwa_feed_not_ok" };
  }

  const counts: Record<string, number> = {};
  for (const key of PWA_REQUIRED_COUNT_KEYS) {
    const raw = input.counts?.[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ...base, error_code: "pwa_counts_incomplete" };
    }
    counts[key] = raw;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return { ...base, counts, total_readable: total, error_code: "pwa_counts_empty" };
  }

  const generated = parseTs(base.generated_at);
  if (generated === null) {
    return { ...base, counts, total_readable: total, error_code: "pwa_generated_at_invalid" };
  }
  const newest = parseTs(base.newest_source_updated_at);
  if (newest === null) {
    return { ...base, counts, total_readable: total, error_code: "pwa_freshness_unknown" };
  }
  const age = input.now - newest;
  if (age > PWA_DATA_MAX_AGE_MS) {
    return {
      ...base,
      counts,
      total_readable: total,
      data_age_ms: age,
      error_code: "pwa_data_stale",
    };
  }

  return {
    ...base,
    status: "SUCCESS",
    error_code: null,
    ack_source: base.client_ack_ok === true ? "pwa_client_ack" : "core_authoritative_read",
    counts,
    total_readable: total,
    data_age_ms: age,
  };
}
