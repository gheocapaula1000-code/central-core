// ═══════════════════════════════════════════════════════════════
// Geoportale Veneto — alias + fuzzy match for comune names.
// Never invents comuni: every alias must resolve to a real key in
// VENETO_COMUNI. Fuzzy match uses normalized Jaro-Winkler-like
// similarity with high threshold (>=0.92).
// ═══════════════════════════════════════════════════════════════

import { VENETO_COMUNI } from "./venetoComuni.ts";

/** Hand-curated abbreviation aliases (only those that resolve to a real Veneto comune). */
const RAW_ALIASES: Record<string, string> = {
  "Domegge di Cad.": "Domegge Di Cadore",
  "S. Vito di Cad.": "San Vito Di Cadore",
  "Santo Stefano di Cad.": "Santo Stefano Di Cadore",
  "S. Pietro di Cad.": "San Pietro Di Cadore",
  "Pieve di Cad.": "Pieve Di Cadore",
  "Vigo di Cad.": "Vigo Di Cadore",
  "Lozzo di Cad.": "Lozzo Di Cadore",
  "Calalzo di Cad.": "Calalzo Di Cadore",
  "Lorenzago di Cad.": "Lorenzago Di Cadore",
  "Valle di Cad.": "Valle Di Cadore",
  "Borca di Cad.": "Borca Di Cadore",
  "Auronzo di Cad.": "Auronzo Di Cadore",
  "S. Donà di Piave": "San Donà Di Piave",
  "S. Dona' di Piave": "San Donà Di Piave",
  "S. Stino di Livenza": "San Stino Di Livenza",
  "S. Martino Buon Albergo": "San Martino Buon Albergo",
  "S. Martino di Lupari": "San Martino Di Lupari",
  "S. Bonifacio": "San Bonifacio",
  "S. Pietro in Cariano": "San Pietro In Cariano",
  "S. Pietro di Morubio": "San Pietro Di Morubio",
  "S. Pietro Viminario": "San Pietro Viminario",
  "S. Giorgio in Bosco": "San Giorgio In Bosco",
  "S. Giorgio delle Pertiche": "San Giorgio Delle Pertiche",
  "S. Zenone degli Ezzelini": "San Zenone Degli Ezzelini",
  "S. Polo di Piave": "San Polo Di Piave",
  "S. Vendemiano": "San Vendemiano",
  "S. Fior": "San Fior",
  "S. Pietro di Feletto": "San Pietro Di Feletto",
  "S. Vito di Leguzzano": "San Vito Di Leguzzano",
  "S. Nazario": "San Nazario",
  "S. Tomaso Agordino": "San Tomaso Agordino",
  "S. Vito di Cadore": "San Vito Di Cadore",
  "S. Stefano di Cadore": "Santo Stefano Di Cadore",
  "S. Pietro di Cadore": "San Pietro Di Cadore",
};

// Build a normalized lookup map (lowercase, no punctuation, no accents)
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normKey(s: string): string {
  return stripAccents(s).toLowerCase().replace(/['’`.]/g, "").replace(/\s+/g, " ").trim();
}

const ALIAS_MAP = new Map<string, string>();
for (const [k, v] of Object.entries(RAW_ALIASES)) {
  if (VENETO_COMUNI[v]) ALIAS_MAP.set(normKey(k), v);
}

// Pre-build normalized index of all real comuni (key=normalized, value=canonical name)
const COMUNE_INDEX = new Map<string, string>();
for (const name of Object.keys(VENETO_COMUNI)) COMUNE_INDEX.set(normKey(name), name);

/** Try alias resolution and rule-based expansion (S. → San/Santo/Santa, Cad. → Cadore). */
export function resolveAlias(raw: string): string | null {
  if (!raw) return null;
  const k = normKey(raw);
  // Direct alias hit
  const direct = ALIAS_MAP.get(k);
  if (direct) return direct;
  // Direct comune index hit (catches accent/punct variants)
  const idx = COMUNE_INDEX.get(k);
  if (idx) return idx;

  // Rule-based expansion
  const expansions = new Set<string>();
  // Cad. → Cadore
  if (/\bcad\b/.test(k)) expansions.add(k.replace(/\bcad\b/g, "cadore"));
  // S. → San / Santo / Santa  (only when at start of token)
  if (/\bs\b/.test(k)) {
    expansions.add(k.replace(/\bs\b/g, "san"));
    expansions.add(k.replace(/\bs\b/g, "santo"));
    expansions.add(k.replace(/\bs\b/g, "santa"));
  }
  // Combined Cad. + S.
  for (const e of [...expansions]) {
    if (/\bcad\b/.test(e)) expansions.add(e.replace(/\bcad\b/g, "cadore"));
  }
  for (const cand of expansions) {
    const hit = COMUNE_INDEX.get(cand);
    if (hit) return hit;
  }
  return null;
}

/** Lightweight similarity: Sørensen–Dice on character bigrams. Stable, dependency-free. */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function dice(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Returns canonical comune if a single match >= threshold and clear margin over runner-up. */
export function fuzzyMatchComune(raw: string, threshold = 0.92): { comune: string; score: number } | null {
  if (!raw) return null;
  const q = normKey(raw);
  if (!q) return null;
  let best: { name: string; score: number } | null = null;
  let second = 0;
  for (const [k, name] of COMUNE_INDEX) {
    const s = dice(q, k);
    if (!best || s > best.score) { second = best ? best.score : 0; best = { name, score: s }; }
    else if (s > second) second = s;
  }
  if (!best) return null;
  if (best.score >= threshold && best.score - second >= 0.05) {
    return { comune: best.name, score: best.score };
  }
  return null;
}

/** Try every textual property → alias → fuzzy. Returns canonical comune + provincia. */
export function inferFromTextProperties(
  properties: Record<string, unknown>,
  opts: { fuzzyThreshold?: number } = {},
): { comune: string; provincia: string; method: "alias" | "fuzzy"; score?: number } | null {
  const candidates = ["comune", "denom_com", "denominazione_comune", "b_nome", "nome", "nome_comune", "comune_nome", "a_nome", "denominazi", "denominazione"];
  const seen = new Set<string>();
  for (const k of Object.keys(properties)) {
    if (!candidates.includes(k.toLowerCase())) continue;
    const v = properties[k];
    if (typeof v !== "string" || !v.trim()) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    const a = resolveAlias(v);
    if (a && VENETO_COMUNI[a]) return { comune: a, provincia: VENETO_COMUNI[a], method: "alias" };
  }
  // Second pass: fuzzy
  for (const k of Object.keys(properties)) {
    if (!candidates.includes(k.toLowerCase())) continue;
    const v = properties[k];
    if (typeof v !== "string" || !v.trim()) continue;
    const f = fuzzyMatchComune(v, opts.fuzzyThreshold ?? 0.92);
    if (f && VENETO_COMUNI[f.comune]) {
      return { comune: f.comune, provincia: VENETO_COMUNI[f.comune], method: "fuzzy", score: f.score };
    }
  }
  return null;
}
