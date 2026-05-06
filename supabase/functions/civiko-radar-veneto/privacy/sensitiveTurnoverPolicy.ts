// ═══════════════════════════════════════════════════════════════
// sensitiveTurnoverPolicy.ts — privacy guard for sensitive turnover.
// Blocca outreach nominativi e messaggi legati a lutto/decesso/eredi.
// Permette uso aggregato (zona) per scoring e insights.
// ═══════════════════════════════════════════════════════════════

const CF_RE = /\b[A-Z]{6}\d{2}[A-EHLMPRT]\d{2}[A-Z]\d{3}[A-Z]\b/g;
const PHONE_RE = /\b(\+?\d{1,3}[\s.-]?)?\d{2,4}[\s.-]?\d{5,8}\b/g;
const EMAIL_RE = /\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const NAME_LIKE_RE = /\b[A-ZÀÉÈÌÒÙ][a-zàéèìòù]{2,}\s+[A-ZÀÉÈÌÒÙ][a-zàéèìòù]{2,}\b/g;
const FULL_ADDRESS_RE = /\b(via|viale|piazza|piazzale|corso|vicolo|strada|largo|contrà)\s+[A-Za-zÀ-ÿ' .-]+\s*,?\s*\d+\b/gi;

const FORBIDDEN_TOPIC_TOKENS = [
  "lutto","luttuoso","deceduto","deceduta","decesso","defunto","defunta",
  "morto","morta","morte","funerale","funerali","necrologio","obituario",
  "successione","eredità","eredi","erede","testamento","de cuius",
  "ci ha lasciato","spentosi","spentasi","onoranze","cimitero","tomba","loculo",
];

export type Classification = "aggregate" | "nominative" | "individual_event" | "unknown";

export interface SensitiveTurnoverInput {
  signal_type?: string | null;
  area_type?: string | null;
  comune?: string | null;
  provincia?: string | null;
  title?: string | null;
  description?: string | null;
  payload?: Record<string, unknown> | null;
  text?: string | null;
}

export interface PolicyDecision {
  classification: Classification;
  privacy_safe: boolean;
  allowed_for_standard_radar: boolean;
  allowed_for_agency_private: boolean;
  allowed_for_campaign: boolean;
  required_status: "ok" | "needs_review" | "rejected";
  rejection_reason?: string;
  suggested_redactions: string[];
  redacted_excerpt: string;
}

export function classifySensitiveTurnoverItem(input: SensitiveTurnoverInput): PolicyDecision {
  const text = [input.title, input.description, input.text, JSON.stringify(input.payload ?? {})]
    .filter(Boolean).join("\n");
  const lower = text.toLowerCase();

  const suggested_redactions: string[] = [];
  if (CF_RE.test(text)) suggested_redactions.push("codice_fiscale");
  if (PHONE_RE.test(text)) suggested_redactions.push("telefono");
  if (EMAIL_RE.test(text)) suggested_redactions.push("email");
  if (FULL_ADDRESS_RE.test(text)) suggested_redactions.push("indirizzo_completo");
  if (NAME_LIKE_RE.test(text)) suggested_redactions.push("nome_persona");

  const isAggregateArea = ["comune","quartiere","microzona","sezione_censuaria","cap","zona_omi"]
    .includes((input.area_type ?? "").toLowerCase());

  const hasNominativeContent = suggested_redactions.includes("nome_persona") ||
    suggested_redactions.includes("codice_fiscale") ||
    suggested_redactions.includes("telefono") ||
    suggested_redactions.includes("email");

  const hasForbiddenTopic = FORBIDDEN_TOPIC_TOKENS.some((t) => lower.includes(t));

  let classification: Classification = "unknown";
  if (isAggregateArea && !hasNominativeContent) classification = "aggregate";
  else if (hasNominativeContent && hasForbiddenTopic) classification = "individual_event";
  else if (hasNominativeContent) classification = "nominative";
  else if (isAggregateArea) classification = "aggregate";

  const redacted_excerpt = redactSensitive(text).slice(0, 600);

  if (classification === "aggregate") {
    return {
      classification, privacy_safe: true,
      allowed_for_standard_radar: false,        // resta in modulo dedicato
      allowed_for_agency_private: true,
      allowed_for_campaign: true,                // campagne neutre di zona
      required_status: "ok",
      suggested_redactions, redacted_excerpt,
    };
  }

  // Tutti i casi nominativi/eventi individuali
  return {
    classification: classification === "unknown" ? "nominative" : classification,
    privacy_safe: false,
    allowed_for_standard_radar: false,
    allowed_for_agency_private: false,           // richiede review esplicita
    allowed_for_campaign: false,                 // mai outreach nominativo
    required_status: classification === "individual_event" ? "rejected" : "needs_review",
    rejection_reason: classification === "individual_event"
      ? "individual_death_or_succession_event_not_usable"
      : "nominative_data_requires_review",
    suggested_redactions, redacted_excerpt,
  };
}

export function redactSensitive(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(CF_RE, "[cf]")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[tel]")
    .replace(FULL_ADDRESS_RE, "[indirizzo]")
    .replace(NAME_LIKE_RE, "[nome]");
}

const FORBIDDEN_SCRIPT_RE = new RegExp(
  `\\b(${FORBIDDEN_TOPIC_TOKENS.map((t) => t.replace(/\s+/g, "\\s+")).join("|")})\\b`, "i",
);

export function isScriptSafeForSensitiveTurnover(script: string): { safe: boolean; reason?: string } {
  if (!script) return { safe: true };
  const m = script.match(FORBIDDEN_SCRIPT_RE);
  if (m) return { safe: false, reason: `forbidden_term:${m[1]}` };
  return { safe: true };
}

export function buildNeutralZoneScript(comune: string, area_label?: string | null): string {
  const where = area_label ? `${area_label} (${comune})` : comune;
  return `Stiamo aggiornando il report valori per ${where} per aiutare i proprietari a capire come OMI, servizi e domanda locale incidono sulla valutazione.`;
}
