// ═══════════════════════════════════════════════════════════════
// Geoportale Veneto — alias + fuzzy match for comune names.
// Never invents comuni: every alias must resolve to a real key in
// VENETO_COMUNI. Fuzzy match uses normalized Sørensen-Dice with
// high threshold (>=0.92) and clear runner-up margin.
// ═══════════════════════════════════════════════════════════════

import { VENETO_COMUNI } from "./venetoComuni.ts";

/** Hand-curated abbreviation aliases (only those that resolve to a real Veneto comune). */
const RAW_ALIASES: Record<string, string> = {
  // ── BL Cadore ──
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
  "Cibiana di Cad.": "Cibiana Di Cadore",
  // ── VE / PD San* abbreviations ──
  "S. Donà di Piave": "San Donà Di Piave",
  "S. Dona' di Piave": "San Donà Di Piave",
  "S. Stino di Livenza": "San Stino Di Livenza",
  "S. Martino Buon Albergo": "San Martino Buon Albergo",
  "S. Martino B.A.": "San Martino Buon Albergo",
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
  "S. Giovanni Ilarione": "San Giovanni Ilarione",
  "S. Biagio di Callalta": "San Biagio Di Callalta",
  "S. Zeno di M.": "San Zeno Di Montagna",
  "S. Zeno di Montagna": "San Zeno Di Montagna",
  // ── VR abbreviazioni / suffissi ──
  "Brenzone": "Brenzone Sul Garda",
  "Brenzone s/Garda": "Brenzone Sul Garda",
  "Cavaion Ver.": "Cavaion Veronese",
  "Cavaion": "Cavaion Veronese",
  "Costermano": "Costermano Sul Garda",
  "Roverè Ver.": "Roverè Veronese",
  "Rovere Veronese": "Roverè Veronese",
  "Rovere Ver.": "Roverè Veronese",
  "Albaredo d Adige": "Albaredo d'Adige",
  "Boschi Sant Anna": "Boschi Sant'Anna",
  "Montecchia di C.": "Montecchia Di Crosara",
  "Cazzano di T.": "Cazzano Di Tramigna",
  "Brentino B.": "Brentino Belluno",
  "Ferrara di M. B.": "Ferrara Di Monte Baldo",
  "Ferrara M. B.": "Ferrara Di Monte Baldo",
  // ── VI ──
  "Montecchio M.": "Montecchio Maggiore",
  "Bassano": "Bassano Del Grappa",
  "Romano d Ezzelino": "Romano d'Ezzelino",
  "Recoaro T.": "Recoaro Terme",
  // ── TV ──
  "Vittorio V.": "Vittorio Veneto",
  "Castelfranco V.": "Castelfranco Veneto",
  "Mogliano V.": "Mogliano Veneto",
  // ── RO ──
  "Badia P.": "Badia Polesine",
};

// ── normalization ────────────────────────────────────────────────
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
/** Normalize: lowercase, strip accents, normalize apostrophes (’`´→'),
 * collapse spaces, drop punctuation. */
function normKey(s: string): string {
  return stripAccents(
    s.replace(/[\u2018\u2019\u201B\u0060\u00B4]/g, "'"),
  )
    .toLowerCase()
    .replace(/['.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ALIAS_MAP = new Map<string, string>();
for (const [k, v] of Object.entries(RAW_ALIASES)) {
  if (VENETO_COMUNI[v]) ALIAS_MAP.set(normKey(k), v);
}

const COMUNE_INDEX = new Map<string, string>();
for (const name of Object.keys(VENETO_COMUNI)) COMUNE_INDEX.set(normKey(name), name);

// Suffix candidates appended only when produces a unique match.
const SUFFIX_CANDIDATES = [
  "sul garda", "sull adige", "d adige", "del grappa",
  "veronese", "veneto", "vicentino", "terme", "polesine",
  "di cadore", "di piave", "di livenza", "di tramigna",
  "di crosara", "di montagna", "di monte baldo",
];

const ABBREV_EXPANSIONS: Array<[RegExp, string]> = [
  [/\bcad\b/g, "cadore"],
  [/\bver\b/g, "veronese"],
  [/\bm b\b/g, "monte baldo"],
  [/\bb a\b/g, "buon albergo"],
];

/** Try alias → direct → rule-based expansion → suffix probing.
 * Only returns matches that resolve to a real key in VENETO_COMUNI. */
export function resolveAlias(raw: string): string | null {
  if (!raw) return null;
  const k = normKey(raw);
  if (!k) return null;

  // 1. Direct alias
  const direct = ALIAS_MAP.get(k);
  if (direct) return direct;

  // 2. Direct comune index
  const idx = COMUNE_INDEX.get(k);
  if (idx) return idx;

  // 3. Rule-based expansion of abbreviations
  const expansions = new Set<string>([k]);
  for (const e of [...expansions]) {
    let mutated = e;
    for (const [re, repl] of ABBREV_EXPANSIONS) mutated = mutated.replace(re, repl);
    if (mutated !== e) expansions.add(mutated);
  }
  // 3.b S. → San / Santa / Santo
  for (const e of [...expansions]) {
    if (/\bs\b/.test(e)) {
      expansions.add(e.replace(/\bs\b/g, "san"));
      expansions.add(e.replace(/\bs\b/g, "santo"));
      expansions.add(e.replace(/\bs\b/g, "santa"));
    }
  }
  for (const cand of expansions) {
    const hit = COMUNE_INDEX.get(cand);
    if (hit) return hit;
  }

  // 4. Suffix probing: append common suffixes; require UNIQUE match
  const baseCandidates = [...expansions];
  for (const base of baseCandidates) {
    const matches = new Set<string>();
    for (const suf of SUFFIX_CANDIDATES) {
      const probe = `${base} ${suf}`;
      const hit = COMUNE_INDEX.get(probe);
      if (hit) matches.add(hit);
    }
    if (matches.size === 1) return [...matches][0];
    // ambiguous → skip
  }

  return null;
}

// ── fuzzy ─────────────────────────────────────────────────────────
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

const TEXT_PROP_KEYS = ["comune", "denom_com", "denominazione_comune", "b_nome", "nome", "name", "nome_comune", "comune_nome", "a_nome", "denominazi", "denominazione", "municipio"];

/** Returns true if the feature has any textual comune-like property
 * (regardless of whether it resolves). Used to gate PIP. */
export function hasTextualComuneProperty(properties: Record<string, unknown>): boolean {
  for (const k of Object.keys(properties)) {
    if (!TEXT_PROP_KEYS.includes(k.toLowerCase())) continue;
    const v = properties[k];
    if (typeof v === "string" && v.trim().length >= 2) return true;
  }
  return false;
}

/** Try every textual property → alias/expansion → fuzzy.
 * Returns canonical comune + provincia, or null. */
export function inferFromTextProperties(
  properties: Record<string, unknown>,
  opts: { fuzzyThreshold?: number } = {},
): { comune: string; provincia: string; method: "alias" | "fuzzy"; score?: number } | null {
  const seen = new Set<string>();
  // pass 1: alias / direct / expansion / suffix
  for (const k of Object.keys(properties)) {
    if (!TEXT_PROP_KEYS.includes(k.toLowerCase())) continue;
    const v = properties[k];
    if (typeof v !== "string" || !v.trim()) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    const a = resolveAlias(v);
    if (a && VENETO_COMUNI[a]) return { comune: a, provincia: VENETO_COMUNI[a], method: "alias" };
  }
  // pass 2: fuzzy
  for (const k of Object.keys(properties)) {
    if (!TEXT_PROP_KEYS.includes(k.toLowerCase())) continue;
    const v = properties[k];
    if (typeof v !== "string" || !v.trim()) continue;
    const f = fuzzyMatchComune(v, opts.fuzzyThreshold ?? 0.92);
    if (f && VENETO_COMUNI[f.comune]) {
      return { comune: f.comune, provincia: VENETO_COMUNI[f.comune], method: "fuzzy", score: f.score };
    }
  }
  return null;
}
