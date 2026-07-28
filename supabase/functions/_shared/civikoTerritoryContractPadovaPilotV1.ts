// Territory Contract — Padova Pilot v1
// ---------------------------------------------------------------------------
// Contratto applicativo del pilot Civiko One su Padova. Autorità di dominio:
// il Central Core. Il client NON è mai autoritativo sulla zona.
//
// - Municipality: Padova (PD, Veneto)
// - Unica zona commerciale riservabile nel pilot v1: `centro-storico`
//   (`pilot_reservable = true`). Le altre 7 zone ufficiali restano nel
//   contratto degli 8 slug ma NON sono riservabili (`pilot_reservable = false`).
// - Le 27 `quartiere_key` sotto sono il perimetro tecnico accettato per
//   `centro-storico`: chiavi normalizzate, alias e composti NON ambigui.
// - Stazione, Stazione Ferroviaria e Scrovegni appartengono a `centro-storico`.
// - Fiera appartiene a `est-brenta` e NON è disponibile nel pilot v1.
// - Le stringhe miste Stazione–Fiera (incluso il composto
//   "stazione scrovegni c so del popolo fiera cittadella") sono AMBIGUE:
//   non sono accettate qui e il resolver deve restituire `null`.
//   Nessun fuzzy matching, nessuno split automatico, nessun fallback su
//   CAP, OMI o prima parola.
// - Fail-closed: qualunque slug diverso da `centro-storico` è respinto
//   server-side nel percorso di prenotazione del pilot.
//
// Il modulo importa SOLO il contratto slug canonico e non tocca DB, OMI,
// CAP, poligoni: coerente col disclaimer di civikoCommercialZoneContract.ts.

import {
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

export const TERRITORY_CONTRACT_PADOVA_PILOT_V1_VERSION = "1.1.0" as const;

export const PADOVA_PILOT_MUNICIPALITY = "padova" as const;
export const PADOVA_PILOT_PROVINCE = "PD" as const;

/** Unico slug riservabile nel pilot v1. */
export const PADOVA_PILOT_ALLOWED_ZONE_SLUG: CivikoCommercialZoneSlug =
  "centro-storico";

/**
 * Perimetro tecnico: 27 quartiere_key non ambigue mappate a `centro-storico`.
 * Ordine alfabetico stabile.
 *
 * Il composto "stazione scrovegni c so del popolo fiera cittadella" è stato
 * RIMOSSO: contiene Fiera (est-brenta) ed è quindi ambiguo → resolver null.
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
  "zona entro riviere via xx settembre",
] as const;

/**
 * Chiavi/etichette miste Stazione–Fiera: sempre ambigue, sempre `null`.
 * Elenco esplicito e chiuso, usato dai test e dalla documentazione.
 */
export const PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS: readonly string[] = [
  "stazione scrovegni c so del popolo fiera cittadella",
  "stazione fiera",
  "fiera stazione",
] as const;

/**
 * Denominazioni utente deduplicate per centro-storico.
 * Raggruppano le chiavi tecniche in etichette mostrabili senza
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
  belongs_to_zone_slug: CivikoCommercialZoneSlug | null;
}> = [
  {
    name: "Fiera",
    reason:
      "Fiera appartiene a est-brenta, zona non riservabile nel pilot v1 (pilot_reservable=false).",
    evidence:
      "civikoCommercialZoneByQuartiere.ts: 'Fiera' è elencata sotto est-brenta e non compare tra i quartieri di centro-storico.",
    belongs_to_zone_slug: "est-brenta",
  },
  {
    name: "Stazione / Fiera (stringhe miste)",
    reason:
      "Etichette che citano insieme Stazione (centro-storico) e Fiera (est-brenta) sono ambigue: fail-closed, nessuna assegnazione automatica.",
    evidence:
      "PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS; il resolver non applica split, fuzzy match, CAP, OMI o prima-parola.",
    belongs_to_zone_slug: null,
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
    ambiguous_keys: PADOVA_PILOT_AMBIGUOUS_STAZIONE_FIERA_KEYS,
    user_labels: PADOVA_PILOT_CENTRO_STORICO_USER_LABELS,
    excluded_areas: PADOVA_PILOT_EXCLUDED_AREAS,
    derivation_rules: {
      authority: "central-core",
      client_authoritative: false,
      derivation_source:
        "civikoCommercialZoneByQuartiere.ts (contratto applicativo 8 zone)",
      fail_closed: true,
    },
  } as const;
}
