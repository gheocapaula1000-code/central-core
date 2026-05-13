// Metodo Civiko One — Opportunità immobiliari
// Tre livelli di visibilità: interno Core, agenzia, dossier proprietario.
// Regola: meglio assente che fragile. Stime restano stime, fonti grezze restano interne.

export type Temperature = "caldo" | "tiepido" | "freddo";
export type Priority = "alta" | "media" | "bassa";
export type DossierStatus = "pronto" | "in_preparazione" | "non_disponibile";
export type SensitivityLevel = "basso" | "medio" | "alto";
export type PropertyType = "residenziale" | "commerciale" | "terreno";

// ─────────────────────────────────────────────
// 1) INTERNAL CORE — non esporre mai alla PWA
// ─────────────────────────────────────────────
export interface OpportunityInternal {
  id: string;
  territory_id: string;
  microzone_id: string;
  property_cluster_id: string;
  internal_signals: string[];
  internal_sources: Array<{ name: string; ref?: string }>;
  source_timestamps: Record<string, string>;
  raw_confidence_score: number; // 0..1
  normalized_priority_score: number; // 0..100
  sensitivity_level: SensitivityLevel;
  data_conflicts: string[];
  exclusion_reasons: string[];
  provider_cost_estimate_eur: number;
  last_checked_at: string;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────
// 2) AGENCY VIEW — esponibile alla PWA agenzie
// ─────────────────────────────────────────────
export interface OpportunityAgency {
  id: string;
  title: string;
  territory: string;
  microzone: string;
  property_type: PropertyType;
  temperature: Temperature;
  priority: Priority;
  assignment_probability: number; // 0..100, stimato
  estimated_value: number; // EUR, stimato
  commission_potential: number; // EUR, stimato
  window_label: string;
  commercial_reason: string;
  next_action: string;
  dossier_status: DossierStatus;
  recommended_timing: string;
  visible_to_agency: boolean;
}

// ─────────────────────────────────────────────
// 3) OWNER DOSSIER — presentabile al proprietario
// ─────────────────────────────────────────────
export interface OpportunityOwnerDossier {
  zone_summary: string;
  market_window: string;
  property_positioning: string;
  preliminary_value_range: { min: number; max: number; currency: "EUR"; basis: "stimato" };
  sale_strategy: string;
  next_step: string;
  disclaimer: string;
}

// ─────────────────────────────────────────────
// Mappatura score → temperatura / priorità
// ─────────────────────────────────────────────
export function temperatureFromScore(score0to100: number): Temperature {
  if (score0to100 >= 70) return "caldo";
  if (score0to100 >= 45) return "tiepido";
  return "freddo";
}

export function priorityFromScore(score0to100: number): Priority {
  if (score0to100 >= 70) return "alta";
  if (score0to100 >= 45) return "media";
  return "bassa";
}

export function windowLabelFromScore(score0to100: number): string {
  if (score0to100 >= 70) return "Finestra utile aperta";
  if (score0to100 >= 45) return "Momento da monitorare";
  return "Da osservare nei prossimi mesi";
}

export function recommendedTimingFromScore(score0to100: number): string {
  if (score0to100 >= 70) return "entro 7 giorni";
  if (score0to100 >= 45) return "entro 30 giorni";
  return "entro 90 giorni";
}

// ─────────────────────────────────────────────
// Redaction: Internal → Agency
// ─────────────────────────────────────────────
const FORBIDDEN_AGENCY_KEYS = new Set([
  "internal_signals",
  "internal_sources",
  "source_timestamps",
  "raw_confidence_score",
  "normalized_priority_score",
  "sensitivity_level",
  "data_conflicts",
  "exclusion_reasons",
  "provider_cost_estimate_eur",
  "territory_id",
  "microzone_id",
  "property_cluster_id",
]);

export function toAgencyView(
  internal: OpportunityInternal,
  presentation: {
    title: string;
    territory: string;
    microzone: string;
    property_type: PropertyType;
    estimated_value: number;
    commission_potential: number;
    commercial_reason: string;
    next_action: string;
    dossier_status: DossierStatus;
  },
): OpportunityAgency {
  // Mai serializzare campi interni: costruisco da zero solo i campi visibili.
  const score = internal.normalized_priority_score;
  const view: OpportunityAgency = {
    id: internal.id,
    title: presentation.title,
    territory: presentation.territory,
    microzone: presentation.microzone,
    property_type: presentation.property_type,
    temperature: temperatureFromScore(score),
    priority: priorityFromScore(score),
    assignment_probability: Math.max(0, Math.min(100, Math.round(score))),
    estimated_value: presentation.estimated_value,
    commission_potential: presentation.commission_potential,
    window_label: windowLabelFromScore(score),
    commercial_reason: presentation.commercial_reason,
    next_action: presentation.next_action,
    dossier_status: presentation.dossier_status,
    recommended_timing: recommendedTimingFromScore(score),
    visible_to_agency: internal.exclusion_reasons.length === 0,
  };
  return view;
}

// Guard runtime: rifiuta payload che contengano chiavi vietate.
export function assertAgencySafe(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_AGENCY_KEYS.has(key)) {
      throw new Error(`agency_view_violation:${key}`);
    }
  }
}

// ─────────────────────────────────────────────
// Owner Dossier: copy prudente, mai invasivo
// ─────────────────────────────────────────────
const OWNER_DISCLAIMER =
  "Le indicazioni sono di natura commerciale e basate su stime di zona. Il valore definitivo dipende da sopralluogo, documenti e condizioni di mercato al momento della trattativa.";

export function toOwnerDossier(
  agency: OpportunityAgency,
  range: { min: number; max: number },
  zoneSummary: string,
): OpportunityOwnerDossier {
  return {
    zone_summary: zoneSummary,
    market_window: agency.window_label,
    property_positioning:
      "L'immobile, per tipologia e collocazione, può essere presentato con un posizionamento mirato che valorizzi i punti distintivi.",
    preliminary_value_range: { min: range.min, max: range.max, currency: "EUR", basis: "stimato" },
    sale_strategy:
      "Strategia consigliata: definizione del prezzo coerente con il mercato attuale, materiali professionali e piano visite ordinato.",
    next_step: "Concordare un incontro per condividere il piano di valorizzazione e i tempi attesi.",
    disclaimer: OWNER_DISCLAIMER,
  };
}
