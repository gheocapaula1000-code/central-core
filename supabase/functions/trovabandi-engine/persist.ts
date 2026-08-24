// TrovaBandi — persistenza fail-closed dell'opportunità e della sua prova.
//
// Ordine obbligatorio e non negoziabile:
//   1) upsert opportunity in stato DA_VERIFICARE con last_verified_at = null;
//   2) upsert evidence;
//   3) solo se la prova è persistita, promozione allo stato calcolato
//      (VERIFICATO / PARZIALE / SCADUTO) con last_verified_at valorizzato
//      esclusivamente per VERIFICATO.
//
// Nessuna compensazione best-effort, nessun delete: se evidence o promozione
// falliscono la riga resta DA_VERIFICARE e il risultato è stored=false.

import { sanitizeDbErrorCode } from "./extraction.ts";

export type PersistRow = Record<string, unknown>;

export type PersistVerification =
  | "VERIFICATO"
  | "PARZIALE"
  | "SPORTELLO"
  | "SCADUTO"
  | "DA_VERIFICARE";

export interface PersistClient {
  /** Upsert opportunity: deve restituire l'id oppure un errore. */
  upsertOpportunity(row: PersistRow): Promise<{ id?: string | null; error?: unknown }>;
  /** Upsert evidence collegata all'opportunity. */
  upsertEvidence(row: PersistRow): Promise<{ error?: unknown }>;
  /** UPDATE di promozione allo stato calcolato. */
  promote(id: string, patch: PersistRow): Promise<{ error?: unknown }>;
}

export type PersistResult = { stored: boolean; verified: boolean; code: string };

export async function persistOpportunityFailClosed(
  client: PersistClient,
  input: {
    row: PersistRow;
    evidence: PersistRow;
    /** Prove aggiuntive (pagina o PDF di dettaglio ufficiale) dello stesso run. */
    extraEvidence?: PersistRow[];
    verification: PersistVerification;
    nowIso: string;
  },
): Promise<PersistResult> {
  const { row, evidence, extraEvidence = [], verification, nowIso } = input;

  // 1) Stato iniziale sempre non verificato: nessun dato "verificato" senza prova.
  const initial = await client.upsertOpportunity({
    ...row,
    verification_status: "DA_VERIFICARE",
    last_verified_at: null,
    updated_at: nowIso,
  });
  if (initial.error || !initial.id) {
    return {
      stored: false,
      verified: false,
      code: `OPPORTUNITY_WRITE_FAILED_${
        initial.error ? sanitizeDbErrorCode(initial.error) : "DB_NO_ROW"
      }`,
    };
  }
  const id = initial.id;

  // 2) Prova ufficiale.
  const evidenceResult = await client.upsertEvidence({ ...evidence, opportunity_id: id });
  if (evidenceResult.error) {
    return {
      stored: false,
      verified: false,
      code: `EVIDENCE_WRITE_FAILED_${sanitizeDbErrorCode(evidenceResult.error)}`,
    };
  }

  // 2b) Prove di dettaglio: stesse regole fail-closed, nessun best-effort.
  for (const extra of extraEvidence) {
    const extraResult = await client.upsertEvidence({ ...extra, opportunity_id: id });
    if (extraResult.error) {
      return {
        stored: false,
        verified: false,
        code: `EVIDENCE_WRITE_FAILED_${sanitizeDbErrorCode(extraResult.error)}`,
      };
    }
  }


  // 3) Promozione allo stato calcolato soltanto dopo la prova persistita.
  if (verification !== "DA_VERIFICARE") {
    const promotion = await client.promote(id, {
      verification_status: verification,
      last_verified_at: verification === "VERIFICATO" ? nowIso : null,
      updated_at: nowIso,
    });
    if (promotion.error) {
      return {
        stored: false,
        verified: false,
        code: `PROMOTION_WRITE_FAILED_${sanitizeDbErrorCode(promotion.error)}`,
      };
    }
  }

  return {
    stored: true,
    verified: verification === "VERIFICATO",
    code: `OK_${verification}`,
  };
}

