// ═══════════════════════════════════════════════════════════════
// padovaMicrozoneMatcher.ts
// Matcher deterministico Padova → microzona slug (pd::<slug>).
// Hard rule: nessuna invenzione. Se nessuna variante combacia → null.
// L'ordine della lista definisce la priorità: prima match vince.
// ═══════════════════════════════════════════════════════════════

export interface PadovaMicrozoneDef {
  slug: string; // es. "pd::arcella"
  variants: string[]; // tutte lowercase, già normalizzate
}

export const PADOVA_MICROZONE_DEFS: PadovaMicrozoneDef[] = [
  { slug: "pd::arcella",        variants: ["arcella", "pontevigodarzere", "ponte di brenta nord"] },
  { slug: "pd::centro-storico", variants: ["centro storico", "centro", "duomo", "prato della valle", "riviera"] },
  { slug: "pd::nord",           variants: ["nord", "mandria", "brentella", "montà"] },
  { slug: "pd::sud",            variants: ["sud", "torre", "guizza", "bassanello", "voltabarozzo"] },
  { slug: "pd::est",            variants: ["est", "forcellini", "salboro", "san lazzaro", "montà di camin"] },
  { slug: "pd::ovest",          variants: ["ovest", "sarmeola", "rubano", "noventa"] },
  { slug: "pd::stanga",         variants: ["stanga", "camin", "zona industriale est"] },
  { slug: "pd::portello",       variants: ["portello", "fiera", "stazione"] },
  { slug: "pd::albignasego",    variants: ["albignasego", "san giacomo"] },
  { slug: "pd::selvazzano",     variants: ["selvazzano", "tencarola"] },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // re-add accented forms used in variants ("montà") by keeping original lowercased copy below
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Restituisce lo slug della prima microzona Padova che matcha una variante,
 * oppure null se nessuna variante è presente. Confronto con boundary di parola
 * per evitare falsi positivi (es. "test" non deve matchare "est").
 */
export function matchPadovaMicrozona(...parts: Array<string | null | undefined>): string | null {
  const original = parts.filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
  const stripped = normalize(original);
  if (!original) return null;

  for (const def of PADOVA_MICROZONE_DEFS) {
    for (const v of def.variants) {
      const vNorm = normalize(v);
      // Word-boundary match su entrambe le forme (con e senza accenti).
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(vNorm)}(?:$|[^a-z0-9])`, "i");
      if (re.test(stripped) || re.test(original)) return def.slug;
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
