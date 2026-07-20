// _shared/auctionExclusion.ts
// Guardia condivisa "aste": una sola implementazione riconosciuta da tutte le
// pipeline commerciali. Word-boundary aware. "catastale/catasto/visura" NON
// è mai considerato asta.

const AUCTION_PHRASES: string[] = [
  "asta",
  "aste",
  "auction",
  "pvp",
  "tribunale",
  "pignoramento",
  "pignoramenti",
  "vendita giudiziaria",
  "vendite giudiziarie",
  "esecuzione immobiliare",
  "esecuzioni immobiliari",
  "procedura esecutiva",
  "procedure esecutive",
  "immobile all asta",
  "immobili all asta",
  "immobile allasta",
  "fallimentare",
  "concordato preventivo",
];

// Domini/host dedicati alle aste
const AUCTION_DOMAIN_SUBSTRINGS: string[] = [
  "astalegale.net",
  "asteimmobili.it",
  "astegiudiziarie",
  "astetelematiche",
  "portalevenditepubbliche",
  "pvp.giustizia.it",
  "spazioaste",
  "gobid",
  "garaimmobiliare",
];

// Falsi positivi da escludere ESPLICITAMENTE prima del check parole (catasto ≠ asta).
// Sostituiamo con placeholder alfanumerico neutro.
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /\bvisur[ae]\s+catastal[ei]\b/gi,
  /\brendit[ae]\s+catastal[ei]\b/gi,
  /\bcatastal[ei]\b/gi,
  /\bcatasto\b/gi,
];

export function normalizeAuctionText(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else {
    try { s = JSON.stringify(value); } catch { s = ""; }
  }
  // Lowercase + strip accents
  s = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Neutralizza i falsi positivi PRIMA di collassare la punteggiatura
  for (const re of FALSE_POSITIVE_PATTERNS) s = s.replace(re, " catxx ");
  // Collassa punteggiatura/underscores in spazi per preservare word boundaries
  s = s.replace(/[^a-z0-9./:-]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function containsPhraseWordBoundary(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  // Escape regex metachars in phrase and require word boundary at both ends
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return re.test(haystack);
}

export function isAuctionText(value: unknown): boolean {
  const normalized = normalizeAuctionText(value);
  if (!normalized) return false;

  // Domain / host substring check (URLs preserve dots)
  for (const dom of AUCTION_DOMAIN_SUBSTRINGS) {
    if (normalized.includes(dom)) return true;
  }
  for (const phrase of AUCTION_PHRASES) {
    if (containsPhraseWordBoundary(normalized, phrase)) return true;
  }
  return false;
}

// Campi standard su cui applicare la guardia.
const CANDIDATE_FIELDS = [
  "url", "source_url", "link", "evidence_url",
  "title", "titolo", "headline",
  "description", "descrizione", "explanation", "note", "notes",
  "source_name", "fonte", "portal", "channel",
  "signal_type", "tipo", "type", "category",
  "property_hint", "address_text", "indirizzo",
  "tags",
];

export function isAuctionRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const rec = record as Record<string, unknown>;

  // signal_type / type: match anche "AUCTION*" family
  const typeCandidate = String(rec.signal_type ?? rec.type ?? "").toUpperCase();
  if (typeCandidate.includes("AUCTION") || typeCandidate.includes("ASTA")) return true;

  for (const key of CANDIDATE_FIELDS) {
    const v = rec[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      for (const el of v) {
        if (isAuctionText(el)) return true;
      }
      continue;
    }
    if (isAuctionText(v)) return true;
  }

  // payload / raw_json: serializza e valuta come unico blob normalizzato
  for (const key of ["payload", "raw_json", "raw", "extra", "meta"]) {
    const v = rec[key];
    if (v && typeof v === "object") {
      try {
        const blob = JSON.stringify(v);
        if (isAuctionText(blob)) return true;
      } catch { /* ignore */ }
    } else if (typeof v === "string") {
      if (isAuctionText(v)) return true;
    }
  }

  return false;
}
