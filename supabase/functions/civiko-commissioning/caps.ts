// civiko-commissioning — contratto puro dei cap e dello schema chiuso.
//
// Modulo isolato e dedicato al commissioning di Civiko One: non è importato da
// nessuna pipeline di produzione (UEradar/TrovaBandi, Wyloni, LuxuRadar e le
// altre PWA non lo referenziano) e non modifica alcun contratto esistente.
//
// I cap sono costanti server-side: il client NON può passarli né aumentarli.
// Lo schema di body è chiuso: qualsiasi campo non previsto è rifiutato.

export const CIVIKO_COMMISSIONING_PROVIDERS = ["apify", "firecrawl", "perplexity"] as const;
export type CivikoCommissioningProvider = typeof CIVIKO_COMMISSIONING_PROVIDERS[number];

export type CivikoCommissioningStatus =
  | "RUNNING"
  | "SUCCESS"
  | "PARTIAL"
  | "BLOCKED"
  | "FAILED";

/**
 * Hard cap minimi, non aumentabili dal client. Vengono trasmessi realmente
 * all'adapter/provider e devono essere confermati esattamente dalla risposta
 * del provider: senza conferma nessuna scansione viene considerata valida e il
 * run resta BLOCKED.
 */
export const CIVIKO_COMMISSIONING_CAPS = {
  apify: {
    // Pochissimi item. Il micro-run passa dal percorso Civiko esistente
    // (padova-apify-subito-collect → startApifyRun), che stima e registra il
    // cap monetario come max_items * 5 / 1000 USD: 3 item ⇒ 0.015 USD.
    // Nessun valore inventato: il cap applicato viene riletto da
    // padova_apify_runs.cost_cap_usd.
    max_items: 3,
    max_total_charge_usd: 0.015,
  },

  firecrawl: {
    // Una sola pagina => un solo credito.
    max_pages: 1,
    max_credits: 1,
  },
  perplexity: {
    // Una sola query e token minimi.
    max_queries: 1,
    max_completion_tokens: 128,
  },
} as const;

export const CIVIKO_COMMISSIONING_CLAIM_TTL_SECONDS = 600;

export const CIVIKO_COMMISSIONING_ACTIONS = [
  "civiko_commissioning_healthcheck",
  "civiko_commissioning_baseline",
  "civiko_commissioning_microrun_apify",
  "civiko_commissioning_microrun_firecrawl",
  "civiko_commissioning_microrun_perplexity",
  "civiko_commissioning_verify_delta",
  "civiko_commissioning_pwa_feed_counts",
  "civiko_commissioning_chain",
] as const;
export type CivikoCommissioningAction = typeof CIVIKO_COMMISSIONING_ACTIONS[number];

/** Schema chiuso: per ogni azione, i soli campi ammessi oltre ad `action`. */
export const CIVIKO_COMMISSIONING_BODY_SCHEMA: Record<CivikoCommissioningAction, readonly string[]> = {
  civiko_commissioning_healthcheck: [],
  civiko_commissioning_baseline: [],
  civiko_commissioning_microrun_apify: [],
  civiko_commissioning_microrun_firecrawl: [],
  civiko_commissioning_microrun_perplexity: [],
  civiko_commissioning_verify_delta: ["run_id", "baseline_snapshot_id"],
  civiko_commissioning_pwa_feed_counts: [],
  civiko_commissioning_chain: [],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface BodyValidationOk {
  ok: true;
  action: CivikoCommissioningAction;
  runId?: string;
  baselineSnapshotId?: string;
}
export interface BodyValidationErr {
  ok: false;
  status: number;
  error: string;
}

/** Valida in modo fail-closed action + body. Nessun URL/payload arbitrario. */
export function validateCommissioningBody(
  body: Record<string, unknown>,
): BodyValidationOk | BodyValidationErr {
  const action = body.action;
  if (
    typeof action !== "string" ||
    !(CIVIKO_COMMISSIONING_ACTIONS as readonly string[]).includes(action)
  ) {
    return { ok: false, status: 400, error: "action_not_allowed" };
  }
  const typed = action as CivikoCommissioningAction;
  const allowed = new Set<string>(["action", ...CIVIKO_COMMISSIONING_BODY_SCHEMA[typed]]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, status: 400, error: "unexpected_field" };
  }
  if (typed === "civiko_commissioning_verify_delta") {
    if (!isUuid(body.run_id)) return { ok: false, status: 400, error: "invalid_run_id" };
    if (body.baseline_snapshot_id !== undefined && !isUuid(body.baseline_snapshot_id)) {
      return { ok: false, status: 400, error: "invalid_baseline_snapshot_id" };
    }
    return {
      ok: true,
      action: typed,
      runId: body.run_id as string,
      baselineSnapshotId: isUuid(body.baseline_snapshot_id)
        ? body.baseline_snapshot_id as string
        : undefined,
    };
  }
  return { ok: true, action: typed };
}

/**
 * Conferma esatta del cap: ogni chiave richiesta deve esistere nel cap
 * applicato dall'adapter/provider e valere esattamente lo stesso numero.
 * Qualsiasi differenza (anche più restrittiva) NON è una conferma esatta.
 */
export function capExactlyApplied(
  requested: Record<string, number>,
  applied: Record<string, unknown> | null | undefined,
): boolean {
  if (!applied || typeof applied !== "object") return false;
  const keys = Object.keys(requested);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const value = (applied as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) && value === requested[key];
  });
}

// ── Auth Civiko isolata ─────────────────────────────────────────────────────
// Accetta il secret dedicato dell'orchestrator oppure il già esistente
// CENTRAL_CORE_API_KEY (stesso canale autorizzato orchestrator → Central Core).
// Confronto timing-safe su OGNI secret non vuoto; nessun valore viene mai
// loggato, restituito o incluso nell'errore.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function authorizeBearer(
  bearer: string,
  secrets: readonly string[],
): { ok: boolean; status: number; error: string | null } {
  const configured = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (configured.length === 0) return { ok: false, status: 500, error: "misconfigured" };
  if (!bearer) return { ok: false, status: 401, error: "unauthorized" };
  let matched = false;
  for (const secret of configured) {
    if (timingSafeEqual(bearer, secret)) matched = true;
  }
  return matched ? { ok: true, status: 200, error: null } : { ok: false, status: 401, error: "unauthorized" };
}
