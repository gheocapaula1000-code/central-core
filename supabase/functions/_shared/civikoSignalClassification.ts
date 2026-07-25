// Metodo Civiko One — Classificazione di sicurezza e visibilità dei segnali
// Regola: meglio assente che fragile.
// - "alto": NON visibile all'agenzia, NON visibile al proprietario, scoring opzionale
// - "escluso": NON usabile, NON visibile a nessuno, mai esposto
// - PWA riceve SOLO allowed_commercial_phrase o campi già ripuliti
// - Proprietario riceve SOLO frasi neutre, commerciali, non invasive
// - Fonti grezze, payload provider, log tecnici restano nel Core

export type SignalSensitivity = "basso" | "medio" | "alto" | "escluso";
export type SignalConfidence = "alta" | "media" | "bassa";
export type RetentionPolicy = "30d" | "90d" | "180d" | "365d" | "permanent";
export type SignalReasonCode =
  | "pii_only"
  | "legal_restricted"
  | "stale_source"
  | "no_commercial_phrase"
  | null;

// ─────────────────────────────────────────────
// Record Core completo (NON esporre mai alla PWA)
// ─────────────────────────────────────────────
export interface SignalCoreRecord {
  signal_id: string;
  signal_type: string;
  source_name_internal: string;
  collected_at: string; // ISO
  confidence_level: SignalConfidence;
  sensitivity_level: SignalSensitivity;
  usable_for_scoring: boolean;
  visible_to_agency: boolean;
  visible_to_owner: boolean;
  allowed_commercial_phrase: string | null;
  forbidden_phrases: string[];
  retention_policy: RetentionPolicy;
  reason_code: SignalReasonCode;
}

// ─────────────────────────────────────────────
// Vista per l'agenzia (PWA) — sicura
// ─────────────────────────────────────────────
export interface SignalAgencyView {
  signal_id: string;
  signal_type: string;
  confidence_level: SignalConfidence;
  collected_at: string;
  commercial_phrase: string;
}

// ─────────────────────────────────────────────
// Vista per il proprietario — frase neutra, mai invasiva
// ─────────────────────────────────────────────
export interface SignalOwnerView {
  topic: string;
  phrase: string;
}

// ─────────────────────────────────────────────
// Default policy per tipo di segnale
// (override in DB se serve, vedi tabella civiko_signal_policy)
// ─────────────────────────────────────────────
export interface SignalPolicyDefaults {
  sensitivity_level: SignalSensitivity;
  usable_for_scoring: boolean;
  visible_to_agency: boolean;
  visible_to_owner: boolean;
  retention_policy: RetentionPolicy;
  forbidden_phrases: string[];
}

const BASE_FORBIDDEN: string[] = [
  // Termini invasivi/sensibili: mai nelle copy verso agenzia/proprietario
  "decesso", "morte", "successione", "eredità", "erede",
  "divorzio", "separazione", "fallimento", "pignoramento",
  "esecuzione", "asta", "sfratto", "debito", "debiti",
  "malattia", "ricovero", "anziano solo",
];

const POLICY_DEFAULTS: Record<string, SignalPolicyDefaults> = {
  // Fonti dure / pubbliche
  omi: {
    sensitivity_level: "basso", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: true,
    retention_policy: "365d", forbidden_phrases: BASE_FORBIDDEN,
  },
  istat: {
    sensitivity_level: "basso", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: true,
    retention_policy: "365d", forbidden_phrases: BASE_FORBIDDEN,
  },
  ispra: {
    sensitivity_level: "basso", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: false,
    retention_policy: "365d", forbidden_phrases: BASE_FORBIDDEN,
  },
  urbanistica: {
    sensitivity_level: "basso", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: true,
    retention_policy: "365d", forbidden_phrases: BASE_FORBIDDEN,
  },
  mobilita: {
    sensitivity_level: "basso", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: true,
    retention_policy: "365d", forbidden_phrases: BASE_FORBIDDEN,
  },
  // Segnali di mercato (annunci portali)
  listing_velocity: {
    sensitivity_level: "medio", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: false,
    retention_policy: "90d", forbidden_phrases: BASE_FORBIDDEN,
  },
  price_resistance: {
    sensitivity_level: "medio", usable_for_scoring: true,
    visible_to_agency: true, visible_to_owner: false,
    retention_policy: "90d", forbidden_phrases: BASE_FORBIDDEN,
  },
  // Segnali aggregati di zona
  local_buzz: {
    sensitivity_level: "medio", usable_for_scoring: true,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "30d", forbidden_phrases: BASE_FORBIDDEN,
  },
  // Segnali sensibili — visibili SOLO al Core, mai PWA, mai proprietario
  inheritance_pressure: {
    sensitivity_level: "alto", usable_for_scoring: true,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "180d", forbidden_phrases: BASE_FORBIDDEN,
  },
  estate_turnover: {
    sensitivity_level: "alto", usable_for_scoring: true,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "180d", forbidden_phrases: BASE_FORBIDDEN,
  },
  motivated_seller: {
    sensitivity_level: "alto", usable_for_scoring: true,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "180d", forbidden_phrases: BASE_FORBIDDEN,
  },
  legal_distress: {
    sensitivity_level: "alto", usable_for_scoring: true,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "180d", forbidden_phrases: BASE_FORBIDDEN,
  },
  // Esclusi: mai usati, mai esposti
  personal_data: {
    sensitivity_level: "escluso", usable_for_scoring: false,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "30d", forbidden_phrases: BASE_FORBIDDEN,
  },
  social_private: {
    sensitivity_level: "escluso", usable_for_scoring: false,
    visible_to_agency: false, visible_to_owner: false,
    retention_policy: "30d", forbidden_phrases: BASE_FORBIDDEN,
  },
};

const FALLBACK_POLICY: SignalPolicyDefaults = {
  sensitivity_level: "medio",
  usable_for_scoring: true,
  visible_to_agency: false,
  visible_to_owner: false,
  retention_policy: "90d",
  forbidden_phrases: BASE_FORBIDDEN,
};

export function getSignalPolicy(signal_type: string): SignalPolicyDefaults {
  return POLICY_DEFAULTS[signal_type] ?? FALLBACK_POLICY;
}

// ─────────────────────────────────────────────
// Costruisce il record Core a partire da input grezzo
// ─────────────────────────────────────────────
export function classifySignal(input: {
  signal_id: string;
  signal_type: string;
  source_name_internal: string;
  collected_at?: string;
  confidence_level?: SignalConfidence;
  allowed_commercial_phrase?: string | null;
  override?: Partial<SignalPolicyDefaults>;
}): SignalCoreRecord {
  const policy = { ...getSignalPolicy(input.signal_type), ...(input.override ?? {}) };

  // Regola 2: "escluso" => mai usabile, mai visibile
  const excluded = policy.sensitivity_level === "escluso";
  // Regola 1: "alto" => mai visibile all'agenzia (e mai al proprietario)
  const high = policy.sensitivity_level === "alto";

  return {
    signal_id: input.signal_id,
    signal_type: input.signal_type,
    source_name_internal: input.source_name_internal,
    collected_at: input.collected_at ?? new Date().toISOString(),
    confidence_level: input.confidence_level ?? "media",
    sensitivity_level: policy.sensitivity_level,
    usable_for_scoring: excluded ? false : policy.usable_for_scoring,
    visible_to_agency: excluded || high ? false : policy.visible_to_agency,
    visible_to_owner: excluded || high ? false : policy.visible_to_owner,
    allowed_commercial_phrase: excluded ? null : (input.allowed_commercial_phrase ?? null),
    forbidden_phrases: policy.forbidden_phrases,
    retention_policy: policy.retention_policy,
  };
}

// ─────────────────────────────────────────────
// Sanitizer: rimuove forbidden_phrases da una stringa
// ─────────────────────────────────────────────
export function sanitizePhrase(text: string, forbidden: string[]): string {
  let out = text;
  for (const word of forbidden) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "giu");
    out = out.replace(re, "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

// ─────────────────────────────────────────────
// Vista agenzia: SOLO se visible_to_agency e con allowed_commercial_phrase
// ─────────────────────────────────────────────
export function toAgencySignalView(rec: SignalCoreRecord): SignalAgencyView | null {
  if (!rec.visible_to_agency) return null;
  if (rec.sensitivity_level === "alto" || rec.sensitivity_level === "escluso") return null;
  const phrase = rec.allowed_commercial_phrase
    ? sanitizePhrase(rec.allowed_commercial_phrase, rec.forbidden_phrases)
    : "";
  if (!phrase) return null;
  return {
    signal_id: rec.signal_id,
    signal_type: rec.signal_type,
    confidence_level: rec.confidence_level,
    collected_at: rec.collected_at,
    commercial_phrase: phrase,
  };
}

// ─────────────────────────────────────────────
// Vista proprietario: SOLO frasi neutre/commerciali
// ─────────────────────────────────────────────
export function toOwnerSignalView(
  rec: SignalCoreRecord,
  topic: string,
  neutralPhrase: string,
): SignalOwnerView | null {
  if (!rec.visible_to_owner) return null;
  if (rec.sensitivity_level === "alto" || rec.sensitivity_level === "escluso") return null;
  const phrase = sanitizePhrase(neutralPhrase, rec.forbidden_phrases);
  if (!phrase) return null;
  return { topic, phrase };
}

// ─────────────────────────────────────────────
// Filtro batch: usabili per scoring
// ─────────────────────────────────────────────
export function filterScorable(records: SignalCoreRecord[]): SignalCoreRecord[] {
  return records.filter((r) => r.usable_for_scoring && r.sensitivity_level !== "escluso");
}

// Guard runtime: blocca chiavi Core nei payload verso PWA
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "source_name_internal",
  "sensitivity_level",
  "usable_for_scoring",
  "visible_to_owner",
  "forbidden_phrases",
  "retention_policy",
]);

export function assertSignalSafeForAgency(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
      throw new Error(`signal_view_violation:${key}`);
    }
  }
}
