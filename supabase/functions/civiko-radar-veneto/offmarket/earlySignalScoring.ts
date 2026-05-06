// ═══════════════════════════════════════════════════════════════
// earlySignalScoring.ts — classificatore qualità superiore.
// Reject immediato + asset_type + boost immobili pubblici +
// commercial_value_score + priority_score + AI summaries safe.
// Nessun dato personale. Nessuna invenzione: solo source text.
// ═══════════════════════════════════════════════════════════════

import { classifyEarlySignal, type EarlySignalType } from "./earlySignalClassifier.ts";

export type EvalStatus =
  | "discovered" | "rejected" | "needs_review" | "approved" | "promoted";

export type AssetType =
  | "fabbricato" | "immobile_residenziale" | "terreno" | "area_edificabile"
  | "appartamento" | "edificio" | "complesso_immobiliare"
  | "patrimonio_immobiliare" | "bene_immobile"
  | "non_real_estate_asset" | "unknown";

export interface EvalInput {
  title: string | null;
  text: string | null;
  source_url: string;
  source_name?: string | null;
  source_is_institutional?: boolean;
  comune: string;
  provincia: string;
}

export interface EvalResult {
  status: EvalStatus;
  signal_type: EarlySignalType | "needs_review" | "irrelevant";
  asset_type: AssetType;
  privacy_safe: boolean;
  confidence_score: number;
  real_estate_relevance_score: number;
  commercial_value_score: number;
  priority_score: number;
  matched_keywords: string[];
  rejection_reason?: string;
  review_reason?: string;
  location_detail?: string;
  amount_text?: string;
  deadline_text?: string;
  publication_date?: string;
  ai_summary?: string;
  agent_action?: string;
  owner_pitch?: string;
  investor_pitch?: string;
  why_it_matters?: string;
  timing: "early" | "active" | "monitoring";
  quality: "alta" | "media" | "bassa";
  needs_review: boolean;
  importable: boolean;
  data_basis_extra: string[];
}

// ── Reject patterns ────────────────────────────────────────────
const REJECT_RULES: Array<{ test: (u: string, t: string, title: string) => boolean; reason: string }> = [
  { reason: "sitemap",              test: (u) => /sitemap\.xml|\/sitemap(\?|$|\/)/i.test(u) },
  { reason: "not_found",            test: (_u, t, ti) => /(pagina non trovata|404 not found|page not found|errore 404|risorsa non trovata)/i.test(t + " " + ti) },
  { reason: "error_page",           test: (_u, t) => /kernel error|application error|errore di sistema|servlet error/i.test(t) },
  { reason: "generic_faq",          test: (u, _t, ti) => /\/faq(\/|$)|domande frequenti/i.test(u + " " + ti) },
  { reason: "cookie_page",          test: (u, t, ti) => /cookie policy|informativa cookie/i.test(ti + " " + t.slice(0, 800)) && t.length < 1500 },
  { reason: "generic_portal_page",  test: (u, t, ti) => /myportal|home portale|benvenuto nel portale/i.test(u + " " + ti) && t.length < 800 },
  { reason: "generic_service_page", test: (_u, t, ti) => /(presentazione del servizio|cos'è il servizio|descrizione del servizio)/i.test(ti + " " + t.slice(0, 600)) && !/alienazione|bando|gara|asta/i.test(t) },
];

const NON_RE_TOKENS = [
  "veicolo","veicoli","autoveicolo","autovettura","automobile","autocarro",
  "rimorchio","semirimorchio","motociclo","motocicli","ciclomotore",
  "macchinario","mezzi d'opera","attrezzatur","arredi","mobili e attrezzature",
];

const RE_ASSET_RULES: Array<{ type: AssetType; tokens: string[] }> = [
  { type: "fabbricato",              tokens: ["fabbricato"] },
  { type: "appartamento",            tokens: ["appartamento","unita immobiliare residenziale","unità immobiliare residenziale"] },
  { type: "immobile_residenziale",   tokens: ["immobile residenziale","immobili residenziali","abitazione"] },
  { type: "terreno",                 tokens: ["terreno","terreni","lotto di terreno","particella catastale"] },
  { type: "area_edificabile",        tokens: ["area edificabile","aree edificabili","area fabbricabile"] },
  { type: "edificio",                tokens: ["edificio","ex scuola","ex caserma","ex stazione"] },
  { type: "complesso_immobiliare",   tokens: ["complesso immobiliare","compendio immobiliare"] },
  { type: "patrimonio_immobiliare",  tokens: ["patrimonio immobiliare","beni immobili","immobili comunali","proprietà del comune","proprieta del comune","alienazioni immobiliari","dismissioni patrimoniali"] },
  { type: "bene_immobile",           tokens: ["bene immobile","beni immobili"] },
];

const STRONG_PUBLIC_RE_PATTERNS: RegExp[] = [
  /alienazione (di\s+)?(un[' ]?|uno |una )?(immobile|fabbricato|terreno|edificio|complesso|area)/i,
  /alienazion[ei] (di\s+)?(un[' ]?|uno |una )?(bene\s+)?immobil/i,
  /alienazion[ei] (a mezzo )?asta pubblica/i,
  /dismission[ei] patrimon/i,
  /patrimonio immobiliare/i,
  /propriet[aà] (comunale|del comune)/i,
  /asta pubblica.*(immobile|fabbricato|terreno|edificio)/i,
];

const HIGH_PRIORITY_COMUNI = new Set([
  "padova","venezia","verona","vicenza","treviso","mestre","mira","chioggia",
]);

// ── Field extractors ──────────────────────────────────────────
function extractFirst(re: RegExp, text: string): string | undefined {
  const m = text.match(re);
  return m ? m[0].trim().slice(0, 200) : undefined;
}

function extractLocationDetail(text: string): string | undefined {
  return extractFirst(/\b(via|viale|piazza|piazzale|vicolo|corso|strada|località|localita)\s+[A-ZÀ-Ý][\w'.\- àéèìòùÀ-Ý]{2,60}/i, text);
}
function extractAmount(text: string): string | undefined {
  return extractFirst(/€\s?[\d.\s]{3,}(,\d{2})?|\bEUR\s?[\d.\s]{3,}|\bbase\s+d['’]asta[^.\n]{0,80}/i, text);
}
function extractDeadline(text: string): string | undefined {
  return extractFirst(/(scadenza|termine|entro il|presentazione offerte)[^.\n]{0,100}/i, text);
}
function extractPubDate(text: string): string | undefined {
  return extractFirst(/(pubblicato il|data pubblicazione|del\s)\s?\d{1,2}[\/\-.\s][\w]{2,}[\/\-.\s]\d{2,4}/i, text);
}

function lowerSafe(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function detectAssetType(textLower: string): AssetType {
  if (NON_RE_TOKENS.some((t) => textLower.includes(t)) &&
      !RE_ASSET_RULES.some((r) => r.tokens.some((t) => textLower.includes(t)))) {
    return "non_real_estate_asset";
  }
  for (const r of RE_ASSET_RULES) {
    if (r.tokens.some((t) => textLower.includes(t))) return r.type;
  }
  if (NON_RE_TOKENS.some((t) => textLower.includes(t))) return "non_real_estate_asset";
  return "unknown";
}

function isInstitutional(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /\.gov\.it$|\.comune\.|\.regione\.|\.provincia\.|\.cittametropolitana\.|consip|invitalia|agenziademanio/.test(h);
  } catch { return false; }
}

function buildPitches(opts: {
  comune: string; asset_type: AssetType; location?: string; amount?: string; deadline?: string;
}) {
  const where = opts.location ? ` (${opts.location})` : "";
  const ai_summary =
    `Procedura pubblica relativa a ${prettyAsset(opts.asset_type)} nel Comune di ${opts.comune}${where}.` +
    (opts.deadline ? ` ${capitalize(opts.deadline)}.` : "");
  const agent_action =
    `Verificare l'avviso ufficiale del Comune di ${opts.comune}, identificare la zona interessata e contattare i proprietari limitrofi per aggiornamento valutazione.`;
  const owner_pitch =
    `Il Comune di ${opts.comune} ha avviato una procedura su patrimonio immobiliare nella zona${where}. ` +
    `Eventi di questo tipo possono modificare l'attenzione di investitori e operatori sul quartiere: è un buon momento per aggiornare la valutazione del proprio immobile.`;
  const investor_pitch =
    `Opportunità potenziale: ${prettyAsset(opts.asset_type)} interessato da procedura pubblica nel Comune di ${opts.comune}${where}. ` +
    (opts.amount ? `Riferimento economico: ${opts.amount}. ` : "") +
    `Valutare la documentazione ufficiale prima di qualsiasi azione.`;
  return { ai_summary, agent_action, owner_pitch, investor_pitch };
}
function prettyAsset(a: AssetType): string {
  const m: Record<AssetType, string> = {
    fabbricato: "un fabbricato",
    appartamento: "un appartamento",
    immobile_residenziale: "un immobile residenziale",
    terreno: "un terreno",
    area_edificabile: "un'area edificabile",
    edificio: "un edificio",
    complesso_immobiliare: "un complesso immobiliare",
    patrimonio_immobiliare: "patrimonio immobiliare",
    bene_immobile: "un bene immobile",
    non_real_estate_asset: "un asset non immobiliare",
    unknown: "un bene di natura da verificare",
  };
  return m[a];
}
function capitalize(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ── Main evaluator ─────────────────────────────────────────────
export function evaluateCandidatePage(input: EvalInput): EvalResult {
  const text = `${input.title ?? ""}\n${input.text ?? ""}`;
  const lower = lowerSafe(text);
  const titleLower = lowerSafe(input.title);
  const url = input.source_url;
  const institutional = input.source_is_institutional ?? isInstitutional(url);

  // Base classifier (privacy guard + signal type detection)
  const base = classifyEarlySignal(
    { title: input.title, text: input.text, source_url: url },
    input.comune,
  );

  const baseResult = (over: Partial<EvalResult>): EvalResult => ({
    status: "discovered",
    signal_type: base.signal_type,
    asset_type: "unknown",
    privacy_safe: base.privacy_safe,
    confidence_score: base.confidence_score,
    real_estate_relevance_score: 0,
    commercial_value_score: 0,
    priority_score: 0,
    matched_keywords: base.matched_keywords,
    timing: base.timing,
    quality: base.quality,
    needs_review: base.needs_review,
    importable: false,
    data_basis_extra: [],
    why_it_matters: base.why_it_matters,
    ...over,
  });

  // 1) Privacy reject (delegate to base)
  if (!base.privacy_safe) {
    return baseResult({
      status: "rejected",
      rejection_reason: "privacy_rejected",
      signal_type: "needs_review",
    });
  }

  // 2) Reject patterns
  for (const r of REJECT_RULES) {
    if (r.test(url, lower, titleLower)) {
      return baseResult({
        status: "rejected",
        rejection_reason: r.reason,
        signal_type: "irrelevant",
      });
    }
  }

  // 3) Asset type. Considera solo la PARTE PRINCIPALE del titolo (prima del breadcrumb "/")
  // per determinare se l'oggetto reale è non-immobiliare (es. "Alienazione di veicoli ... / Alienazione beni immobili").
  const titleMain = titleLower.split(/\s[\/|·•]\s/)[0];
  const titleHasNonRE = NON_RE_TOKENS.some((t) => titleMain.includes(t));
  const titleHasRE = RE_ASSET_RULES.some((r) => r.tokens.some((t) => titleMain.includes(t)));
  let asset_type = detectAssetType(lower);
  if (titleHasNonRE && !titleHasRE) asset_type = "non_real_estate_asset";
  if (asset_type === "non_real_estate_asset") {
    return baseResult({
      status: "rejected",
      rejection_reason: "non_real_estate_asset",
      asset_type,
      signal_type: "irrelevant",
    });
  }

  // 4) Low information: < 2 useful keywords AND not strong RE keyword
  const usefulKw = base.matched_keywords.length;
  const hasStrongRe = STRONG_PUBLIC_RE_PATTERNS.some((re) => re.test(text));
  if (usefulKw < 2 && !hasStrongRe) {
    return baseResult({
      status: "rejected",
      rejection_reason: "low_information",
      asset_type,
      signal_type: "irrelevant",
    });
  }

  // 5) Real-estate relevance scoring
  let re_rel = 0;
  if (asset_type !== "unknown") re_rel += 35;
  if (hasStrongRe) re_rel += 35;
  if (institutional) re_rel += 10;
  if (usefulKw >= 3) re_rel += 10;
  re_rel = Math.min(100, re_rel);

  // Boost: strong RE + institutional + privacy_safe + comune known → ensure thresholds
  let confidence = base.confidence_score;
  if (hasStrongRe && institutional && asset_type !== "unknown") {
    re_rel = Math.max(re_rel, 70);
    confidence = Math.max(confidence, 0.65);
  }

  // 6) Field extractions
  const location_detail = extractLocationDetail(text);
  const amount_text = extractAmount(text);
  const deadline_text = extractDeadline(text);
  const publication_date = extractPubDate(text);

  // 7) Commercial value
  let cv = 0;
  if (["fabbricato","appartamento","immobile_residenziale","terreno","area_edificabile","edificio","complesso_immobiliare"].includes(asset_type)) cv += 30;
  if (/(alienazion|dismission)/.test(lower)) cv += 20;
  if (location_detail) cv += 15;
  if (deadline_text || publication_date) cv += 15;
  if (HIGH_PRIORITY_COMUNI.has(input.comune.toLowerCase())) cv += 10;
  if (/(microzona|quartiere|sottozona|rigenerazione|valorizzazione)/.test(lower)) cv += 10;
  if (asset_type === "non_real_estate_asset") cv -= 50;
  if (re_rel < 30) cv -= 30;
  cv = Math.max(0, Math.min(100, cv));

  // 8) Importable check
  const evidenceCount =
    (location_detail ? 1 : 0) +
    (deadline_text || publication_date ? 1 : 0) +
    (/(bando|gara|avviso)/i.test(lower) ? 1 : 0) +
    (amount_text ? 1 : 0) +
    (/\.pdf|allegat|documento/i.test(lower) ? 1 : 0) +
    (/(lotto|oggetto:)/i.test(lower) ? 1 : 0) +
    ((input.title?.length ?? 0) > 25 ? 1 : 0);

  const importable =
    confidence >= 0.75 &&
    re_rel >= 75 &&
    base.privacy_safe &&
    institutional &&
    asset_type !== "unknown" && asset_type !== "non_real_estate_asset" &&
    evidenceCount >= 3;

  // 9) Status
  let status: EvalStatus = "discovered";
  let review_reason: string | undefined;
  if (importable) {
    status = "needs_review"; // approved richiede review umana
    review_reason = "importable: pronto per promozione manuale";
  } else if (re_rel >= 70 || hasStrongRe) {
    status = "needs_review";
    review_reason = `re_rel=${re_rel}, evidence=${evidenceCount}`;
  } else if (re_rel >= 40) {
    status = "needs_review";
    review_reason = "segnale debole ma plausibile";
  } else {
    status = "rejected";
  }

  // 10) Priority score
  const priority = Math.round(
    confidence * 100 * 0.35 +
    re_rel * 0.4 +
    cv * 0.25,
  );

  // 11) Pitches (no personal data, only source-derived references)
  const p = buildPitches({
    comune: input.comune,
    asset_type,
    location: location_detail,
    amount: amount_text,
    deadline: deadline_text,
  });

  return baseResult({
    status,
    asset_type,
    confidence_score: Number(confidence.toFixed(2)),
    real_estate_relevance_score: re_rel,
    commercial_value_score: cv,
    priority_score: priority,
    location_detail,
    amount_text,
    deadline_text,
    publication_date,
    review_reason,
    rejection_reason: status === "rejected" ? "low_relevance" : undefined,
    importable,
    needs_review: status === "needs_review",
    ai_summary: p.ai_summary,
    agent_action: p.agent_action,
    owner_pitch: p.owner_pitch,
    investor_pitch: p.investor_pitch,
    data_basis_extra: [
      institutional ? "institutional_source" : "non_institutional_source",
      hasStrongRe ? "strong_public_re_keyword" : "no_strong_re_keyword",
      `evidence:${evidenceCount}`,
    ],
  });
}
