// Civiko Zone Access Gate — Checkpoint 11B-A
// ---------------------------------------------------------------------------
// Sostituisce il vecchio gate "solo Centro Storico" con il gate
// "una sola zona ufficiale assegnata".
//
// Regole:
// - per i source-app Civiko One il perimetro dati è SEMPRE esattamente una
//   delle 8 zone ufficiali;
// - la zona deriva solo da trial/occupazione/membership risolti server-side:
//   lo slug del client può soltanto RESTRINGERE a una zona già autorizzata,
//   mai ampliare il perimetro;
// - zero zone o più zone senza scelta esplicita → fail-closed;
// - nessuna modalità full-city, nessuna aggregazione delle 8 zone;
// - gli admin (che risultano autorizzati su tutte e 8) devono indicare una
//   zona ufficiale per volta.
//
// Modulo puro: nessun DB, nessuna rete.

import { isCivikoCommercialZoneSlug } from "./civikoCommercialZoneContract.ts";
import {
  isCivikoPilotSourceApp,
  normalizeSourceApp,
} from "./civikoTerritoryContractPadovaPilotV1.ts";

export { isCivikoPilotSourceApp as isCivikoSourceApp, normalizeSourceApp };

export type CivikoZoneGateErrorCode =
  | "NO_ZONE_ASSIGNED"
  | "MULTIPLE_ZONES_ASSIGNED"
  | "ZONE_NOT_ASSIGNED"
  | "SLUG_OUT_OF_CONTRACT";

export type CivikoZoneGateResult =
  | { civiko: false; ok: true; slugs: string[] }
  | { civiko: true; ok: true; slugs: [string] }
  | { civiko: true; ok: false; code: CivikoZoneGateErrorCode };

/**
 * Applica il gate a zona singola.
 *
 * @param sourceApp        header `x-source-app` (grezzo).
 * @param authorizedSlugs  slug già risolti server-side per il workspace.
 * @param requestedSlug    slug eventualmente richiesto dal client: usato
 *                         SOLO per restringere, mai per ampliare.
 */
export function applyCivikoSingleZoneGate(
  sourceApp: unknown,
  authorizedSlugs: readonly string[],
  requestedSlug?: unknown,
): CivikoZoneGateResult {
  const civiko = isCivikoPilotSourceApp(sourceApp);
  if (!civiko) return { civiko: false, ok: true, slugs: [...authorizedSlugs] };

  const official = [
    ...new Set(
      authorizedSlugs.filter((s): s is string =>
        typeof s === "string" && isCivikoCommercialZoneSlug(s)
      ),
    ),
  ];

  if (official.length === 0) {
    return { civiko: true, ok: false, code: "NO_ZONE_ASSIGNED" };
  }

  const requested = typeof requestedSlug === "string" ? requestedSlug.trim() : "";
  if (requested) {
    if (!isCivikoCommercialZoneSlug(requested)) {
      return { civiko: true, ok: false, code: "SLUG_OUT_OF_CONTRACT" };
    }
    if (!official.includes(requested)) {
      return { civiko: true, ok: false, code: "ZONE_NOT_ASSIGNED" };
    }
    return { civiko: true, ok: true, slugs: [requested] };
  }

  if (official.length > 1) {
    // Nessun full-city implicito: serve una zona esplicita fra le autorizzate.
    return { civiko: true, ok: false, code: "MULTIPLE_ZONES_ASSIGNED" };
  }

  return { civiko: true, ok: true, slugs: [official[0]] };
}

/** Messaggi neutri per il client: nessun dettaglio interno. */
export const CIVIKO_ZONE_GATE_MESSAGES: Readonly<
  Record<CivikoZoneGateErrorCode, string>
> = {
  NO_ZONE_ASSIGNED: "Nessuna zona attiva per questo account.",
  MULTIPLE_ZONES_ASSIGNED: "Seleziona una zona.",
  ZONE_NOT_ASSIGNED: "Zona non disponibile per questo account.",
  SLUG_OUT_OF_CONTRACT: "Zona non riconosciuta.",
};
