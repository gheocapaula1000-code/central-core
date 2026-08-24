// TrovaBandi — stato di verifica fail-closed.
//
// VERIFICATO soltanto se il testo ufficiale attesta sia la scadenza sia
// il contributo massimo. SPORTELLO se la citazione ufficiale prova una
// misura a sportello senza data di chiusura: deadline_at resta NULL.
// Nessuna invenzione di date, importi, COMPATIBILE o ATECO 62.

export type OfficialVerification =
  | "VERIFICATO"
  | "PARZIALE"
  | "SCADUTO"
  | "DA_VERIFICARE"
  | "SPORTELLO";

/** Stati aperti in catalogo / feed / backfill. Non include SCADUTO né RITIRATO. */
export const OPEN_VERIFICATION_STATUSES = [
  "VERIFICATO",
  "PARZIALE",
  "DA_VERIFICARE",
  "SPORTELLO",
] as const;

/** Stati che possono diventare SCADUTO se deadline_at è già passata. */
export const EXPIRE_VERIFICATION_STATUSES = [
  "VERIFICATO",
  "PARZIALE",
  "DA_VERIFICARE",
  "SPORTELLO",
] as const;

export function hasPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeOfficialText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[*_`>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Citazioni ufficiali inequivocabili: niente sportello telematico, niente URL. */
const QUOTE_A_SPORTELLO =
  /\ba\s+sportello\b(?!\s+(?:telematic|informat|online|web|digital))/;
const QUOTE_FINO_ESAURIMENTO =
  /\bfino\s+(?:ad?|all['’]?)\s*esaurimento\b/;
const QUOTE_SENZA_SCADENZA =
  /\bsenza\s+(?:alcuna\s+)?scadenza\b/;
const QUOTE_NON_HA_SCADENZA =
  /\bnon\s+ha\s+(?:una\s+)?scadenza\b/;

/** Chiusura esplicita: la misura ha una data, non è sportello-senza-scadenza. */
const HARD_CLOSE =
  /(?:chiusura\s+(?:dello\s+)?sportello|sportello\s+chiude|entro\s+e\s+non\s+oltre|non\s+oltre\s+(?:il|la|le)\s+|termine\s+(?:ultimo|finale|perentorio)|scadenza\s+(?:il|al|fissata|prevista)|fino\s+al\s+\d)/;
const NUMBERED_WINDOW =
  /\b(?:primo|secondo|terzo|quarto|1[º°]|2[º°]|3[º°])\s+sportello\b/;
const NEGATED_SENZA =
  /\bnon\s+(?:è|e['’])\s+senza\s+scadenza\b/;

/**
 * Fail-closed: true solo se il testo ufficiale cita in modo inequivocabile
 * una misura a sportello senza data di chiusura.
 * "a sportello telematico", "primo sportello", "fino a esaurimento e
 * comunque non oltre il …" non bastano.
 */
export function isProvenSportelloSenzaScadenza(text: unknown): boolean {
  if (typeof text !== "string" || text.trim().length < 20) return false;
  const t = normalizeOfficialText(text);
  if (t.length < 20) return false;

  const senzaScadenza = QUOTE_SENZA_SCADENZA.test(t) && !NEGATED_SENZA.test(t);
  const nonHaScadenza = QUOTE_NON_HA_SCADENZA.test(t);
  if (senzaScadenza || nonHaScadenza) return true;

  const aSportello = QUOTE_A_SPORTELLO.test(t);
  const finoEsaurimento = QUOTE_FINO_ESAURIMENTO.test(t);
  if (!aSportello && !finoEsaurimento) return false;
  if (NUMBERED_WINDOW.test(t)) return false;
  if (HARD_CLOSE.test(t)) return false;
  return true;
}

/**
 * Promozione allo stato catalogo. Fail-closed:
 * - SCADUTO solo con data di scadenza attestata e già passata;
 * - VERIFICATO solo con evidenza + scadenza attestata + contributo massimo;
 * - SPORTELLO se la citazione ufficiale prova l'assenza di chiusura
 *   (anche con max_grant_amount). deadline_at deve restare NULL;
 * - PARZIALE se c'è testo ufficiale ma manca uno dei due campi;
 * - DA_VERIFICARE senza evidenza.
 * Non inventa COMPATIBILE.
 */
export function officialVerificationStatus(input: {
  hasEvidence: boolean;
  deadline: string | null | undefined;
  deadlineProven: boolean;
  maxGrantAmount: number | null | undefined;
  sportelloSenzaScadenza?: boolean;
  now?: Date;
}): OfficialVerification {
  const deadline =
    typeof input.deadline === "string" && input.deadline.trim()
      ? input.deadline
      : null;
  const expired = deadline
    ? new Date(deadline).getTime() < (input.now ?? new Date()).getTime()
    : false;

  if (expired && input.deadlineProven) return "SCADUTO";

  // Sportello senza chiusura: stato completo e onesto. Non VERIFICATO
  // (manca deadline_at) e non PARZIALE / DA_VERIFICARE.
  if (input.hasEvidence && input.sportelloSenzaScadenza === true && !input.deadlineProven) {
    return "SPORTELLO";
  }

  if (
    input.hasEvidence &&
    deadline &&
    input.deadlineProven &&
    hasPositiveAmount(input.maxGrantAmount)
  ) {
    return "VERIFICATO";
  }
  if (input.hasEvidence) return "PARZIALE";
  return "DA_VERIFICARE";
}
