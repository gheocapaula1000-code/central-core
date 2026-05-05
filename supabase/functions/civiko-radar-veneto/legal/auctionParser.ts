// ═══════════════════════════════════════════════════════════════
// auctionParser — estrae candidati aste da HTML/Markdown/PDF text.
// Niente AI. Pattern matching deterministico, conservativo.
// ═══════════════════════════════════════════════════════════════
import type { AuctionSource, ProvCode } from "./auctionSourceRegistry.ts";

export interface AuctionCandidate {
  source_name: string;
  source_url: string;
  pdf_url?: string | null;
  tribunal: string | null;
  province: ProvCode | null;
  comune: string | null;
  address_text: string | null;
  asset_type: string | null;
  procedure_type: string | null;
  procedure_number: string | null;
  lot_number: string | null;
  base_price: number | null;
  minimum_offer: number | null;
  auction_date: string | null;
  publication_date: string | null;
  status: string | null;
  signal_type: "auction" | "alienation" | "legal_other";
  confidence_score: number;
  quality: "reale" | "parziale";
  data_basis: string[];
  privacy_redacted: boolean;
  payload: Record<string, unknown>;
  fingerprint: string;
}

// ── Vocabolario Veneto (capoluoghi + comuni grandi). Lista chiusa per inferenza.
const VENETO_COMUNI: Record<string, ProvCode> = {
  // PD
  "padova": "PD", "abano terme": "PD", "albignasego": "PD", "cittadella": "PD",
  "este": "PD", "monselice": "PD", "selvazzano dentro": "PD", "vigonza": "PD",
  // VE
  "venezia": "VE", "mestre": "VE", "chioggia": "VE", "san dona di piave": "VE",
  "san donà di piave": "VE", "jesolo": "VE", "mira": "VE", "spinea": "VE",
  "marcon": "VE", "portogruaro": "VE", "mirano": "VE",
  // VR
  "verona": "VR", "villafranca di verona": "VR", "san bonifacio": "VR",
  "legnago": "VR", "bussolengo": "VR", "san giovanni lupatoto": "VR",
  // VI
  "vicenza": "VI", "bassano del grappa": "VI", "schio": "VI", "thiene": "VI",
  "arzignano": "VI", "valdagno": "VI", "montecchio maggiore": "VI",
  // TV
  "treviso": "TV", "conegliano": "TV", "castelfranco veneto": "TV",
  "montebelluna": "TV", "vittorio veneto": "TV", "mogliano veneto": "TV",
  // BL
  "belluno": "BL", "feltre": "BL", "sedico": "BL", "ponte nelle alpi": "BL",
  // RO
  "rovigo": "RO", "adria": "RO", "porto viro": "RO", "lendinara": "RO",
};

const ASSET_TYPES: Array<[RegExp, string]> = [
  [/\bappartament[oi]\b/i, "appartamento"],
  [/\babitazione\b/i, "abitazione"],
  [/\bvill[ae]\b/i, "villa"],
  [/\bcasa\b/i, "casa"],
  [/\bgarage\b|\bautorimess[ae]\b/i, "garage"],
  [/\bnegozi[oi]\b/i, "negozio"],
  [/\buffici[oi]\b/i, "ufficio"],
  [/\bcapannon[ei]\b/i, "capannone"],
  [/\blaboratori[oi]\b/i, "laboratorio"],
  [/\bmagazzin[oi]\b/i, "magazzino"],
  [/\bterren[oi]\s+(?:agricol|edificabil)/i, "terreno"],
  [/\bterren[oi]\b/i, "terreno"],
  [/\bcomplesso immobiliare\b/i, "complesso immobiliare"],
  [/\bfabbricat[oi]\b/i, "fabbricato"],
];

const PROCEDURE_PATTERNS: Array<[RegExp, string]> = [
  [/vendita\s+telematica/i, "vendita_telematica"],
  [/vendita\s+senza\s+incanto/i, "vendita_senza_incanto"],
  [/vendita\s+con\s+incanto/i, "vendita_con_incanto"],
  [/procedura\s+esecutiva\s+immobiliare/i, "esecuzione_immobiliare"],
  [/fallimento|liquidazione\s+giudiziale/i, "fallimento"],
  [/alienazione|dismissione/i, "alienazione"],
];

const PERSONAL_PATTERNS: RegExp[] = [
  /\b\d{3}[\s.-]?\d{6,8}\b/, // tel
  /\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/i, // email
  /\b[A-Z]{6}\d{2}[A-EHLMPRT]\d{2}[A-Z]\d{3}[A-Z]\b/, // CF
];

const RGE_PATTERN = /\bR\.?\s*G\.?\s*E\.?\s*(?:n\.?\s*)?(\d{1,5}\s*[\/\-]\s*\d{2,4})/i;
const LOT_PATTERN = /\blott[oa]\s*(?:n\.?\s*)?([A-Z0-9]{1,6})/i;
const TRIBUNALE_PATTERN = /tribunale\s+di\s+([A-Za-zàèéìòùÀ-Ý' ]{3,30})/i;

export function parseEuroAmount(text: string): number | null {
  // Cerca pattern: € 123.456,78  oppure  Euro 123.456
  const m = text.match(/(?:€|euro?)\s*([\d\.\,]+)/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, "").replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 100 ? n : null;
}

export function parseAuctionDate(text: string): string | null {
  // dd/mm/yyyy or dd-mm-yyyy
  const m = text.match(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/);
  if (!m) return null;
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

export function classifyAssetType(text: string): string | null {
  for (const [re, label] of ASSET_TYPES) if (re.test(text)) return label;
  return null;
}

function classifyProcedure(text: string): string | null {
  for (const [re, label] of PROCEDURE_PATTERNS) if (re.test(text)) return label;
  return null;
}

export function inferComuneProvincia(
  text: string,
  source: AuctionSource,
): { comune: string | null; province: ProvCode | null } {
  const low = text.toLowerCase();
  for (const [name, prov] of Object.entries(VENETO_COMUNI)) {
    if (low.includes(name)) {
      return { comune: name.replace(/\b\w/g, (c) => c.toUpperCase()), province: prov };
    }
  }
  if (Array.isArray(source.province_scope) && source.province_scope.length === 1) {
    return { comune: null, province: source.province_scope[0] };
  }
  return { comune: null, province: null };
}

export function rejectPersonalDataHeavy(text: string): { redacted: boolean; hits: number } {
  let hits = 0;
  for (const re of PERSONAL_PATTERNS) {
    const m = text.match(new RegExp(re.source, "g"));
    if (m) hits += m.length;
  }
  return { redacted: hits > 0, hits };
}

export async function buildAuctionFingerprint(c: Partial<AuctionCandidate>): Promise<string> {
  const seed = [
    c.source_url ?? "",
    c.lot_number ?? "",
    c.auction_date ?? "",
    c.base_price ?? "",
    (c.comune ?? "").toLowerCase(),
  ].join("|");
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(seed));
  return "auc_" + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export function scoreAuctionConfidence(c: Partial<AuctionCandidate>): number {
  let s = 0;
  if (c.tribunal) s += 0.15;
  if (c.comune) s += 0.15;
  if (c.province) s += 0.05;
  if (c.base_price) s += 0.20;
  if (c.auction_date) s += 0.20;
  if (c.lot_number) s += 0.10;
  if (c.procedure_type) s += 0.10;
  if (c.asset_type) s += 0.05;
  return Math.min(1, Number(s.toFixed(2)));
}

// Estrae uno o più candidati da un blocco markdown/HTML-stripped.
// Strategia conservativa: una pagina = un candidato (best-effort),
// salvo presenza di multipli "Lotto N" → uno per lotto.
export async function extractAuctionCandidatesFromMarkdown(
  markdown: string,
  source: AuctionSource,
  sourceUrl: string,
  pdfUrl: string | null = null,
): Promise<AuctionCandidate[]> {
  if (!markdown || markdown.length < 80) return [];
  const text = markdown.slice(0, 20_000);
  const lower = text.toLowerCase();

  // Filtro keyword minimo
  const hasKw = source.keywords.some((k) => lower.includes(k.toLowerCase()));
  if (!hasKw) return [];

  // Split per lotti se presenti più match
  const lotMatches = [...text.matchAll(/\blott[oa]\s*(?:n\.?\s*)?([A-Z0-9]{1,6})/gi)];
  const blocks: Array<{ text: string; lot: string | null }> = [];

  if (lotMatches.length > 1) {
    let prev = 0;
    let prevLot: string | null = null;
    for (const m of lotMatches) {
      if (prev > 0) blocks.push({ text: text.slice(prev, m.index ?? prev), lot: prevLot });
      prev = m.index ?? 0;
      prevLot = m[1];
    }
    if (prev < text.length) blocks.push({ text: text.slice(prev), lot: prevLot });
  } else {
    blocks.push({ text, lot: lotMatches[0]?.[1] ?? null });
  }

  const out: AuctionCandidate[] = [];
  for (const b of blocks) {
    const seg = b.text;
    const { comune, province } = inferComuneProvincia(seg, source);
    const tribunal = seg.match(TRIBUNALE_PATTERN)?.[1]?.trim().slice(0, 80) ?? null;
    const rge = seg.match(RGE_PATTERN)?.[1]?.replace(/\s+/g, "") ?? null;
    const base = parseEuroAmount(seg);
    // minimum_offer: ricerca dopo "offerta minima"
    const minSeg = seg.match(/offerta\s+minima[^\n]{0,80}/i)?.[0] ?? "";
    const minOffer = parseEuroAmount(minSeg);
    const dateSeg = seg.match(/(?:data\s+vendita|vendita\s+il|in\s+data)[^\n]{0,40}/i)?.[0] ?? seg;
    const dt = parseAuctionDate(dateSeg);
    const proc = classifyProcedure(seg);
    const asset = classifyAssetType(seg);
    const personal = rejectPersonalDataHeavy(seg);

    const isAlienation = /alienazione|dismissione|bando\s+vendita/i.test(seg) && !/procedura\s+esecutiva/i.test(seg);
    const sigType: "auction" | "alienation" | "legal_other" = isAlienation
      ? "alienation"
      : proc || base || dt
      ? "auction"
      : "legal_other";

    const candidate: Partial<AuctionCandidate> = {
      source_name: source.source_name,
      source_url: sourceUrl,
      pdf_url: pdfUrl,
      tribunal,
      province,
      comune,
      address_text: null,
      asset_type: asset,
      procedure_type: proc,
      procedure_number: rge,
      lot_number: b.lot,
      base_price: base,
      minimum_offer: minOffer,
      auction_date: dt,
      publication_date: null,
      status: null,
      signal_type: sigType,
      quality: (base && dt && tribunal) ? "reale" : "parziale",
      data_basis: ["firecrawl", source.source_key],
      privacy_redacted: personal.redacted,
      payload: {
        excerpt: seg.slice(0, 280),
        personal_hits: personal.hits,
        source_type: source.source_type,
      },
    };
    candidate.confidence_score = scoreAuctionConfidence(candidate);
    candidate.fingerprint = await buildAuctionFingerprint(candidate);
    out.push(candidate as AuctionCandidate);
  }

  return out;
}
