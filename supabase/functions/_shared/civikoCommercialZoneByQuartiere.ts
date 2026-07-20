// Civiko — Resolver quartiere → zona commerciale (una delle 8).
//
// Modulo isolato. Non tocca DB, non importa client, non è referenziato
// dagli endpoint di produzione. È solo una mappa autorevole basata sui
// nomi dei quartieri di Padova e sul contratto applicativo delle 8 zone
// definito in ./civikoCommercialZoneContract.ts.
//
// Regole:
// - matching esatto sul valore normalizzato;
// - nessun fuzzy matching, nessuna inferenza testuale;
// - nessun fallback su CAP o codice OMI;
// - fail-closed: ambiguo o sconosciuto → null.

import {
  isCivikoCommercialZoneSlug,
  type CivikoCommercialZoneSlug,
} from "./civikoCommercialZoneContract.ts";

/**
 * Normalizza un nome di quartiere:
 * - lowercase;
 * - rimozione diacritici (NFD + strip combining marks);
 * - apostrofi/punteggiatura → spazio;
 * - collasso di spazi multipli;
 * - trim.
 * Non esegue fuzzy matching e non altera semantica.
 */
export function normalizePadovaQuartiere(value: unknown): string {
  if (typeof value !== "string") return "";
  const lowered = value.toLowerCase();
  const noDiacritics = lowered.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const spaced = noDiacritics.replace(/[’'`´.,;:!?()\[\]{}"“”\-_/\\&]+/g, " ");
  return spaced.replace(/\s+/g, " ").trim();
}

// Mappa autorevole: chiavi già normalizzate, valori solo CivikoCommercialZoneSlug.
// Le voci sono raggruppate per zona per semplicità di manutenzione.
const RAW_QUARTIERI_BY_ZONE: Record<CivikoCommercialZoneSlug, readonly string[]> = {
  "centro-storico": [
    "Centro",
    "Centro Storico",
    "Piazze",
    "Duomo",
    "Santo",
    "Santo - Portello",
    "Portello",
    "Prato della Valle",
    "Savonarola",
    "Stazione",
    "Stazione Ferroviaria",
  ],
  "nord-arcella": [
    "Arcella",
    "Arcella Nord",
    "San Bellino",
    "San Carlo",
    "Pontevigodarzere",
  ],
  "est-brenta": [
    "Fiera",
    "Stanga",
    "San Lazzaro",
    "Mortise",
    "Torre",
    "Ponte di Brenta",
  ],
  "est-forcellini-camin": [
    "Forcellini",
    "Terranegra",
    "Isola di Terranegra",
    "San Gregorio",
    "Camin",
    "Granze",
    "Zona Industriale",
    "ZIP",
    "Interporto",
  ],
  "sud-est-sant-osvaldo": [
    "Città Giardino",
    "Sant'Osvaldo",
    "S. Osvaldo",
    "Santa Rita",
    "S. Rita",
    "Madonna Pellegrina",
    "Santa Croce",
    "San Paolo",
  ],
  "sud-voltabarozzo-guizza": [
    "Voltabarozzo",
    "Crocefisso",
    "SS. Crocefisso",
    "Salboro",
    "Guizza",
    "Bassanello",
  ],
  "sud-ovest-mandria": [
    "Mandria",
    "Armistizio",
    "Voltabrusegana",
    "Paltana",
  ],
  "ovest-chiesanuova-brentelle": [
    "Sacra Famiglia",
    "Palestro",
    "San Giuseppe",
    "Porta Trento",
    "Brusegana",
    "Cave",
    "Chiesanuova",
    "Brentelle",
    "Sant'Ignazio",
    "Montà",
    "Sacro Cuore",
    "Altichiero",
    "Ponterotto",
  ],
};

// Costruisce la mappa normalizzata. In caso di collisione (stessa chiave
// normalizzata assegnata a più zone) lanciamo subito: fail-closed sul contratto.
export const PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE: ReadonlyMap<string, CivikoCommercialZoneSlug> =
  (() => {
    const m = new Map<string, CivikoCommercialZoneSlug>();
    for (const [slug, names] of Object.entries(RAW_QUARTIERI_BY_ZONE) as Array<
      [CivikoCommercialZoneSlug, readonly string[]]
    >) {
      if (!isCivikoCommercialZoneSlug(slug)) {
        throw new Error(`Contract violation: slug non ufficiale "${slug}"`);
      }
      for (const raw of names) {
        const key = normalizePadovaQuartiere(raw);
        if (key.length === 0) {
          throw new Error(`Contract violation: quartiere vuoto per "${slug}"`);
        }
        const existing = m.get(key);
        if (existing && existing !== slug) {
          throw new Error(
            `Contract violation: quartiere "${raw}" assegnato a più zone (${existing}, ${slug})`,
          );
        }
        m.set(key, slug);
      }
    }
    return m;
  })();

/**
 * Restituisce la zona commerciale per un singolo quartiere.
 * Match esatto sul valore normalizzato. Nessun fuzzy, nessuna inferenza.
 * null per input mancante, sconosciuto o non stringa.
 */
export function commercialZoneForQuartiere(value: unknown): CivikoCommercialZoneSlug | null {
  const key = normalizePadovaQuartiere(value);
  if (key.length === 0) return null;
  return PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE.get(key) ?? null;
}

/**
 * Restituisce la zona commerciale per più quartieri già separati dal chiamante.
 * - se anche un solo quartiere non è riconosciuto → null;
 * - se compaiono due zone diverse → null;
 * - altrimenti la zona comune.
 * Fail-closed: array vuoto → null.
 */
export function commercialZoneForQuartiereParts(
  values: readonly unknown[] | null | undefined,
): CivikoCommercialZoneSlug | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  let chosen: CivikoCommercialZoneSlug | null = null;
  for (const v of values) {
    const key = normalizePadovaQuartiere(v);
    if (key.length === 0) return null;
    const slug = PADOVA_QUARTIERE_TO_COMMERCIAL_ZONE.get(key);
    if (!slug) return null;
    if (chosen === null) chosen = slug;
    else if (chosen !== slug) return null;
  }
  return chosen;
}
