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

import { comuneToCap, extractPadovaCap, isPadovaCap } from "./capResolver.ts";

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

// Delimitatori tipici di una entry necrologio nel markdown:
// linee vuote, separatori "---", o pattern "Nome COGNOME" all'inizio riga.
// Non parsiamo il nome — segmentiamo solo il testo in "entries" per il conteggio.
function segmentEntries(markdown: string): string[] {
  if (!markdown || markdown.length < 20) return [];
  // Segmentazione conservativa: blocchi separati da 2+ newline o "---"
  const blocks = markdown
    .split(/(?:\n\s*\n|\n---+\n|\n\*\*\*+\n)/g)
    .map((b) => b.trim())
    .filter((b) => b.length > 10 && b.length < 2000);
  return blocks;
}

// Pattern per riconoscere che un blocco è effettivamente un necrologio
// (evita di contare menu, footer, sidebar).
const OBITUARY_MARKERS = [
  /\b(anni?\s+\d{1,3})\b/i,           // "anni 87"
  /\b(di\s+anni\s+\d{1,3})\b/i,       // "di anni 87"
  /\b(nat[oa]\s+(?:il\s+)?\d)/i,      // "nato il 12"
  /\b(deceduto|deceduta|scomparso|scomparsa|mancato|mancata)\b/i,
  /\b(funerale|funerali|esequie|rosario)\b/i,
];

function looksLikeObituary(block: string): boolean {
  let hits = 0;
  for (const re of OBITUARY_MARKERS) {
    if (re.test(block)) hits++;
    if (hits >= 1) return true;
  }
  return false;
}

// Estrae il nome del comune da un blocco necrologio SENZA persisterlo.
// Cerca pattern "residente a X", "in X", "di X", oppure una città
// riconoscibile nella lista PD.
const COMUNE_HINT_RE =
  /(?:residente\s+(?:a|in)|deceduto\s+a|scomparso\s+a|abitava\s+a|di\s+)\s*([A-ZÀ-Ù][a-zà-ù' -]{2,40})/;

function extractAreaFromBlock(block: string): string | null {
  // 1) CAP esplicito nel testo
  const cap = extractPadovaCap(block);
  if (cap) return cap;
  // 2) Comune → CAP
  const m = block.match(COMUNE_HINT_RE);
  if (m && m[1]) {
    const c = comuneToCap(m[1]);
    if (c) return c;
  }
  return null;
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
