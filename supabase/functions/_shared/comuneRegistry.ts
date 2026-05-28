// _shared/comuneRegistry.ts
// Canonical microzone registry per comune. Used to detect when an agency's
// configured zone set effectively covers an ENTIRE comune (e.g. "all Padova")
// versus a strict subset (e.g. "only Arcella").
//
// HARD RULE: this is metadata only. Slugs MUST already correspond to real
// microzones surfaced by Central Core ingestion (civiko_evidence `mz:<comune>:<slug>`).
// Do NOT add fabricated zones.

export const CANONICAL_COMUNE_MICROZONES: Record<string, string[]> = {
  padova: [
    "arcella",
    "brusegana",
    "camin",
    "centro storico",
    "chiesanuova",
    "forcellini",
    "guizza",
    "mandria",
    "mortise",
    "pontevigodarzere",
    "prato della valle",
    "sacra famiglia",
    "sant'osvaldo",
    "stazione",
    "voltabarozzo",
  ],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** True when `configured` covers every canonical microzone of `comune`. */
export function coversFullComune(comune: string, configured: Iterable<string>): boolean {
  const canon = CANONICAL_COMUNE_MICROZONES[norm(comune)];
  if (!canon || canon.length === 0) return false;
  const set = new Set([...configured].map((s) => norm(String(s))));
  return canon.every((mz) => set.has(norm(mz)));
}
