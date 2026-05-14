// Central Core — Step 4 workflow pilota Arcella
// Flow interno: normalizza → valida → (se valido) salva snapshot in `microzona_dossier`.
// Nessuna pubblicazione PWA, nessuna edge function, nessuna AI generativa.
// Side effect consentito: una sola INSERT su `microzona_dossier` quando la
// validazione restituisce "valid" o "valid_with_warnings".

import { supabase } from "@/integrations/supabase/client";
import {
  normalizeMicrozona,
  type MicrozonaDossierPayload,
  type NormalizeMicrozonaInput,
} from "@/lib/normalizeMicrozona";
import {
  validateMicrozonaDossier,
  type ValidationResult,
} from "@/lib/validateMicrozonaDossier";

export interface SaveSnapshotOutcome {
  ok: boolean;
  inserted: boolean;
  result: ValidationResult;
  errors: string[];
  warnings: string[];
  dossier?: MicrozonaDossierPayload;
  snapshot_id?: string;
}

/**
 * Flow Core per Arcella:
 *  1) normalizeMicrozona(input)
 *  2) validateMicrozonaDossier(dossier)
 *  3) INSERT in `microzona_dossier` SOLO se result ∈ {valid, valid_with_warnings}
 *
 * `created_by` viene volutamente omesso: il trigger
 * `tr_microzona_dossier_created_by` lo popola da `auth.uid()` se presente.
 */
export async function saveValidatedMicrozonaSnapshot(
  input: NormalizeMicrozonaInput,
): Promise<SaveSnapshotOutcome> {
  const dossier = normalizeMicrozona(input);
  const validation = validateMicrozonaDossier(dossier);

  // Caso invalid → nessuna scrittura.
  if (validation.result === "invalid") {
    return {
      ok: false,
      inserted: false,
      result: "invalid",
      errors: validation.errors,
      warnings: validation.warnings,
      dossier,
    };
  }

  // Caso valid o valid_with_warnings → salva snapshot.
  const { data, error } = await supabase
    .from("microzona_dossier")
    .insert([{
      microzona_id: dossier.microzona_id,
      versione: dossier.versione,
      stato: dossier.stato, // resta "approvata_interna" in questo step
      servizi_prossimita: dossier.servizi_prossimita,
      segnali_territoriali: dossier.segnali_territoriali,
      opportunita_candidate: dossier.opportunita_candidate,
      asset_osservati: dossier.asset_osservati,
      note_interne: dossier.note_interne || null,
    }])
    .select("id")
    .single();

  if (error) {
    return {
      ok: false,
      inserted: false,
      result: validation.result,
      errors: [`insert fallita: ${error.message}`],
      warnings: validation.warnings,
      dossier,
    };
  }

  return {
    ok: true,
    inserted: true,
    result: validation.result,
    errors: [],
    warnings: validation.warnings,
    dossier,
    snapshot_id: data?.id,
  };
}
