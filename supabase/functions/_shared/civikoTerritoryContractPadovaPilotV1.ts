// Territory Contract — Padova Pilot v1
// ---------------------------------------------------------------------------
// Contratto applicativo del pilot Civiko One su Padova. Autorità di dominio:
// il Central Core. Il client NON è mai autoritativo sulla zona.
//
// - Municipality: Padova (PD, Veneto)
// - Unica zona commerciale riservabile nel pilot v1: `centro-storico`.
// - Le 28 `quartiere_key` sotto sono l'insieme ESATTO letto (in sola lettura,
//   il 2026-07-28) da public.civiko_quartiere_commercial_zone_map filtrata
//   per commercial_zone_slug = 'centro-storico'. Rappresentano il perimetro
//   tecnico di derivazione: chiavi normalizzate + alias + composti.
// - Fiera è ESCLUSA: non compare come chiave standalone nel mapping. L'unica
//   occorrenza è dentro l'alias composto "stazione scrovegni c so del popolo
//   fiera cittadella", che descrive la macro-area Stazione, non Fiera.
// - Fail-closed: qualunque slug diverso da `centro-storico` è respinto
//   server-side nel percorso di prenotazione del pilot.
//
// Il modulo importa SOLO il contratto slug canonico e non tocca DB, OMI,
// CAP, poligoni: coerente col disclaimer di civikoCommercialZoneContract.ts.

import {
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

export const TERRITORY_CONTRACT_PADOVA_PILOT_V1_VERSION = "1.0.0" as const;

export const PADOVA_PILOT_MUNICIPALITY = "padova" as const;
export const PADOVA_PILOT_PROVINCE = "PD" as const;

/** Unico slug riservabile nel pilot v1. */
export const PADOVA_PILOT_ALLOWED_ZONE_SLUG: CivikoCommercialZoneSlug =
  "centro-storico";

/**
 * Perimetro tecnico: 28 quartiere_key mappate a `centro-storico` in
 * public.civiko_quartiere_commercial_zone_map (verificato 2026-07-28).
 * Ordine alfabetico stabile; nessun editing manuale senza rilettura DB.
 */
export const PADOVA_PILOT_CENTRO_STORICO_QUARTIERE_KEYS: readonly string[] = [
  "carmine savonarola riviere ext porta san giovanni citta giardino santa giustina santo santa sofia",
  "centro",
  "centro storico",
  "duomo",
  "ferrovia",
  "ospedale militare piazza mazzini porta trento",
  "piazza mazzini ospedale militare",
  "piazze",
  "piazze duomo",
  "portello",
  "portello ognissanti",
  "portello ospedali",
  "prato della valle",
  "prato della valle pontecorvo",
  "prato della valle universitario",
  "riviere",
  "santa sofia altinate",
  "santo",
  "santo portello",
  "savonarola",
  "savonarola ponte molino",
  "scrovegni",
  "specola",
  "specola corso milano",
  "stazione",
  "stazione ferroviaria",
  "stazione scrovegni c so del popolo fiera cittadella",
  "zona entro riviere via xx settembre",
] as const;

/**
 * Denominazioni utente deduplicate per centro-storico.
 * Raggruppano le 28 chiavi tecniche in etichette mostrabili senza
 * proliferazione (nessuna "microzona per chiave").
 */
export const PADOVA_PILOT_CENTRO_STORICO_USER_LABELS: readonly string[] = [
  "Centro Storico",
  "Duomo e Piazze",
  "Prato della Valle",
  "Riviere e Carmine",
  "Santo",
  "Santa Sofia / Altinate",
  "Savonarola",
  "Specola",
  "Portello",
  "Stazione e Scrovegni",
  "Piazza Mazzini / Ospedale Militare",
] as const;

/**
 * Aree escluse dal contratto v1. Ogni voce è documentata: motivazione,
 * evidenza tecnica. NON inserire per supposizione.
 */
export const PADOVA_PILOT_EXCLUDED_AREAS: ReadonlyArray<{
  name: string;
  reason: string;
  evidence: string;
}> = [
  {
    name: "Fiera",
    reason:
      "Non presente come chiave standalone nel mapping ufficiale a centro-storico.",
    evidence:
      "civiko_quartiere_commercial_zone_map: 'fiera' compare SOLO nell'alias composto 'stazione scrovegni c so del popolo fiera cittadella' (macro-area Stazione).",
  },
];

/** Fail-closed: true solo per lo slug pilot. */
export function isPadovaPilotAllowedZoneSlug(
  value: unknown,
): value is typeof PADOVA_PILOT_ALLOWED_ZONE_SLUG {
  return (
    isCivikoCommercialZoneSlug(value) &&
    value === PADOVA_PILOT_ALLOWED_ZONE_SLUG
  );
}

/** Descrittore serializzabile del contratto (per diagnostica/consegna). */
export function describePadovaPilotContract() {
  return {
    contract_version: TERRITORY_CONTRACT_PADOVA_PILOT_V1_VERSION,
    municipality: PADOVA_PILOT_MUNICIPALITY,
    province: PADOVA_PILOT_PROVINCE,
    commercial_zone_slug: PADOVA_PILOT_ALLOWED_ZONE_SLUG,
    commercial_zone_label: "Centro Storico",
    accepted_quartiere_keys: PADOVA_PILOT_CENTRO_STORICO_QUARTIERE_KEYS,
    user_labels: PADOVA_PILOT_CENTRO_STORICO_USER_LABELS,
    excluded_areas: PADOVA_PILOT_EXCLUDED_AREAS,
    derivation_rules: {
      authority: "central-core",
      client_authoritative: false,
      derivation_source:
        "public.civiko_quartiere_commercial_zone_map (letta 2026-07-28)",
      fail_closed: true,
    },
  } as const;
}
