// Classificazione lead privati per Subito / Bakeca.
//
// privato        → annuncio di privato pubblicato da meno di 60 giorni e senza ribassi significativi
// privato_stanco → annuncio di privato con anzianità >= 60 giorni OPPURE ribasso cumulato >= 5%
//
// I "privato_stanco" sono i candidati primari per il Pacchetto Incarico.

export type TipoLead = "privato" | "privato_stanco";

export interface LeadClassificationInput {
  /** Data prima pubblicazione (ISO o Date). Se assente, si usa imported_at. */
  firstSeenAt?: string | Date | null;
  importedAt?: string | Date | null;
  /** Prezzo attuale e prezzo originale (se noto). */
  prezzoAttuale?: number | null;
  prezzoOriginale?: number | null;
  /** Flag: annuncio di privato (true) o agenzia (false). I lead agenzia vanno scartati prima. */
  isPrivato: boolean;
}

export interface LeadClassificationResult {
  tipo_lead: TipoLead;
  age_days: number | null;
  sconto_pct: number | null;
  motivo: string;
}

const STANCO_AGE_DAYS = 60;
const STANCO_SCONTO_PCT = 5;

export function classifyPrivateLead(input: LeadClassificationInput): LeadClassificationResult {
  const ref = input.firstSeenAt ?? input.importedAt ?? null;
  let ageDays: number | null = null;
  if (ref) {
    const d = typeof ref === "string" ? new Date(ref) : ref;
    if (!isNaN(d.getTime())) {
      ageDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    }
  }

  let scontoPct: number | null = null;
  if (
    typeof input.prezzoAttuale === "number" &&
    typeof input.prezzoOriginale === "number" &&
    input.prezzoOriginale > 0 &&
    input.prezzoAttuale < input.prezzoOriginale
  ) {
    scontoPct = ((input.prezzoOriginale - input.prezzoAttuale) / input.prezzoOriginale) * 100;
  }

  const stancoPerAnzianita = ageDays !== null && ageDays >= STANCO_AGE_DAYS;
  const stancoPerSconto = scontoPct !== null && scontoPct >= STANCO_SCONTO_PCT;

  if (stancoPerAnzianita || stancoPerSconto) {
    const reasons: string[] = [];
    if (stancoPerAnzianita) reasons.push(`anzianità ${ageDays} giorni`);
    if (stancoPerSconto) reasons.push(`ribasso ${scontoPct!.toFixed(1)}%`);
    return {
      tipo_lead: "privato_stanco",
      age_days: ageDays,
      sconto_pct: scontoPct,
      motivo: `Lead privato stanco: ${reasons.join(" + ")}.`,
    };
  }

  return {
    tipo_lead: "privato",
    age_days: ageDays,
    sconto_pct: scontoPct,
    motivo: "Lead privato fresco.",
  };
}
