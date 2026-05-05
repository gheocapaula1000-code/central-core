// ═══════════════════════════════════════════════════════════════
// auctionParser — estrae candidati aste da HTML/Markdown/PDF text.
// Niente AI. Pattern matching deterministico, conservativo.
// ═══════════════════════════════════════════════════════════════
import type { AuctionSource, ProvCode } from "./auctionSourceRegistry.ts";

export type LocationBasis = "text" | "title" | "breadcrumb" | "url" | "source_scope" | "none";

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
  location_basis: LocationBasis;
  needs_review_reason?: string | null;
  privacy_redacted: boolean;
  payload: Record<string, unknown>;
  fingerprint: string;
}

// ── Vocabolario Veneto: capoluoghi + comuni grandi/medi (lista chiusa).
const VENETO_COMUNI: Record<string, ProvCode> = {
  // PD
  "padova": "PD", "abano terme": "PD", "albignasego": "PD", "cittadella": "PD",
  "este": "PD", "monselice": "PD", "selvazzano dentro": "PD", "vigonza": "PD",
  "piove di sacco": "PD", "cadoneghe": "PD", "rubano": "PD", "camposampiero": "PD",
  // VE
  "venezia": "VE", "mestre": "VE", "chioggia": "VE", "san dona di piave": "VE",
  "san donà di piave": "VE", "jesolo": "VE", "mira": "VE", "spinea": "VE",
  "marcon": "VE", "portogruaro": "VE", "mirano": "VE", "noale": "VE",
  "dolo": "VE", "martellago": "VE", "scorze": "VE", "scorzè": "VE",
  // VR
  "verona": "VR", "villafranca di verona": "VR", "san bonifacio": "VR",
  "legnago": "VR", "bussolengo": "VR", "san giovanni lupatoto": "VR",
  "negrar": "VR", "negrar di valpolicella": "VR", "cerea": "VR",
  "san martino buon albergo": "VR", "valeggio sul mincio": "VR", "peschiera del garda": "VR",
  // VI
  "vicenza": "VI", "bassano del grappa": "VI", "schio": "VI", "thiene": "VI",
  "arzignano": "VI", "valdagno": "VI", "montecchio maggiore": "VI",
  "marostica": "VI", "lonigo": "VI", "noventa vicentina": "VI", "dueville": "VI",
  // TV
  "treviso": "TV", "conegliano": "TV", "castelfranco veneto": "TV",
  "montebelluna": "TV", "vittorio veneto": "TV", "mogliano veneto": "TV",
  "oderzo": "TV", "paese": "TV", "villorba": "TV", "preganziol": "TV",
  "spresiano": "TV", "asolo": "TV",
  // BL
  "belluno": "BL", "feltre": "BL", "sedico": "BL", "ponte nelle alpi": "BL",
  "pieve di cadore": "BL", "longarone": "BL", "agordo": "BL", "cortina d'ampezzo": "BL",
  "cortina dampezzo": "BL",
  // RO
  "rovigo": "RO", "adria": "RO", "porto viro": "RO", "lendinara": "RO",
  "badia polesine": "RO", "occhiobello": "RO", "porto tolle": "RO",
};

// Slug → comune key (per URL inference)
const VENETO_SLUGS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const k of Object.keys(VENETO_COMUNI)) {
    const slug = k
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/'/g, "")
      .replace(/\s+/g, "-");
    m[slug] = k;
  }
  return m;
})();

const PROV_SLUG_TO_CODE: Record<string, ProvCode> = {
  padova: "PD", venezia: "VE", verona: "VR", vicenza: "VI",
  treviso: "TV", belluno: "BL", rovigo: "RO",
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
const TRIBUNALE_PATTERN = /tribunale\s+di\s+([A-Za-zàèéìòùÀ-Ý' ]{3,30})/i;
const COMUNE_LABEL_RE = /\b(?:Comune|Localit[aà]|Citt[aà])\s*(?:di\s*)?[:\-]?\s*([A-ZÀ-Ý][A-Za-zàèéìòùÀ-Ý' ]{2,40})/;

export function parseEuroAmount(text: string): number | null {
  const m = text.match(/(?:€|euro?)\s*([\d\.\,]+)/i);
  if (!m) return null;
  const raw = m[1].replace(/\./g, "").replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 100 ? n : null;
}

export function parseAuctionDate(text: string): string | null {
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

function titleCase(s: string): string {
  return s.split(/\s+/).map((w) => w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(" ");
}

// ── Normalizer base
export function normalizeVenetoComuneProvincia(rawText: string): { comune: string | null; province: ProvCode | null } {
  if (!rawText) return { comune: null, province: null };
  const low = rawText.toLowerCase().normalize("NFC");
  // Match word-boundary su comuni noti (preferisce match più lunghi)
  let best: { name: string; prov: ProvCode } | null = null;
  for (const [name, prov] of Object.entries(VENETO_COMUNI)) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i");
    if (re.test(low) && (!best || name.length > best.name.length)) {
      best = { name, prov };
    }
  }
  if (best) return { comune: titleCase(best.name), province: best.prov };
  return { comune: null, province: null };
}

export function inferLocationFromUrl(url: string): { comune: string | null; province: ProvCode | null } {
  try {
    const u = new URL(url);
    const parts = u.pathname.toLowerCase().split(/[\/\-_]+/).filter(Boolean);
    let prov: ProvCode | null = null;
    let comuneName: string | null = null;
    // 1) provincia da path
    for (const p of parts) {
      if (PROV_SLUG_TO_CODE[p]) { prov = PROV_SLUG_TO_CODE[p]; break; }
    }
    // 2) comune da path: prova combinazioni multi-segmento (max 4 token)
    const path = parts.join("-");
    let bestSlug: string | null = null;
    for (const slug of Object.keys(VENETO_SLUGS)) {
      if (path.includes(slug) && (!bestSlug || slug.length > bestSlug.length)) {
        bestSlug = slug;
      }
    }
    if (bestSlug) {
      comuneName = titleCase(VENETO_SLUGS[bestSlug]);
      const provFromComune = VENETO_COMUNI[VENETO_SLUGS[bestSlug]];
      if (!prov && provFromComune) prov = provFromComune;
    }
    return { comune: comuneName, province: prov };
  } catch {
    return { comune: null, province: null };
  }
}

export function inferLocationFromTitle(title: string | null | undefined): { comune: string | null; province: ProvCode | null } {
  if (!title) return { comune: null, province: null };
  return normalizeVenetoComuneProvincia(title);
}

export function inferLocationFromBreadcrumb(text: string): { comune: string | null; province: ProvCode | null } {
  if (!text) return { comune: null, province: null };
  // Cerca markdown breadcrumb: "Home > Veneto > Padova > Abano Terme"
  const bc = text.match(/(?:home|veneto|aste|immobili)[^\n]{0,200}?(?:>|›|»|\/|→)[^\n]{0,200}/i);
  const seg = bc?.[0] ?? "";
  if (!seg) return { comune: null, province: null };
  return normalizeVenetoComuneProvincia(seg);
}

export function inferLocationFromSourceScope(source: AuctionSource): { comune: string | null; province: ProvCode | null } {
  if (Array.isArray(source.province_scope) && source.province_scope.length === 1) {
    return { comune: null, province: source.province_scope[0] };
  }
  return { comune: null, province: null };
}

export function inferComuneProvincia(
  text: string,
  source: AuctionSource,
  ctx: { url?: string; title?: string | null } = {},
): { comune: string | null; province: ProvCode | null; basis: LocationBasis } {
  // Preferenza: testo > titolo > breadcrumb > url > scope
  const t = normalizeVenetoComuneProvincia(text);
  if (t.comune && t.province) return { ...t, basis: "text" };

  const title = inferLocationFromTitle(ctx.title ?? null);
  if (title.comune && title.province) return { ...title, basis: "title" };

  const bc = inferLocationFromBreadcrumb(text);
  if (bc.comune && bc.province) return { ...bc, basis: "breadcrumb" };

  if (ctx.url) {
    const u = inferLocationFromUrl(ctx.url);
    if (u.comune && u.province) return { ...u, basis: "url" };
    if (u.province && (t.comune || title.comune)) {
      return { comune: t.comune ?? title.comune, province: u.province, basis: "url" };
    }
    if (u.province) {
      return { comune: null, province: u.province, basis: "url" };
    }
  }

  const scope = inferLocationFromSourceScope(source);
  if (scope.province) return { ...scope, basis: "source_scope" };

  // Solo testo parziale
  if (t.province || title.province) {
    return { comune: t.comune ?? title.comune, province: t.province ?? title.province, basis: t.province ? "text" : "title" };
  }
  return { comune: null, province: null, basis: "none" };
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

// URL heuristic: pagina dettaglio vs index
export function isLikelyDetailUrl(url: string): boolean {
  return /\/(scheda|dettaglio|lotto|annuncio|bene|vendita|asta|avviso|procedure)[\/\-]/i.test(url) ||
    /[?&](id|idAsta|idLotto|lotId|annuncio)=/i.test(url) ||
    /\/\d{3,}\b/.test(url);
}

export function scoreAuctionConfidence(c: Partial<AuctionCandidate> & { isIndex?: boolean }): number {
  let s = 0;
  // Location
  if (c.comune && c.province) s += 0.20;
  else if (c.province) s += 0.10;
  // Segnali
  if (c.base_price || c.minimum_offer) s += 0.15;
  if (c.auction_date) s += 0.15;
  if (c.lot_number || c.procedure_type) s += 0.10;
  if (c.asset_type) s += 0.10;
  // Source/tribunal
  if (c.tribunal) s += 0.10;
  if (c.pdf_url || c.source_url) s += 0.10;
  // Penalità
  if (c.isIndex) s -= 0.20;
  if (c.privacy_redacted && (c.payload?.personal_hits as number ?? 0) > 3) s -= 0.30;
  return Math.max(0, Math.min(1, Number(s.toFixed(2))));
}

// Estrae uno o più candidati da un blocco markdown/HTML-stripped.
export async function extractAuctionCandidatesFromMarkdown(
  markdown: string,
  source: AuctionSource,
  sourceUrl: string,
  pdfUrl: string | null = null,
  ctx: { title?: string | null } = {},
): Promise<AuctionCandidate[]> {
  if (!markdown || markdown.length < 80) return [];
  const text = markdown.slice(0, 20_000);
  const lower = text.toLowerCase();

  const hasKw = source.keywords.some((k) => lower.includes(k.toLowerCase()));
  if (!hasKw) return [];

  const isIndex = !isLikelyDetailUrl(sourceUrl);

  // Split per lotti se presenti più match espliciti
  const lotMatches = [...text.matchAll(/\blott[oa]\s*(?:n\.?\s*)?([A-Z0-9]{1,6})/gi)];
  const blocks: Array<{ text: string; lot: string | null }> = [];

  if (lotMatches.length > 1 && !isIndex) {
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
    const loc = inferComuneProvincia(seg, source, { url: sourceUrl, title: ctx.title });
    // Comune label esplicito può rafforzare
    if (!loc.comune) {
      const m = seg.match(COMUNE_LABEL_RE);
      if (m) {
        const norm = normalizeVenetoComuneProvincia(m[1]);
        if (norm.comune) {
          loc.comune = norm.comune;
          if (norm.province) loc.province = norm.province;
          if (loc.basis === "none") loc.basis = "text";
        }
      }
    }

    const tribunal = seg.match(TRIBUNALE_PATTERN)?.[1]?.trim().slice(0, 80) ?? null;
    const rge = seg.match(RGE_PATTERN)?.[1]?.replace(/\s+/g, "") ?? null;
    const base = parseEuroAmount(seg);
    const minSeg = seg.match(/offerta\s+minima[^\n]{0,80}/i)?.[0] ?? "";
    const minOffer = parseEuroAmount(minSeg);
    const dateSeg = seg.match(/(?:data\s+vendita|vendita\s+il|in\s+data|termine\s+presentazione)[^\n]{0,40}/i)?.[0] ?? seg;
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

    const candidate: Partial<AuctionCandidate> & { isIndex?: boolean } = {
      source_name: source.source_name,
      source_url: sourceUrl,
      pdf_url: pdfUrl,
      tribunal,
      province: loc.province,
      comune: loc.comune,
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
      quality: (base && dt && (tribunal || loc.comune)) ? "reale" : "parziale",
      data_basis: [source.source_key],
      location_basis: loc.basis,
      privacy_redacted: personal.redacted,
      payload: {
        excerpt: seg.slice(0, 280),
        personal_hits: personal.hits,
        source_type: source.source_type,
        is_index_page: isIndex,
      },
      isIndex,
    };
    candidate.confidence_score = scoreAuctionConfidence(candidate);
    candidate.fingerprint = await buildAuctionFingerprint(candidate);
    // needs_review_reason
    if ((candidate.confidence_score ?? 0) < 0.70) {
      const reasons: string[] = [];
      if (!loc.comune) reasons.push("missing_comune");
      if (!candidate.base_price && !candidate.minimum_offer) reasons.push("missing_price");
      if (!candidate.auction_date) reasons.push("missing_date");
      if (isIndex) reasons.push("index_page");
      candidate.needs_review_reason = reasons.join(",") || null;
    }
    delete (candidate as Record<string, unknown>).isIndex;
    out.push(candidate as AuctionCandidate);
  }

  return out;
}
