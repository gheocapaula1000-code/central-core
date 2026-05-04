// ═══════════════════════════════════════════════════════════════
// privacyGuard.ts — guardrail privacy per segnali aggregati.
// Vietato: nomi persona, necrologi nominativi, indirizzi privati,
// targeting eredi/lutti individuali. Solo aggregati/statistiche.
// ═══════════════════════════════════════════════════════════════

const NAME_LIKE_RE = /\b[A-ZÀÉÈÌÒÙ][a-zàéèìòù]{2,}\s+[A-ZÀÉÈÌÒÙ][a-zàéèìòù]{2,}\b/g;
const PHONE_RE = /\b(\+?\d{1,3}[\s.-]?)?\d{2,4}[\s.-]?\d{5,8}\b/g;
const EMAIL_RE = /\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const CF_RE = /\b[A-Z]{6}\d{2}[A-EHLMPRT]\d{2}[A-Z]\d{3}[A-Z]\b/g;
const DEATH_DATE_RE = /\b(deceduto|deceduta|defunto|defunta|nato il|nata il|morto il|morta il|spentosi|spentasi|ci ha lasciato)\b/i;

const NOMINATIVE_HINTS = [
  "necrologio","necrologi","obituario","obituari","obitorio","obituary",
  "lutto","funerale","funerali","onoranze","manifesto funebre","tomba",
  "loculo","cimitero","sepoltura","commemorazione","ricordo di","in memoria di",
  "annuncio funebre","partecipazione al lutto","visita salma",
];
const HEIRS_HINTS = [
  "eredi","erede","famiglia ","parenti tutti","i figli","la moglie","il marito",
  "i nipoti","il fratello","la sorella","i cari","i familiari",
];

export type SensitiveClassification =
  | "ok_aggregate"
  | "rejected_personal_data"
  | "rejected_nominative_obituary"
  | "rejected_individual_death_signal"
  | "rejected_heir_targeting";

export interface PrivacyDecision {
  allowed: boolean;
  classification: SensitiveClassification;
  rejected_reason?: string;
  redacted_excerpt: string;
}

export function classifySensitiveSource(opts: {
  url: string;
  title: string | null;
  markdown: string | null;
}): PrivacyDecision {
  const url = (opts.url || "").toLowerCase();
  const text = `${opts.title ?? ""}\n${opts.markdown ?? ""}`;
  const lower = text.toLowerCase();

  // 1) URL/dominio nominativo: necrologi/obitori → rifiuto a priori
  if (/necrolog|obituar|obituari|onoranze|funebr|cimiter/.test(url)) {
    return decide("rejected_nominative_obituary", "Fonte nominativa funebre/cimiteriale non utilizzabile per targeting immobiliare.", text);
  }

  // 2) Hint nominativi nel testo
  const hasNominativeHint = NOMINATIVE_HINTS.some((h) => lower.includes(h));
  const hasHeirsHint = HEIRS_HINTS.some((h) => lower.includes(h));
  const hasDeathDate = DEATH_DATE_RE.test(text);
  const hasNameLike = (text.match(NAME_LIKE_RE)?.length ?? 0) >= 2;

  if (hasNominativeHint && (hasNameLike || hasDeathDate)) {
    return decide("rejected_nominative_obituary", "Necrologio/obitorio nominativo: scartato.", text);
  }
  if (hasHeirsHint && hasNameLike) {
    return decide("rejected_heir_targeting", "Riferimenti a eredi/famiglie specifiche: scartato.", text);
  }
  if (hasDeathDate && hasNameLike) {
    return decide("rejected_individual_death_signal", "Evento luttuoso individuale: scartato.", text);
  }

  // 3) Personal markers (telefono/email/CF) — non basta a scartare se la pagina
  //    è chiaramente istituzionale (ISTAT/comune/regione/OMI), ma si redige.
  return decide("ok_aggregate", undefined, text);
}

function decide(classification: SensitiveClassification, reason: string | undefined, raw: string): PrivacyDecision {
  return {
    allowed: classification === "ok_aggregate",
    classification,
    rejected_reason: reason,
    redacted_excerpt: redactPersonalFields(raw).slice(0, 600),
  };
}

export function redactPersonalFields(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[tel]")
    .replace(CF_RE, "[cf]");
}

export function rejectPersonalName(_name: unknown): never {
  throw new Error("rejectPersonalName: estrazione nomi vietata.");
}
export function rejectObituaryRecord(_rec: unknown): never {
  throw new Error("rejectObituaryRecord: record nominativo non importabile.");
}
export function rejectHeirTargeting(_rec: unknown): never {
  throw new Error("rejectHeirTargeting: targeting eredi vietato.");
}
export function rejectIndividualDeathSignal(_rec: unknown): never {
  throw new Error("rejectIndividualDeathSignal: segnale individuale vietato.");
}

export function requireAggregateArea(area_type: string): boolean {
  return ["comune","quartiere","microzona","sezione_censuaria","cap","zona_omi"].includes(area_type);
}

export function allowAggregateOnly<T extends { area_type?: string }>(record: T): T {
  if (!record.area_type || !requireAggregateArea(record.area_type)) {
    throw new Error("allowAggregateOnly: area_type non aggregato.");
  }
  return record;
}
