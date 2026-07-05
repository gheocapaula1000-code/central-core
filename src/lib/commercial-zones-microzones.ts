export const COMMERCIAL_ZONE_MICROZONES: Record<string, string[]> = {
  "centro-storico": ["Centro Storico"],
  "prato-della-valle-universitario": ["Prato della Valle", "Universitario"],
  "arcella-nord": ["Arcella nord"],
  "sacra-famiglia-palestro": ["Sacra Famiglia", "Palestro"],
  "chiesanuova-brentelle": ["Chiesanuova", "Brentelle"],
  "voltabarozzo-guizza": ["Voltabarozzo", "Guizza"],
  "sant-osvaldo-facciolati": ["Sant'Osvaldo", "Facciolati"],
  "portello-ognissanti": ["Portello", "Ognissanti"],
  "stazione-fiera": ["Stazione", "Fiera"],
  "stanga-pio-x": ["Stanga", "Pio X"],
  "mandria-savonarola": ["Mandria", "Savonarola"],
  "camin-san-marco": ["Camin", "San Marco"],
  "pontevigodarzere-ovest": ["Pontevigodarzere ovest"],
  "mortise-arcella-est": ["Mortise", "Arcella est"],
};

export function getCommercialZoneMicrozones(slug: string): string[] {
  return COMMERCIAL_ZONE_MICROZONES[slug] ?? [];
}
