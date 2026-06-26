// _shared/comuneRegistry.ts
// Canonical comune registry. Source of truth for Padova product scope.
//
// HARD RULE (Civiko One / Central Core):
//  - Lo scope vendibile attuale è SOLO Padova Comune.
//  - La granularità ufficiale è la ZONA OMI (Agenzia delle Entrate), non i
//    quartieri amministrativi: usiamo quindi i 22 codici OMI presenti in
//    public.omi_zone per comune_descrizione = 'PADOVA' (semestre 2025/1).
//  - I nomi "umani" (Arcella, Stazione, Forcellini, …) sono solo alias di
//    presentazione: NON collassano più codici OMI in un unico slug.

export type PadovaOmiZone = {
  /** Codice OMI ufficiale (B1, B2, C1…R3). Identificatore stabile. */
  code: string;
  /** Fascia OMI (B/C/D/E/R). */
  fascia: "B" | "C" | "D" | "E" | "R";
  /** Descrizione ufficiale Agenzia Entrate (zona_descr). */
  descrizione: string;
  /** Alias commerciali leggibili. NON usare per dedup. */
  alias: string[];
};

/**
 * 22 zone OMI ufficiali Comune di Padova — fonte: public.omi_zone
 * (comune_descrizione='PADOVA', semestre 2025/1, verificato il 2026-06-26).
 *
 * NON modificare a mano senza prima rieseguire:
 *   SELECT zona, fascia, zona_descr FROM omi_zone
 *    WHERE comune_descrizione='PADOVA' ORDER BY zona;
 */
export const PADOVA_OMI_ZONES: PadovaOmiZone[] = [
  { code: "B1", fascia: "B", descrizione: "ZONA ENTRO RIVIERE-VIA XX SETTEMBRE", alias: ["Centro Storico", "Riviere", "XX Settembre"] },
  { code: "B2", fascia: "B", descrizione: "CARMINE,SAVONAROLA,RIVIERE EXT.,PORTA SAN GIOVANNI,CITTA GIARDINO,SANTA GIUSTINA,SANTO,SANTA SOFIA", alias: ["Carmine", "Savonarola", "Città Giardino", "Santa Giustina", "Santo", "Santa Sofia", "Porta San Giovanni"] },
  { code: "C1", fascia: "C", descrizione: "PORTELLO", alias: ["Portello"] },
  { code: "C2", fascia: "C", descrizione: "STAZIONE,SCROVEGNI,C.SO DEL POPOLO,FIERA, CITTADELLA", alias: ["Stazione", "Scrovegni", "Corso del Popolo", "Fiera", "Cittadella"] },
  { code: "C3", fascia: "C", descrizione: "BORGOMAGNO, PRIMA ARCELLA, PESCAROTTO", alias: ["Borgomagno", "Prima Arcella", "Arcella Sud", "Pescarotto"] },
  { code: "C4", fascia: "C", descrizione: "ZONA DIREZIONALE PADOVAUNO", alias: ["PadovaUno", "Zona Direzionale"] },
  { code: "C5", fascia: "C", descrizione: "MADONNA PELLEGRINA, S.RITA, NAZARETH,SANT`OSVALDO", alias: ["Madonna Pellegrina", "Santa Rita", "Nazareth", "Sant'Osvaldo"] },
  { code: "C6", fascia: "C", descrizione: "PALESTRO, SACRA FAMIGLIA, SAN GIUSEPPE", alias: ["Palestro", "Sacra Famiglia", "San Giuseppe"] },
  { code: "D1", fascia: "D", descrizione: "CHIESANUOVA,BRUSEGANA", alias: ["Chiesanuova", "Brusegana"] },
  { code: "D2", fascia: "D", descrizione: "PALTANA, VOLTABRUSEGANA, MANDRIA", alias: ["Paltana", "Voltabrusegana", "Mandria"] },
  { code: "D3", fascia: "D", descrizione: "BASSANELLO, GUIZZA, VOLTABAROZZO", alias: ["Bassanello", "Guizza", "Voltabarozzo"] },
  { code: "D4", fascia: "D", descrizione: "PONTE DI BRENTA, SAN LAZZARO", alias: ["Ponte di Brenta", "San Lazzaro"] },
  { code: "D5", fascia: "D", descrizione: "S. IGNAZIO, MONTA`, ALTICHIERO", alias: ["Sant'Ignazio", "Montà", "Altichiero"] },
  { code: "D6", fascia: "D", descrizione: "TORRE, PONTEVIGODARZERE, SACRO CUORE", alias: ["Torre", "Pontevigodarzere", "Sacro Cuore"] },
  { code: "D7", fascia: "D", descrizione: "ARCELLA NORD, MORTISE", alias: ["Arcella Nord", "Arcella", "Mortise"] },
  { code: "D8", fascia: "D", descrizione: "S. GREGORIO, TERRANEGRA, FORCELLINI EST", alias: ["San Gregorio", "Terranegra", "Forcellini Est", "Forcellini"] },
  { code: "E1", fascia: "E", descrizione: "CAMIN", alias: ["Camin"] },
  { code: "E2", fascia: "E", descrizione: "ZONA INDUSTRIALE,ZIP", alias: ["Zona Industriale", "ZIP"] },
  { code: "E3", fascia: "E", descrizione: "SALBORO", alias: ["Salboro"] },
  { code: "R1", fascia: "R", descrizione: "ZONA RURALE COMPRENDE QUARTIERE PONTEROTTO", alias: ["Ponterotto", "Rurale R1"] },
  { code: "R2", fascia: "R", descrizione: "ZONA RURALE", alias: ["Rurale R2"] },
  { code: "R3", fascia: "R", descrizione: "ZONA RURALE", alias: ["Rurale R3"] },
];

/** Scope canonico Civiko One / Central Core: solo Padova Comune, 22 zone OMI. */
export const CIVIKO_PADOVA_SCOPE = {
  scope: "padova_omi_zones" as const,
  province: ["PD"] as const,
  municipality: "Padova" as const,
  comuni: ["Padova"] as const,
  omi_zones_expected: PADOVA_OMI_ZONES.length, // 22
  omi_zone_codes: PADOVA_OMI_ZONES.map((z) => z.code),
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** True se il comune passato corrisponde a Padova (case/whitespace insensitive). */
export function isPadovaComune(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return norm(value) === "padova";
}

/** True se il codice OMI appartiene alle 22 zone ufficiali Padova. */
export function isValidPadovaOmiZone(code: unknown): boolean {
  if (typeof code !== "string") return false;
  const c = code.trim().toUpperCase();
  return CIVIKO_PADOVA_SCOPE.omi_zone_codes.includes(c);
}

/** Risolve un alias leggibile → codice OMI canonico (o null se non riconosciuto). */
export function resolvePadovaOmiByAlias(alias: string): string | null {
  if (!alias) return null;
  const target = norm(alias);
  for (const z of PADOVA_OMI_ZONES) {
    if (z.alias.some((a) => norm(a) === target)) return z.code;
  }
  return null;
}

// ─── Retro-compat (deprecato) ───────────────────────────────────────────────
// Mantenuto SOLO per non rompere import esistenti; rimuovere quando i
// chiamanti saranno migrati a CIVIKO_PADOVA_SCOPE / PADOVA_OMI_ZONES.
export const CANONICAL_COMUNE_MICROZONES: Record<string, string[]> = {
  padova: PADOVA_OMI_ZONES.map((z) => z.code.toLowerCase()),
};

/** @deprecated usare isValidPadovaOmiZone / PADOVA_OMI_ZONES. */
export function coversFullComune(comune: string, configured: Iterable<string>): boolean {
  if (!isPadovaComune(comune)) return false;
  const set = new Set([...configured].map((s) => norm(String(s))));
  return PADOVA_OMI_ZONES.every((z) => set.has(z.code.toLowerCase()));
}
