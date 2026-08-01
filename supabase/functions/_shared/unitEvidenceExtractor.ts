// ═══════════════════════════════════════════════════════════════
// unitEvidenceExtractor — estrattore DETERMINISTICO di evidenze
// di unità immobiliare (via / civico / piano / descrizione) con
// PROVENIENZA e AFFIDABILITÀ per ogni valore.
//
// VINCOLI (P1-B):
// - Nessun fetch, nessun secret, nessun accesso DB, costo esterno €0.
// - Non produce dati inventati: se non dimostrabile → null.
// - Un quartiere non diventa MAI una via.
// - Un numero diventa civico SOLO se sintatticamente legato a una
//   via/piazza/corso/viale/... o proveniente da campo strutturato.
// - Mai sovrascrivere un dato strutturato con un'estrazione testuale.
// - image_refs NON sono fingerprint: sono soli riferimenti (path/URL)
//   e non possono certificare l'identità di un'unità.
// ═══════════════════════════════════════════════════════════════

export type EvidenceReliability = "structured" | "semi_structured" | "textual";

export interface EvidenceValue<T> {
  value: T | null;
  /** percorso sorgente esatto, es. "raw_json.geography.street" */
  source: string | null;
  reliability: EvidenceReliability | null;
}

export interface UnitEvidence {
  via_norm: EvidenceValue<string>;
  civico_norm: EvidenceValue<string>;
  piano_key: EvidenceValue<string>;
  descrizione_norm: EvidenceValue<string>;
  /** impronta deterministica della descrizione normalizzata (non è prova da sola) */
  descrizione_fp: EvidenceValue<string>;
  /** riferimenti immagini disponibili — NON sono fingerprint */
  image_refs: string[];
}

// ─────────── Quartieri / macrozone Padova: mai una via ───────────
// Fonte: etichette zona già presenti nei portali (casa.it `zone`,
// immobiliare `geography.macrozone/microzone`, idealista `district`).
const QUARTIERE_TOKENS = [
  "arcella", "centro storico", "centro", "piazze", "duomo", "santo",
  "santa sofia", "altinate", "savonarola", "ponte molino", "portello",
  "san carlo", "pontevigodarzere", "sacra famiglia", "brusegana",
  "cave", "montà", "monta", "ponterotto", "san bellino", "mortise",
  "torre", "san lazzaro", "stanga", "forcellini", "santa rita",
  "voltabarozzo", "salboro", "guizza", "mandria", "sant'osvaldo",
  "santosvaldo", "chiesanuova", "paltana", "madonna pellegrina",
  "crocefisso", "bassanello", "città giardino", "citta giardino",
  "san giuseppe", "sant'ignazio", "santignazio", "isola di terranegra",
  "terranegra", "camin", "granze", "zona industriale", "fiera",
  "stazione", "prato della valle", "san prosdocimo", "borgomagno",
  "est brenta", "padova", "veneto",
];

const VIA_PREFIX =
  "via|viale|v\\.le|piazza|p\\.zza|piazzale|p\\.le|corso|c\\.so|largo|vicolo|strada|stradella|borgo|lungargine|riviera|salita|calle|contrà|contra|contrada|passaggio|galleria|rotonda";

/** Riconosce un odonimo REALE: prefisso odonimico + nome proprio. */
const STREET_ANCHORED_RE = new RegExp(
  `\\b(${VIA_PREFIX})\\s+([A-Za-zÀ-ÿ0-9'’\\.\\-]+(?:\\s+[A-Za-zÀ-ÿ0-9'’\\.\\-]+){0,5})`,
  "i",
);

/**
 * Civico: SOLO immediatamente dopo l'odonimo, con separatore ammesso
 * (`,` / `n.` / `civico` / spazio). Rifiuta unità di misura, valute e
 * qualsiasi token che qualifichi il numero come altra grandezza.
 */
const CIVICO_AFTER_STREET_RE = new RegExp(
  `\\b(?:${VIA_PREFIX})\\s+[A-Za-zÀ-ÿ'’\\.\\-]+(?:\\s+[A-Za-zÀ-ÿ'’\\.\\-]+){0,4}` +
    `[\\s,]*(?:n\\.?|nr\\.?|civico|civ\\.?)?\\s*(\\d{1,4}\\s*(?:/\\s*)?[a-zA-Z]?)\\b`,
  "i",
);

/** Token che, se seguono il numero, ne vietano l'uso come civico. */
const NON_CIVICO_SUFFIX_RE =
  /^\s*(m²|mq|m2|mc|€|euro|eur|local[ei]|van[oi]|camer[ei]|bagn[oi]|piano|piani|%|km|anno|posti|classe)/i;

const CAP_RE = /\b\d{5}\b/;

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeViaKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = stripAccents(raw)
    .toLowerCase()
    .replace(new RegExp(`^\\s*(${VIA_PREFIX})\\s+`, "i"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base || base === "na") return null;
  if (isQuartiereLabel(base.replace(/-/g, " "))) return null;
  // Un odonimo plausibile ha almeno 3 caratteri alfabetici.
  if (base.replace(/[^a-z]/g, "").length < 3) return null;
  return base;
}

export function isQuartiereLabel(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = stripAccents(raw).toLowerCase().trim();
  if (!t) return false;
  // Etichette multi-zona tipo "Piazze, Duomo, Santo" → quartiere, mai via.
  const parts = t.split(/\s*[,;/]\s*/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) =>
    QUARTIERE_TOKENS.some((q) => stripAccents(q).toLowerCase() === p)
  );
}

/** Estrae un odonimo da testo libero SOLO se ancorato a un prefisso odonimico. */
export function extractViaFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(STREET_ANCHORED_RE);
  if (!m) return null;
  const candidate = `${m[1]} ${m[2]}`
    .replace(/[\s,;.\-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const nameOnly = m[2].trim();
  if (isQuartiereLabel(nameOnly)) return null;
  if (nameOnly.replace(/[^A-Za-zÀ-ÿ]/g, "").length < 3) return null;
  return candidate;
}

/** Civico da testo libero: ammesso solo se legato sintatticamente all'odonimo. */
export function extractCivicoFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(CIVICO_AFTER_STREET_RE);
  if (!m) return null;
  const rawNum = m[1].replace(/\s+/g, "");
  const after = text.slice((m.index ?? 0) + m[0].length);
  if (NON_CIVICO_SUFFIX_RE.test(after)) return null;
  return normalizeCivico(rawNum, text);
}

/** Normalizza e valida un civico. Rifiuta CAP, anni, prezzi, telefoni. */
export function normalizeCivico(
  raw: string | null | undefined,
  context?: string | null,
): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!cleaned) return null;
  const digits = cleaned.replace(/[^0-9]/g, "");
  if (!digits) return null;
  // CAP (5 cifre), telefono, prezzo, anno, id annuncio → mai civico.
  if (digits.length >= 5) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0 || n > 999) return null;
  if (digits.length === 4) return null; // anno / prezzo troncato
  if (context && CAP_RE.test(context)) {
    const capMatch = context.match(CAP_RE);
    if (capMatch && capMatch[0] === digits) return null;
  }
  if (cleaned.length > 5) return null;
  return cleaned;
}

// ─────────── Piano ───────────
export function normalizePianoKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = stripAccents(String(raw)).toLowerCase().trim();
  if (!v) return null;
  if (/seminterrat|interrat|sottosuolo|scantinat/.test(v)) return "S";
  if (/rialzat/.test(v)) return "R";
  if (/piano terra|\bterra\b|^t$|^pt$|piano t\b/.test(v)) return "T";
  if (/mansard/.test(v)) return "M";
  if (/attico|ultimo piano|\bultimo\b/.test(v)) return "A";
  const words: Record<string, string> = {
    primo: "P1", secondo: "P2", terzo: "P3", quarto: "P4", quinto: "P5",
    sesto: "P6", settimo: "P7", ottavo: "P8", nono: "P9", decimo: "P10",
  };
  for (const [w, k] of Object.entries(words)) {
    if (new RegExp(`\\b${w}\\b`).test(v)) return k;
  }
  const num = v.match(/(\d{1,2})/);
  if (num) {
    const n = Number(num[1]);
    if (n >= 0 && n <= 40) return n === 0 ? "T" : `P${n}`;
  }
  return null;
}

/** Piano dal corpo testo: SOLO con contesto esplicito "al … piano". */
export function extractPianoFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = stripAccents(text).toLowerCase();
  const patterns: RegExp[] = [
    /\b(?:al|allo|il|del)\s+(piano\s+(?:terra|rialzato|seminterrato|interrato|primo|secondo|terzo|quarto|quinto|sesto|settimo|ottavo|nono|decimo|ultimo|nobile))/,
    /\b(?:al|allo)\s+(\d{1,2})\s*[°ºo]?\s*piano\b/,
    /\bpiano\s+(terra|rialzato|seminterrato|interrato|primo|secondo|terzo|quarto|quinto|sesto|settimo|ottavo|nono|decimo|ultimo)\b/,
    /\b(\d{1,2})\s*[°º]\s*piano\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      if (/nobile/.test(m[1])) return null; // ambiguo: non dimostrabile
      const k = normalizePianoKey(m[1]);
      if (k) return k;
    }
  }
  return null;
}

// ─────────── Descrizione ───────────
const BOILERPLATE_RE: RegExp[] = [
  /rif\.?\s*(?:interno|agenzia)?\s*[:n°.]*\s*[a-z0-9\-\/]{2,15}/gi,
  /(?:tel|telefono|cell|cellulare|whatsapp)\.?\s*[:.]?\s*\+?[\d\s\.\-\/]{6,}/gi,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /https?:\/\/\S+/gi,
  /www\.\S+/gi,
  /\b(?:open house|visita guidata|contattaci|contattateci|chiamaci|fissa un appuntamento|per informazioni|maggiori informazioni|richiedi maggiori)\b[^.]*\.?/gi,
  /\b(?:re\/max|remax|tecnocasa|gabetti|tempocasa|professionecasa|grimaldi|toscano)\b/gi,
  /\bannuncio\s+(?:pubblicato|aggiornato)[^.]*\.?/gi,
  /\bclasse energetica[^.]*\.?/gi,
];

const GENERIC_PHRASES_RE =
  /^(?:appartamento|casa|immobile|soluzione|proposta|villa)\s+(?:in vendita|di pregio|luminoso|ristrutturato)?\s*$/i;

export function normalizeDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = String(raw);
  for (const re of BOILERPLATE_RE) t = t.replace(re, " ");
  t = stripAccents(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!t) return null;
  if (GENERIC_PHRASES_RE.test(t)) return null;
  return t;
}

/** Soglia di contenuto informativo: sotto questa non è evidenza. */
export const DESCR_MIN_CHARS = 160;

export function descriptionFingerprintInput(raw: string | null | undefined): string | null {
  const norm = normalizeDescription(raw);
  if (!norm) return null;
  const compact = norm.replace(/ /g, "");
  if (compact.length < DESCR_MIN_CHARS) return null;
  // Richiede contenuto lessicale vario: almeno 12 token distinti.
  const distinct = new Set(norm.split(" ").filter((w) => w.length > 3));
  if (distinct.size < 12) return null;
  return compact.slice(0, 400);
}

// ─────────── Riferimenti immagini (NON fingerprint) ───────────
export function collectImageRefs(raw: unknown, limit = 12): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (out.length >= limit || depth > 4) return;
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?|$)/i.test(v)) out.push(v.slice(0, 400));
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
    }
  };
  visit(raw, 0);
  return Array.from(new Set(out)).slice(0, limit);
}

// ─────────── Precedenza ───────────
const RELIABILITY_RANK: Record<EvidenceReliability, number> = {
  structured: 3,
  semi_structured: 2,
  textual: 1,
};

export function pick<T>(...candidates: Array<EvidenceValue<T>>): EvidenceValue<T> {
  let best: EvidenceValue<T> = { value: null, source: null, reliability: null };
  for (const c of candidates) {
    if (c.value === null || c.value === undefined) continue;
    if (
      best.value === null ||
      RELIABILITY_RANK[c.reliability ?? "textual"] >
        RELIABILITY_RANK[best.reliability ?? "textual"]
    ) {
      best = c;
    }
  }
  return best;
}

export const EMPTY_EVIDENCE: EvidenceValue<string> = {
  value: null,
  source: null,
  reliability: null,
};
