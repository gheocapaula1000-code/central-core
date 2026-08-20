// Logica pura di selezione dei candidati per la certificazione fotografica.
// Nessuna rete, nessun DB: testabile in modo deterministico.

import { listingImageSourceInput } from "../_shared/detailImageRefs.ts";

/** Dimensione massima di una clausola .in() verso PostgREST. */
export const IN_CHUNK_SIZE = 200;

/**
 * PostgREST OR: any typical photo source, not only `raw_json.media.images`.
 * Casa listings store a single `raw_json.image` URL.
 */
export const LISTING_PHOTO_SOURCE_OR = [
  "ev_image_refs.not.is.null",
  "raw_json->media->images.not.is.null",
  "raw_json->image.not.is.null",
  "raw_json->images.not.is.null",
  "raw_json->photos.not.is.null",
  "raw_json->photo.not.is.null",
  "raw_json->_photos.not.is.null",
].join(",");

export { listingImageSourceInput };

export function chunk<T>(items: T[], size = IN_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AttemptState {
  attempts: number;
  last_pipeline_run_id: string | null;
  terminal: boolean;
  image_source_fp: string | null;
}

/** Esiti che NON vanno ritentati finché la fonte immagine non cambia. */
export const TERMINAL_OUTCOMES = new Set(["no_photo", "no_valid_image"]);

export function normalizeOutcome(outcome: string): string {
  return outcome === "undecodable" ? "no_valid_image" : outcome;
}

export function isTerminalOutcome(outcome: string): boolean {
  return TERMINAL_OUTCOMES.has(normalizeOutcome(outcome));
}

export interface EligibilityInput {
  attempt?: AttemptState;
  maxAttempts: number;
  /** Run corrente: un listing non viene lavorato due volte nello stesso run. */
  pipelineRunId: string | null;
  /** Il listing ha già almeno un fingerprint persistito. */
  hasFingerprint: boolean;
  /** Il listing è attivo, a Padova e in una delle 8 zone ufficiali. */
  inScope: boolean;
  /** Impronta CORRENTE della fonte immagine, se calcolabile. */
  currentSourceFp: string | null;
}

/** null = eleggibile; stringa = motivo di esclusione (fail-closed). */
export function eligibilityReason(i: EligibilityInput): string | null {
  if (!i.inScope) return "out_of_scope";
  if (i.hasFingerprint) return "already_fingerprinted";
  const a = i.attempt;
  if (!a) return null;
  if (i.pipelineRunId && a.last_pipeline_run_id === i.pipelineRunId) return "same_run";
  if (a.attempts >= i.maxAttempts) return "attempts_exhausted";
  if (a.terminal) {
    // Terminale finché l'impronta della fonte immagine non cambia davvero.
    if (!i.currentSourceFp) return "terminal_no_source";
    if (a.image_source_fp && a.image_source_fp === i.currentSourceFp) return "terminal_unchanged";
  }
  return null;
}

/** Serializzazione canonica e stabile della fonte immagine. */
export function canonicalSource(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v ?? null;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
  };
  return JSON.stringify(norm(value) ?? null);
}

/** Impronta deterministica (sha256 esadecimale) della fonte immagine. */
export async function sourceFingerprint(value: unknown): Promise<string | null> {
  const isEmpty = (v: unknown): boolean =>
    v === null || v === undefined ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && Object.values(v as Record<string, unknown>).every(isEmpty));
  if (isEmpty(value)) return null;
  const canonical = canonicalSource(value);
  if (!canonical || canonical === "null" || canonical === "[]" || canonical === "{}") return null;
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SelectionOutcome<T> {
  selected: T[];
  remaining: number;
  exclusions: Record<string, number>;
}

/**
 * Scansione oldest-first dell'INTERO pool: si selezionano al massimo `limit`
 * candidati, ma il residuo continua a essere contato fino a EOF, quindi è
 * autoritativo e non coincide mai con selected.length.
 */
export function selectEligible<T>(
  pool: T[],
  reasonOf: (item: T) => string | null,
  limit: number,
): SelectionOutcome<T> {
  const selected: T[] = [];
  const exclusions: Record<string, number> = {};
  let remaining = 0;
  for (const item of pool) {
    const reason = reasonOf(item);
    if (reason) {
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      continue;
    }
    if (selected.length < limit) selected.push(item);
    else remaining++;
  }
  return { selected, remaining, exclusions };
}
