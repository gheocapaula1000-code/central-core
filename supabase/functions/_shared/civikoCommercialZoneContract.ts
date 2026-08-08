// Civiko Commercial Zone Contract — fonte di verità applicativa (v2).
//
// Fonte: Comune di Padova, "Le Consulte di Quartiere".
// URL:   https://www.comune.padova.it/le-consulte-di-quartiere
// Data di verifica: 2026-08-08
// Nota:  le 8 zone commerciali sono un raggruppamento applicativo delle
//        Consulte comunali di Padova. NON coincidono con le zone OMI
//        dell'Agenzia delle Entrate e non usano codici OMI, CAP,
//        alias di quartiere o poligoni.
//
// v2 (definitivo): la zona legacy "est-forcellini-camin" è rimossa.
//   - Est - Brenta assorbe Camin, ZIP/Zona Industriale, Interporto, Granze
//     oltre a Mortise, Torre, Ponte di Brenta, San Lazzaro, Fiera.
//   - Nord-Est (nuova) copre SOLO il Comune di Padova: Forcellini,
//     Terranegra, San Gregorio. Esclusi Noventa Padovana e Saonara.
//   - Stazione resta in Centro Storico.
//
// Questo modulo è isolato: non importa nulla, non tocca DB, non è
// referenziato dagli endpoint di produzione. È solo il contratto.

export const CIVIKO_COMMERCIAL_ZONES = [
  { slug: "centro-storico",              nome: "Centro Storico",                 consulte: ["1"] },
  { slug: "nord-arcella",                nome: "Nord - Arcella",                 consulte: ["2"] },
  { slug: "est-brenta",                  nome: "Est - Brenta",                   consulte: ["3A"] },
  { slug: "nord-est",                    nome: "Nord-Est",                       consulte: ["3B"] },
  { slug: "sud-est-sant-osvaldo",        nome: "Sud-Est - Sant'Osvaldo",         consulte: ["4A"] },
  { slug: "sud-voltabarozzo-guizza",     nome: "Sud - Voltabarozzo / Guizza",    consulte: ["4B"] },
  { slug: "sud-ovest-mandria",           nome: "Sud-Ovest - Mandria",            consulte: ["5A"] },
  { slug: "ovest-chiesanuova-brentelle", nome: "Ovest - Chiesanuova / Brentelle", consulte: ["5B", "6A", "6B"] },
] as const;

export type CivikoCommercialZone = typeof CIVIKO_COMMERCIAL_ZONES[number];
export type CivikoCommercialZoneSlug = CivikoCommercialZone["slug"];

export type CivikoConsultaCode =
  | "1" | "2" | "3A" | "3B" | "4A" | "4B" | "5A" | "5B" | "6A" | "6B";


export const CIVIKO_COMMERCIAL_ZONE_SLUGS: ReadonlySet<CivikoCommercialZoneSlug> =
  new Set(CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug));

// Mapping derivato programmaticamente. In caso di consulta duplicata tra
// più zone (violazione del contratto) lanciamo subito: fail-closed.
export const CONSULTA_TO_COMMERCIAL_ZONE: ReadonlyMap<CivikoConsultaCode, CivikoCommercialZoneSlug> =
  (() => {
    const m = new Map<CivikoConsultaCode, CivikoCommercialZoneSlug>();
    for (const z of CIVIKO_COMMERCIAL_ZONES) {
      for (const c of z.consulte) {
        if (m.has(c as CivikoConsultaCode)) {
          throw new Error(`Contract violation: consulta ${c} assigned to multiple zones`);
        }
        m.set(c as CivikoConsultaCode, z.slug);
      }
    }
    return m;
  })();

export function isCivikoCommercialZoneSlug(value: unknown): value is CivikoCommercialZoneSlug {
  return typeof value === "string" && (CIVIKO_COMMERCIAL_ZONE_SLUGS as ReadonlySet<string>).has(value);
}

export function commercialZoneForConsulta(value: unknown): CivikoCommercialZoneSlug | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return CONSULTA_TO_COMMERCIAL_ZONE.get(value as CivikoConsultaCode) ?? null;
}
