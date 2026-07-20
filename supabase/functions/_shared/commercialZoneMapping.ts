// _shared/commercialZoneMapping.ts
//
// Writer runtime della classificazione commerciale Padova, allineato al
// contratto ufficiale delle 8 zone basate esclusivamente sui quartieri.
//
// Regole di produzione di `commercial_zone_slug`:
//   - unica fonte: il campo `quartiere` del record;
//   - risoluzione via commercialZoneForQuartiere() (match esatto,
//     normalizzato, definito in civikoCommercialZoneByQuartiere.ts);
//   - quartiere assente / vuoto / sconosciuto / ambiguo / indirizzo → null;
//   - MAI derivato da CAP, codice OMI, descrizione OMI, coordinate,
//     similarità fuzzy, includes/startsWith, split automatici o fallback
//     legacy;
//   - il codice OMI resta un metadato separato per i consumatori: qui
//     non viene usato per assegnare la zona commerciale.
//
// API pubbliche preservate per compatibilità con i chiamanti runtime
// (padova-contendibili-list, core-offmarket-list-public,
// civiko-one-signals-feed). La firma di ogni funzione esportata è
// identica alla versione precedente; cambia solo la semantica interna.

import {
  CIVIKO_COMMERCIAL_ZONE_SLUGS,
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";
import { commercialZoneForQuartiere } from "./civikoCommercialZoneByQuartiere.ts";

// I nuovi 8 slug ufficiali. Esposto come readonly tuple per mantenere
// la firma `readonly string[]` attesa dai chiamanti.
export const VALID_COMMERCIAL_ZONE_SLUGS = [
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "est-forcellini-camin",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
] as const;

export type CommercialZoneSlug = CivikoCommercialZoneSlug;

const VALID_SET: ReadonlySet<string> = CIVIKO_COMMERCIAL_ZONE_SLUGS as ReadonlySet<string>;

export function isValidCommercialZoneSlug(s: unknown): s is CommercialZoneSlug {
  return typeof s === "string" && VALID_SET.has(s);
}

// Preservato per compatibilità di firma con i chiamanti.
export type ActiveZoneRow = { slug: string; omi_codes: string[] };

/**
 * Preservata per compatibilità di firma. Il contratto attuale vieta l'uso
 * dei codici OMI come sorgente della zona commerciale: la mappa restituita
 * è sempre vuota. I chiamanti che iterano su di essa non troveranno match
 * (comportamento voluto: quartiere-only).
 */
export function buildOmiToSlugMap(_rows: ActiveZoneRow[]): Map<string, CommercialZoneSlug> {
  return new Map();
}

export type ZoneAssignment = {
  commercial_zone_slug: CommercialZoneSlug | null;
  // "existing_slug" | "quartiere_match" | "unresolved"
  zone_match_method: string;
  zone_match_confidence: number | null;
};

const UNRESOLVED: ZoneAssignment = {
  commercial_zone_slug: null,
  zone_match_method: "unresolved",
  zone_match_confidence: null,
};

/** True iff lat/lng are numbers, finite and not both 0. Preservata per
 *  compatibilità: NON viene più usata internamente per produrre slug. */
export function hasValidCoords(lat: unknown, lng: unknown): boolean {
  const la = Number(lat);
  const lo = Number(lng);
  return Number.isFinite(la) && Number.isFinite(lo) && (la !== 0 || lo !== 0);
}

// Risoluzione quartiere → slug ufficiale. Unica strada verso lo slug.
function assignFromQuartiere(record: Record<string, unknown>): ZoneAssignment {
  const slug = commercialZoneForQuartiere(record["quartiere"]);
  if (!slug) return UNRESOLVED;
  return {
    commercial_zone_slug: slug,
    zone_match_method: "quartiere_match",
    zone_match_confidence: 0.95,
  };
}

/**
 * Fast path (a): accetta uno slug già presente sul record SOLO se rientra
 * nei nuovi 8 slug ufficiali. Il codice OMI eventualmente presente sul
 * record NON viene più mappato a uno slug commerciale (contratto
 * quartiere-only): in quel caso ritorna null e la risoluzione prosegue.
 */
export function tryExistingSlugOrOmi(
  record: Record<string, unknown>,
  _omiToSlug: Map<string, CommercialZoneSlug>,
): ZoneAssignment | null {
  const existingSlug = record["commercial_zone_slug"];
  if (isValidCommercialZoneSlug(existingSlug)) {
    return {
      commercial_zone_slug: existingSlug,
      zone_match_method: "existing_slug",
      zone_match_confidence: 0.99,
    };
  }
  return null;
}

/**
 * Preservata per compatibilità di firma. Il contratto attuale vieta l'uso
 * di risoluzioni OMI (PIP, precomputed, alias OMI, CAP hint, ecc.) come
 * sorgente della zona commerciale: ritorna sempre UNRESOLVED.
 */
export function assignFromResolution(
  _res: unknown,
  _omiToSlug: Map<string, CommercialZoneSlug>,
): ZoneAssignment {
  return UNRESOLVED;
}

/**
 * Assegnazione basata sul quartiere del record. Il nome storico è
 * mantenuto per compatibilità con i chiamanti; l'unico input consultato
 * è il campo `quartiere`.
 */
export function assignFromAliasOnly(
  record: Record<string, unknown>,
  _omiToSlug: Map<string, CommercialZoneSlug>,
): ZoneAssignment {
  return assignFromQuartiere(record);
}

/**
 * Assegnatore batch. Ordine di risoluzione:
 *   a) `commercial_zone_slug` già presente e ∈ 8 nuovi slug ufficiali;
 *   b) risoluzione dal campo `quartiere` via commercialZoneForQuartiere.
 * Nessun altro ingresso è consultato. Nessun uso di OMI, CAP, coord.,
 * fuzzy, includes/startsWith, split o fallback legacy.
 * Il parametro `supa` è preservato per compatibilità e ignorato.
 */
export async function assignCommercialZonesBatch(
  records: Array<Record<string, unknown>>,
  omiToSlug: Map<string, CommercialZoneSlug>,
  _supa: unknown,
): Promise<ZoneAssignment[]> {
  const out: ZoneAssignment[] = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? {};
    const fast = tryExistingSlugOrOmi(r, omiToSlug);
    out[i] = fast ?? assignFromQuartiere(r);
  }
  return out;
}
