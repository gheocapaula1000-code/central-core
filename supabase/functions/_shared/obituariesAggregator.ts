// ═══════════════════════════════════════════════════════════════
// obituariesAggregator.ts — parser stateless PII-free.
//
// Contratto rigido:
//   input  = markdown grezzo di una pagina indice necrologi + source_code
//   output = Map<CAP, count> (solo aggregati numerici per CAP PD)
//
// GARANZIE:
//   - Non ritorna mai il markdown né stringhe individuali.
//   - Non chiama mai console.log/error sul markdown o su token estratti.
//   - Se il testo contiene solo pattern nominativi (nome+cognome) senza
//     località riconducibile a un CAP PD, il record è scartato silenziosamente.
//   - Il markdown esce di scope al ritorno della funzione.
// ═══════════════════════════════════════════════════════════════

import { comuneToCap, extractPadovaCap, isPadovaCap, findAnyPadovaComuneCap } from "./capResolver.ts";

export interface AggregatorInput {
  /** Markdown della pagina indice/listing (NON del singolo necrologio). */
  markdown: string;
  /** Codice sorgente registry (es. "necrologie_it", "gazzettino", "lutto_it"). */
  source_code: string;
  /** Finestra temporale del bucket (giorni). Default 90. */
  window_days?: number;
}

export interface AggregatorBucket {
  area_type: "cap";
  area_code: string;
  window_days: number;
  bucket_count: number;
  source_code: string;
}

export interface AggregatorResult {
  buckets: AggregatorBucket[];
  /** Solo contatori — nessuna stringa raw. */
  stats: {
    entries_scanned: number;
    entries_with_cap: number;
    entries_with_comune: number;
    entries_dropped_no_area: number;
    unique_caps: number;
  };
}

// Segmentazione permissiva: gli indici necrologi variano molto per fonte.
// Splittiamo su: doppia newline, "---", bullet markdown (- / *), headings, o "Necrologio di".
// Manteniamo blocchi 20..2000 char.
function segmentEntries(markdown: string): string[] {
  if (!markdown || markdown.length < 20) return [];
  const normalized = markdown
    // Trasforma link markdown "[Necrologio di X](...)" in delimitatori riconoscibili
    .replace(/\[\s*Necrologio di\s+/gi, "\n\n@@ENTRY@@ Necrologio di ")
    // Bullet items markdown come delimitatori
    .replace(/\n[\-\*\+]\s+/g, "\n\n@@ENTRY@@ ");
  const blocks = normalized
    .split(/(?:\n\s*\n|\n---+\n|\n\*\*\*+\n|@@ENTRY@@)/g)
    .map((b) => b.trim())
    .filter((b) => b.length > 15 && b.length < 3000);
  return blocks;
}

// Marker che indicano che un blocco è verosimilmente un necrologio.
// Ampliati per coprire i listing "Necrologio di X, città" senza "anni".
const OBITUARY_MARKERS = [
  /\bnecrologio di\b/i,
  /\banni\s+\d{1,3}\b/i,
  /\bdi\s+anni\s+\d{1,3}\b/i,
  /\bnat[oa]\s+(?:il\s+)?\d/i,
  /\b(?:deceduto|deceduta|scomparso|scomparsa|mancato|mancata)\b/i,
  /\b(?:funerale|funerali|esequie|rosario|commemora)/i,
  // Date DD/MM/YYYY presenti in card di listing gelocal-family
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
];

function looksLikeObituary(block: string): boolean {
  for (const re of OBITUARY_MARKERS) {
    if (re.test(block)) return true;
  }
  return false;
}

// Estrae il CAP di riferimento del blocco (SENZA persisterlo).
// Priorità: 1) CAP esplicito, 2) pattern "residente/deceduto a X",
// 3) qualunque comune PD menzionato nel blocco.
const COMUNE_HINT_RE =
  /(?:residente\s+(?:a|in)|deceduto\s+a|deceduta\s+a|scomparso\s+a|scomparsa\s+a|abitava\s+a|di\s+)\s*([A-ZÀ-Ù][a-zà-ù' -]{2,40})/;

function extractAreaFromBlock(block: string): string | null {
  const cap = extractPadovaCap(block);
  if (cap) return cap;
  const m = block.match(COMUNE_HINT_RE);
  if (m && m[1]) {
    const c = comuneToCap(m[1]);
    if (c) return c;
  }
  // Fallback ampio: qualunque comune PD nel testo
  return findAnyPadovaComuneCap(block);
}

/**
 * Aggrega un markdown in bucket per CAP PD.
 * Solo contatori numerici escono dalla funzione.
 * Il markdown NON viene mai loggato, ritornato o memoizzato oltre lo scope.
 */
export function aggregateObituariesMarkdown(input: AggregatorInput): AggregatorResult {
  const windowDays = input.window_days ?? 90;
  const md = input.markdown ?? "";
  const source_code = input.source_code;

  const blocks = segmentEntries(md);
  const capCounts = new Map<string, number>();

  let entries_scanned = 0;
  let entries_with_cap = 0;
  let entries_with_comune = 0;
  let entries_dropped_no_area = 0;

  for (const block of blocks) {
    if (!looksLikeObituary(block)) continue;
    entries_scanned++;

    // CAP esplicito ha priorità.
    const explicitCap = extractPadovaCap(block);
    if (explicitCap) {
      entries_with_cap++;
      capCounts.set(explicitCap, (capCounts.get(explicitCap) ?? 0) + 1);
      continue;
    }
    // Fallback comune → CAP
    const area = extractAreaFromBlock(block);
    if (area && isPadovaCap(area)) {
      entries_with_comune++;
      capCounts.set(area, (capCounts.get(area) ?? 0) + 1);
      continue;
    }
    entries_dropped_no_area++;
  }

  const buckets: AggregatorBucket[] = [];
  for (const [area_code, bucket_count] of capCounts.entries()) {
    buckets.push({
      area_type: "cap",
      area_code,
      window_days: windowDays,
      bucket_count,
      source_code,
    });
  }

  return {
    buckets,
    stats: {
      entries_scanned,
      entries_with_cap,
      entries_with_comune,
      entries_dropped_no_area,
      unique_caps: capCounts.size,
    },
  };
}

/**
 * Merge di più aggregazioni (multi-source) sommando i count per CAP.
 * Restituisce un unico bucket per CAP con source_code = CSV delle fonti contribuenti.
 */
export function mergeAggregations(results: AggregatorBucket[][]): AggregatorBucket[] {
  const byCap = new Map<string, { count: number; sources: Set<string>; window_days: number }>();
  for (const arr of results) {
    for (const b of arr) {
      const cur = byCap.get(b.area_code) ?? { count: 0, sources: new Set(), window_days: b.window_days };
      cur.count += b.bucket_count;
      cur.sources.add(b.source_code);
      byCap.set(b.area_code, cur);
    }
  }
  const out: AggregatorBucket[] = [];
  for (const [area_code, v] of byCap.entries()) {
    out.push({
      area_type: "cap",
      area_code,
      window_days: v.window_days,
      bucket_count: v.count,
      source_code: [...v.sources].sort().join(","),
    });
  }
  return out;
}
