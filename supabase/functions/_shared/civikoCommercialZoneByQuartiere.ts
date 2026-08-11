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
    // Alias semplici già consolidati.
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
    // Alias composti espliciti osservati nei dati.
    "Prato della Valle Universitario",
    "Portello Ognissanti",
    "Piazze Duomo",
    "Savonarola Ponte Molino",
    "Santa Sofia Altinate",
    "Prato della Valle Pontecorvo",
    "Portello Ospedali",
    "Riviere",
    "Ferrovia",
    "Specola",
    "Specola Corso Milano",
    "Piazza Mazzini Ospedale Militare",
    "Scrovegni",
    "Zona entro Riviere via XX Settembre",
  ],
  "nord-arcella": [
    "Arcella",
    "Arcella Nord",
    "San Bellino",
    "San Carlo",
    "Pontevigodarzere",
    "Nord Arcella",
    "Pontevigodarzere Ovest",
    "San Carlo San Bellino",
    "Santissima Trinita",
    "San Bellino San Filippo Neri",
    "Borgomagno Prima Arcella Pescarotto",
    "Arcella Sant Antonino",
    "Sacro Cuore",
    "Altichiero",
    "Altichero",
  ],
  "est-brenta": [
    "Fiera",
    "Stanga",
    "San Lazzaro",
    "Mortise",
    "Torre",
    "Ponte di Brenta",
    "Est Brenta",
    "Stanga Pio X",
    "Ponte di Brenta San Lazzaro",
    // Comparto est / Camin: assorbito da Est - Brenta nel contratto v2.
    "Camin",
    "Camin San Marco",
    "Camin Industriale",
    "Camin Sud",
    "Granze",
    "Interporto",
    "Zona Industriale",
    "ZIP",
    "Zona Industriale ZIP",
  ],
  "nord-est": [
    // Solo Comune di Padova. Esclusi Noventa Padovana e Saonara.
    "Forcellini",
    "Forcellini Est",
    "Terranegra",
    "Isola di Terranegra",
    "San Gregorio",
    "Nord Est",
    "Forcellini Terranegra",
    "S Gregorio Terranegra Forcellini Est",
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
    "Sud Est Sant Osvaldo",
    "Sant Osvaldo Facciolati",
    "Citta Giardino Santa Croce",
    "Madonna Pellegrina S Rita Nazareth Sant Osvaldo",
    "Sant Osvaldo San Paolo",
    "San Camillo Nazareth",
  ],
  "sud-voltabarozzo-guizza": [
    "Voltabarozzo",
    "Crocefisso",
    "Crocifisso",
    "SS. Crocefisso",
    "Salboro",
    "Guizza",
    "Bassanello",
    "Sud Voltabarozzo Guizza",
    "Voltabarozzo Guizza",
    "Bassanello Guizza Voltabarozzo",
    "Sud Guizza Bassanello",
    "Crocifisso Ponte Quattro Martiri",
  ],
  "sud-ovest-mandria": [
    "Mandria",
    "Armistizio",
    "Voltabrusegana",
    "Paltana",
    "Sud Ovest Mandria",
    "Paltana Mandria",
    "Paltana Voltabrusegana Mandria",
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
    "Ponterotto",
    "Ovest Chiesanuova Brentelle",
    "Chiesanuova Brentelle",
    "Brentelle Chiesanuova Cave",
    "San Giuseppe San Giovanni",
    "Palestro Sacra Famiglia San Giuseppe",
    "Sacra Famiglia Basso Isonzo",
    "Chiesanuova Brusegana",
    "Brusegana Aeroporto",
    "Monta Sant Ignazio",
  ],
};

// Costruisce la mappa normalizzata. In caso di collisione (stessa chiave
// normalizzata assegnata a più zone) lanciamo subito: fail-closed sul contratto.
// Inoltre nessuna chiave può citare insieme Stazione (centro-storico) e Fiera
// (est-brenta): le stringhe miste sono ambigue e devono restare non risolte.
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
        const words = key.split(" ");
        // Coppie che attraversano due zone ufficiali: mai auto-assegnabili.
        const CROSS_ZONE_PAIRS: ReadonlyArray<readonly [string, string]> = [
          ["stazione", "fiera"],          // centro-storico / est-brenta
          ["forcellini", "camin"],        // nord-est / est-brenta
          ["pontevigodarzere", "torre"],  // nord-arcella / est-brenta
        ];
        for (const [a, b] of CROSS_ZONE_PAIRS) {
          if (words.includes(a) && words.includes(b)) {
            throw new Error(
              `Contract violation: chiave ambigua ${a}/${b} "${raw}" non è assegnabile`,
            );
          }
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
 * Etichette quartieri mostrabili all'utente, una lista per ciascuno degli 8
 * slug ufficiali. Additive e puramente descrittive: nessun impatto sul
 * matching. "Stazione" compare SOLO in centro-storico, "Fiera" SOLO in
 * est-brenta.
 */
export const PADOVA_QUARTIERI_LABELS_BY_ZONE: Readonly<
  Record<CivikoCommercialZoneSlug, readonly string[]>
> = {
  "centro-storico": [
    "Centro Storico",
    "Duomo e Piazze",
    "Prato della Valle",
    "Riviere e Carmine",
    "Santo",
    "Santa Sofia / Altinate",
    "Savonarola",
    "Specola",
    "Portello",
    "Stazione",
    "Scrovegni",
  ],
  "nord-arcella": [
    "Arcella",
    "San Bellino",
    "San Carlo",
    "Pontevigodarzere",
    "Borgomagno",
    "Sacro Cuore",
    "Altichiero",
  ],
  "est-brenta": [
    "Fiera",
    "Stanga",
    "San Lazzaro",
    "Mortise",
    "Torre",
    "Ponte di Brenta",
    "Camin",
    "Granze",
    "Interporto",
    "Zona Industriale (ZIP)",
  ],
  "nord-est": [
    "Forcellini",
    "Terranegra",
    "San Gregorio",
  ],

  "sud-est-sant-osvaldo": [
    "Città Giardino",
    "Sant'Osvaldo",
    "Santa Rita",
    "Madonna Pellegrina",
    "Santa Croce",
    "San Paolo",
  ],
  "sud-voltabarozzo-guizza": [
    "Voltabarozzo",
    "Crocefisso",
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
    "Brusegana",
    "Chiesanuova",
    "Brentelle",
    "Sant'Ignazio",
    "Montà",
  ],
};


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
