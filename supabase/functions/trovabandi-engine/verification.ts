// TrovaBandi — stato di verifica fail-closed.
// VERIFICATO soltanto se il testo ufficiale attesta sia la scadenza sia
// il contributo massimo. Nessuna invenzione di date, importi o COMPATIBILE.

export type OfficialVerification =
  | "VERIFICATO"
  | "PARZIALE"
  | "SCADUTO"
  | "DA_VERIFICARE";

export function hasPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Promozione allo stato catalogo. Fail-closed:
 * - SCADUTO solo con data di scadenza attestata e già passata;
 * - VERIFICATO solo con evidenza + scadenza attestata + contributo massimo;
 * - PARZIALE se c'è testo ufficiale ma manca uno dei due campi;
 * - DA_VERIFICARE senza evidenza.
 */
export function officialVerificationStatus(input: {
  hasEvidence: boolean;
  deadline: string | null | undefined;
  deadlineProven: boolean;
  maxGrantAmount: number | null | undefined;
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
