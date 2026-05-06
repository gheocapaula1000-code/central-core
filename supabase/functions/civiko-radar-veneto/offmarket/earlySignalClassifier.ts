// ═══════════════════════════════════════════════════════════════
// Early Signal Classifier — keyword/pattern + privacy guard.
// Output: signal_type, timing, why_it_matters, possible_agent_action,
// confidence_score, quality, privacy_safe, needs_review.
// ═══════════════════════════════════════════════════════════════

import { classifySensitiveSource, redactPersonalFields } from "../firecrawl/privacyGuard.ts";

export type EarlySignalType =
  | "pre_auction_signal"
  | "pre_alienation_signal"
  | "public_asset_disposal_signal"
  | "public_asset_valuation_signal"
  | "unused_public_property_signal"
  | "urban_regeneration_signal"
  | "zoning_change_signal"
  | "public_work_impact_signal"
  | "mobility_change_signal"
  | "tourism_pressure_early_signal"
  | "municipal_asset_strategy_signal"
  | "expression_of_interest_signal"
  | "market_sounding_signal"
  | "concession_or_lease_signal"
  | "project_financing_signal"
  | "redevelopment_area_signal"
  | "offmarket_campaign_signal";

export type Timing = "early" | "active" | "monitoring";

export interface ClassifierInput {
  title: string | null;
  text: string | null;
  source_url: string;
}

export interface ClassifiedEarlySignal {
  signal_type: EarlySignalType | "irrelevant" | "needs_review";
  timing: Timing;
  matched_keywords: string[];
  confidence_score: number; // 0..1
  quality: "alta" | "media" | "bassa";
  privacy_safe: boolean;
  privacy_reason?: string;
  why_it_matters: string;
  possible_agent_action: string;
  summary: string;
  needs_review: boolean;
}

interface Rule {
  type: EarlySignalType;
  tokens: string[];
  weight?: number;
  timingHint?: Timing;
}

const RULES: Rule[] = [
  { type: "pre_alienation_signal",         tokens: ["piano alienazion","piano delle alienazion","alienazione beni immobili","aliena immobil","vendita immobile comunale"], weight: 0.9 },
  { type: "public_asset_disposal_signal",  tokens: ["dismission","cessione patrimon","alienazion patrimon"], weight: 0.85 },
  { type: "public_asset_valuation_signal", tokens: ["piano valorizzazion","valorizzazione patrimon","valorizzazione immobili"], weight: 0.85 },
  { type: "unused_public_property_signal", tokens: ["immobil inutilizzat","beni inutilizzat","patrimon inutilizzat","sottoutilizzat"], weight: 0.8 },
  { type: "expression_of_interest_signal", tokens: ["manifestazione di interesse","manifestazione d'interesse","avviso esplorativo","avviso preliminare"], weight: 0.85 },
  { type: "market_sounding_signal",        tokens: ["indagine di mercato","consultazione preliminare","market sounding"], weight: 0.8 },
  { type: "concession_or_lease_signal",    tokens: ["concessione","locazione","affidamento in concession","comodato"], weight: 0.7 },
  { type: "project_financing_signal",      tokens: ["project financing","partenariato pubblico privato","finanza di progetto","ppp"], weight: 0.85 },
  { type: "urban_regeneration_signal",     tokens: ["rigenerazione urbana","riqualificazione urbana","recupero area","recupero urbano"], weight: 0.85, timingHint: "active" },
  { type: "redevelopment_area_signal",     tokens: ["area degradata","area da recuperare","ex caserma","ex stazione","ex fabbrica","dismessa"], weight: 0.8 },
  { type: "zoning_change_signal",          tokens: ["variante urbanistica","variante al p.i.","variante al pi","piano interventi","cambio destinazione d'uso","piano urbanistico attuativo","puc","prg"], weight: 0.8 },
  { type: "public_work_impact_signal",     tokens: ["programma triennale lavori pubblici","opera pubblica","cantiere","appalto lavori"], weight: 0.7 },
  { type: "mobility_change_signal",        tokens: ["pums","piano urbano mobilità","nuova fermata","sfmr","tram","metropolitana","ztl"], weight: 0.7 },
  { type: "tourism_pressure_early_signal", tokens: ["contributo accesso","tassa di soggiorno","piano del turismo","flussi turistici"], weight: 0.6 },
  { type: "municipal_asset_strategy_signal", tokens: ["piano triennale patrimon","strategia patrimoniale","gestione patrimon"], weight: 0.75 },
  { type: "pre_auction_signal",            tokens: ["asta pubblica","procedura ad evidenza pubblica vendita immobile"], weight: 0.6 },
  { type: "offmarket_campaign_signal",     tokens: ["accordo di programma","piano strategico"], weight: 0.5 },
];

function buildAction(type: EarlySignalType, comune: string): string {
  switch (type) {
    case "pre_alienation_signal":
    case "public_asset_disposal_signal":
      return `Mappare gli immobili in vendita a ${comune} e proporsi come advisor/intermediario per chi cerca asset pubblici dismessi.`;
    case "public_asset_valuation_signal":
    case "municipal_asset_strategy_signal":
      return `Aprire dialogo con ufficio patrimonio di ${comune} e individuare proprietari nelle zone di valorizzazione per campagne valutazione/esclusiva.`;
    case "expression_of_interest_signal":
    case "market_sounding_signal":
      return `Partecipare/segnalare la manifestazione d'interesse per intercettare investitori interessati a ${comune}.`;
    case "concession_or_lease_signal":
      return `Identificare immobili in concessione/locazione: target gestori e investitori commerciali a ${comune}.`;
    case "project_financing_signal":
      return `Monitorare il PPP a ${comune} e contattare proprietà limitrofe per anticipare l'effetto-valore.`;
    case "urban_regeneration_signal":
    case "redevelopment_area_signal":
      return `Avviare campagna acquisizione esclusiva nei quartieri target di rigenerazione a ${comune}.`;
    case "zoning_change_signal":
      return `Verificare variante e contattare proprietari delle aree interessate prima del cambio destinazione d'uso a ${comune}.`;
    case "public_work_impact_signal":
      return `Mappare immobili lungo il tracciato dell'opera pubblica a ${comune} per anticipare effetti su valore percepito.`;
    case "mobility_change_signal":
      return `Identificare microzone di ${comune} servite dalla nuova mobilità: campagna esclusiva mirata.`;
    case "tourism_pressure_early_signal":
      return `Valutare l'effetto turistico su segmento short-let/residenziale a ${comune} e proporsi come consulente.`;
    case "unused_public_property_signal":
      return `Segnalare a investitori immobili pubblici inutilizzati a ${comune} per progetti di riqualificazione.`;
    case "pre_auction_signal":
      return `Anticipare il bando di alienazione pubblica a ${comune} con clienti interessati.`;
    case "offmarket_campaign_signal":
      return `Costruire campagna off-market mirata sull'accordo di programma di ${comune}.`;
  }
}

function buildWhy(type: EarlySignalType, comune: string): string {
  switch (type) {
    case "pre_alienation_signal":
    case "public_asset_disposal_signal":
      return `${comune} sta preparando dismissioni patrimoniali: opportunità di intermediazione e segnale di movimento sul mercato locale.`;
    case "public_asset_valuation_signal":
    case "municipal_asset_strategy_signal":
      return `${comune} pianifica valorizzazioni: aspettative di crescita di valore nelle zone interessate.`;
    case "urban_regeneration_signal":
    case "redevelopment_area_signal":
      return `${comune} avvia rigenerazione: zone target con potenziale apprezzamento e finestra per acquisizione esclusive.`;
    case "zoning_change_signal":
      return `Cambio destinazione d'uso/variante urbanistica a ${comune}: impatto diretto su valore degli immobili.`;
    case "public_work_impact_signal":
    case "mobility_change_signal":
      return `Opera pubblica/mobilità a ${comune}: cambia accessibilità e percezione delle microzone.`;
    case "tourism_pressure_early_signal":
      return `Pressione turistica crescente a ${comune}: opportunità su short-let e investimenti.`;
    case "expression_of_interest_signal":
    case "market_sounding_signal":
      return `Avviso esplorativo a ${comune}: intercettare investitori prima della pubblicazione del bando.`;
    case "concession_or_lease_signal":
      return `Concessione/locazione di immobile pubblico a ${comune}: opportunità per operatori commerciali.`;
    case "project_financing_signal":
      return `${comune} attiva project financing: effetto leva su valore immobiliare di area.`;
    case "unused_public_property_signal":
      return `Patrimonio pubblico inutilizzato a ${comune}: target per riqualificazione/progetti.`;
    case "pre_auction_signal":
      return `Probabile asta pubblica di alienazione a ${comune} in arrivo.`;
    case "offmarket_campaign_signal":
      return `Segnale strategico territoriale a ${comune} utile per campagne off-market mirate.`;
  }
}

export function classifyEarlySignal(input: ClassifierInput, comune: string): ClassifiedEarlySignal {
  const text = `${input.title ?? ""}\n${input.text ?? ""}`;
  const lower = text.toLowerCase();

  // Privacy guard prima di tutto
  const priv = classifySensitiveSource({ url: input.source_url, title: input.title, markdown: input.text });
  if (!priv.allowed) {
    return {
      signal_type: "needs_review",
      timing: "monitoring",
      matched_keywords: [],
      confidence_score: 0,
      quality: "bassa",
      privacy_safe: false,
      privacy_reason: priv.rejected_reason,
      why_it_matters: "",
      possible_agent_action: "",
      summary: "",
      needs_review: true,
    };
  }

  const matches: { rule: Rule; tokens: string[] }[] = [];
  for (const r of RULES) {
    const m = r.tokens.filter((t) => lower.includes(t));
    if (m.length > 0) matches.push({ rule: r, tokens: m });
  }

  if (matches.length === 0) {
    return {
      signal_type: "irrelevant",
      timing: "monitoring",
      matched_keywords: [],
      confidence_score: 0,
      quality: "bassa",
      privacy_safe: true,
      why_it_matters: "",
      possible_agent_action: "",
      summary: "",
      needs_review: false,
    };
  }

  // best rule = max(weight * #matches)
  matches.sort((a, b) => (b.rule.weight ?? 0.5) * b.tokens.length - (a.rule.weight ?? 0.5) * a.tokens.length);
  const best = matches[0];
  const totalMatched = matches.reduce((acc, m) => acc + m.tokens.length, 0);
  const confidence = Math.min(1, ((best.rule.weight ?? 0.5) * Math.min(3, best.tokens.length)) / 3 + Math.min(0.2, totalMatched * 0.02));
  const quality: "alta" | "media" | "bassa" = confidence >= 0.7 ? "alta" : confidence >= 0.4 ? "media" : "bassa";
  const timing: Timing = best.rule.timingHint ?? "early";
  const summary = redactPersonalFields((input.text ?? "").slice(0, 500));

  return {
    signal_type: best.rule.type,
    timing,
    matched_keywords: matches.flatMap((m) => m.tokens).slice(0, 10),
    confidence_score: Number(confidence.toFixed(2)),
    quality,
    privacy_safe: true,
    why_it_matters: buildWhy(best.rule.type, comune),
    possible_agent_action: buildAction(best.rule.type, comune),
    summary,
    needs_review: confidence < 0.6,
  };
}
