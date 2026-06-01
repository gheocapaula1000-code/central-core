// Pure helpers for civiko-agency-opportunities-v2 — extracted so vitest can
// import them WITHOUT pulling Deno-only imports from index.ts.
//
// Keep this file free of any Deno / npm: imports.

import type { AgencyArea, OpportunityAuditResult } from "./audit.ts";

export interface EvidenceCounts {
  area: number;
  microzone: number;
  deal: number;
  auction: number;
  listing: number;
}

export interface FrontendReadiness {
  ready: boolean;
  score: number;
  missing: string[];
  required_actions: string[];
  last_successful_ingestion_at: string | null;
  evidence_counts: EvidenceCounts;
  auto_heal_attempted: boolean;
}

export interface BuildOptions {
  evidence_counts?: EvidenceCounts;
  last_successful_ingestion_at?: string | null;
  auto_heal_attempted?: boolean;
  evidence_rows?: unknown[];
}

export function buildFrontendReadiness(
  data: {
    focus_area: unknown[];
    hot_microzones: unknown[];
    commercial_actions: unknown[];
    deal_opportunities: unknown[];
  },
  opts: BuildOptions = {},
): FrontendReadiness {
  const counts: EvidenceCounts = opts.evidence_counts ?? { area: 0, microzone: 0, deal: 0, auction: 0, listing: 0 };
  const missing: string[] = [];
  const required_actions: string[] = [];

  if ((data.focus_area?.length ?? 0) < 1) {
    missing.push("focus_area");
    if (counts.area === 0) required_actions.push("ingest_area_opportunity_scores");
    else required_actions.push("auto_heal_area_evidence");
  }
  if ((data.hot_microzones?.length ?? 0) < 1) {
    missing.push("hot_microzones");
    if (counts.microzone === 0 && counts.deal === 0) required_actions.push("ingest_microzone_evidence");
  }
  if ((data.commercial_actions?.length ?? 0) < 1) {
    missing.push("commercial_actions");
    required_actions.push("derive_commercial_actions");
  }
  if ((data.deal_opportunities?.length ?? 0) < 1) {
    missing.push("deal_opportunities");
    if (counts.deal === 0 && counts.auction === 0 && counts.listing === 0) {
      required_actions.push("ingest_normalized_opportunities_and_auctions");
    } else {
      required_actions.push("backfill_deal_evidence");
    }
  }

  // Weighted score: deals 40, focus 20, microzones 20, actions 20
  let score = 0;
  if ((data.deal_opportunities?.length ?? 0) > 0) score += 40;
  if ((data.focus_area?.length ?? 0) > 0) score += 20;
  if ((data.hot_microzones?.length ?? 0) > 0) score += 20;
  if ((data.commercial_actions?.length ?? 0) > 0) score += 20;

  return {
    ready: missing.length === 0,
    score,
    missing,
    required_actions: [...new Set(required_actions)],
    last_successful_ingestion_at: opts.last_successful_ingestion_at ?? null,
    evidence_counts: counts,
    auto_heal_attempted: !!opts.auto_heal_attempted,
  };
}


export const DEFAULT_AUDIT = {
  candidates_before_filters: 0,
  removed_insufficient_evidence: 0,
  removed_weak_only: 0,
  removed_restricted: 0,
  removed_outside_scope: 0,
  removed_stale: 0,
  final_opportunities_count: 0,
  confidence_distribution: { low: 0, medium: 0, high: 0 },
  empty_reason: null as string | null,
  area_insights_count: 0,
  commercial_actions_count: 0,
  deal_candidates_before_filters: 0,
  removed_area_only: 0,
  removed_no_actionable_target: 0,
  removed_insufficient_deal_evidence: 0,
  final_deal_opportunities_count: 0,
  removed_outside_comune: 0,
  removed_unmapped_zone: 0,
  removed_zone_mismatch: 0,
  deal_rows_missing_geo: 0,
  deal_rows_inside_comune_unmapped: 0,
  deal_rows_inside_agency_zone: 0,
};

export const EMPTY_PAYLOAD = {
  focus_area: [] as unknown[],
  hot_microzones: [] as unknown[],
  commercial_actions: [] as unknown[],
  deal_opportunities: [] as unknown[],
  opportunities: [] as unknown[],
  audit: DEFAULT_AUDIT,
  frontend_readiness: {
    ready: false,
    score: 0,
    missing: ["focus_area", "hot_microzones", "commercial_actions", "deal_opportunities"],
    required_actions: [],
    last_successful_ingestion_at: null,
    evidence_counts: { area: 0, microzone: 0, deal: 0, auction: 0, listing: 0 },
    auto_heal_attempted: false,
  } satisfies FrontendReadiness,
};


/**
 * Pure response-builder. Given audit result + scope, produce a JSON-safe payload.
 * Defensive against null/undefined fields on `result` so the handler never crashes
 * even if a future audit refactor returns a partial object.
 */
export function buildResponseData(
  result: Partial<OpportunityAuditResult> | null | undefined,
  areaList: AgencyArea[] | null | undefined,
  opts: BuildOptions = {},
) {
  const focus_area_raw = sanitizeArray(result?.focus_area);

  const hot_microzones_raw = sanitizeArray(result?.hot_microzones);
  const commercial_actions_raw = sanitizeArray(result?.commercial_actions);
  const deal_opportunities_raw = sanitizeArray(result?.deal_opportunities);
  const opportunities_raw = Array.isArray(result?.opportunities) ? sanitizeArray(result!.opportunities!) : deal_opportunities_raw;
  const audit = toJsonSafe(result?.audit && typeof result.audit === "object" ? result.audit : DEFAULT_AUDIT);
  const warnings = sanitizeArray(result?.warnings);

  // Enrich with frontend-readable fields derived from REAL signal counts
  // (no fabricated text). title is always populated from the canonical slug.
  const evidenceRows = Array.isArray(opts.evidence_rows) ? opts.evidence_rows : [];
  const comuneAgg = buildComuneEvidenceAggregates(evidenceRows, deal_opportunities_raw, hot_microzones_raw);
  const enrichmentBuckets = buildEnrichmentBuckets(evidenceRows);
  const deal_opportunities = deal_opportunities_raw.map((d) => enrichDealOpportunity(d, enrichmentBuckets));
  const opportunities = opportunities_raw === deal_opportunities_raw
    ? deal_opportunities
    : opportunities_raw.map((d) => enrichDealOpportunity(d, enrichmentBuckets));
  const focus_area = focus_area_raw.map((fa) => enrichFocusArea(fa, comuneAgg));
  const hot_microzones = hot_microzones_raw.map((mz) => enrichHotMicrozone(mz, deal_opportunities, comuneAgg));
  const commercial_actions = commercial_actions_raw.map((a) => enrichCommercialAction(a, hot_microzones));

  const frontend_readiness = buildFrontendReadiness(
    { focus_area, hot_microzones, commercial_actions, deal_opportunities },
    opts,
  );

  const hasDeals = deal_opportunities.length > 0;
  const hasArea = (Array.isArray(focus_area) ? focus_area.length : 0) + hot_microzones.length > 0;
  // Never claim "ok" if readiness is not satisfied — partial covers the gap.
  let data_status: "ok" | "partial" | "empty";
  if (frontend_readiness.ready) data_status = "ok";
  else if (hasDeals || hasArea) data_status = "partial";
  else data_status = "empty";

  const empty_reason = hasDeals
    ? null
    : ((audit as { empty_reason?: string | null })?.empty_reason ?? "no_deal_level_opportunities");
  const message = data_status === "ok"
    ? null
    : data_status === "partial"
      ? "Dati reali presenti ma copertura incompleta."
      : "Nessuna evidenza disponibile per le zone configurate.";

  const safeAreas = (Array.isArray(areaList) ? areaList : []).filter(
    (a): a is AgencyArea => !!a && typeof a === "object",
  );

  return {
    data_status,
    message,
    empty_reason,
    focus_area,
    hot_microzones,
    commercial_actions,
    deal_opportunities,
    opportunities,
    audit,
    warnings,
    frontend_readiness,
    signal_counts: Object.fromEntries(
      [...comuneAgg.entries()].map(([c, a]) => [c, {
        succession_pressure_count: a.succession_pressure_count,
        revaluation_count: a.revaluation_count,
        pressure_total: a.pressure_total,
        velocity_total: a.velocity_total,
        motivated_total: a.motivated_total,
        urgent_total: a.urgent_total,
      }]),
    ),
    scope: {
      comuni: [...new Set(safeAreas.flatMap((a) => (Array.isArray(a.comuni) ? a.comuni : [])))],
      microzones: [
        ...new Set(
          safeAreas.flatMap((a) => [
            ...(Array.isArray(a.microzones) ? a.microzones : []),
            ...(Array.isArray(a.quartieri) ? a.quartieri : []),
          ]),
        ),
      ],
    },
  };
}


export function buildControlledErrorBody(debug_id: string, error_stage?: string, error_message?: string, error_name?: string) {
  return {
    ok: false,
    data_status: "error",
    error_code: "OPPORTUNITY_V2_RUNTIME_ERROR",
    message: "Non riesco a caricare le opportunità in questo momento.",
    debug_id,
    ...(error_stage ? { error_stage } : {}),
    ...(error_name ? { error_name } : {}),
    ...(error_message ? { error_message } : {}),
    ...EMPTY_PAYLOAD,
  };
}

function sanitizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => toJsonSafe(item)) : [];
}

export function toJsonSafe<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v, seen);
  seen.delete(value as object);
  return out;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(toJsonSafe(value));
}

// ---------------------------------------------------------------------------
// Frontend enrichment helpers — populate readable fields the PWA expects.
// No fabricated data: numbers come from deal_opportunities, names from the
// canonical Padova slug map.
// ---------------------------------------------------------------------------

const PADOVA_MZ_DISPLAY: Record<string, string> = {
  "arcella": "Arcella",
  "brusegana": "Brusegana",
  "camin": "Camin",
  "centro storico": "Centro Storico",
  "chiesanuova": "Chiesanuova",
  "forcellini": "Forcellini",
  "guizza": "Guizza",
  "mandria": "Mandria",
  "mortise": "Mortise",
  "pontevigodarzere": "Pontevigodarzere",
  "prato della valle": "Prato della Valle",
  "sacra famiglia": "Sacra Famiglia",
  "sant'osvaldo": "Sant'Osvaldo",
  "stazione": "Stazione",
  "voltabarozzo": "Voltabarozzo",
};

function titleCaseFallback(slug: string): string {
  return slug.split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

function displayMicrozoneName(slug: string): string {
  const key = String(slug ?? "").toLowerCase().trim();
  if (!key) return "Microzona";
  return PADOVA_MZ_DISPLAY[key] ?? titleCaseFallback(key);
}

function displayComuneName(slug: string): string {
  const key = String(slug ?? "").toLowerCase().trim();
  return key ? titleCaseFallback(key) : "";
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? v as Record<string, unknown> : {};
}

function dealEvidenceText(d: Record<string, unknown>): string {
  const es = asRec(d.evidence_summary);
  const parts: string[] = [];
  const fams = es.source_families;
  if (Array.isArray(fams)) parts.push(...fams.map((x) => String(x)));
  const contrib = es.contributing_sources;
  if (Array.isArray(contrib)) parts.push(...contrib.map((x) => String(x)));
  const bullets = es.explanation_bullets;
  if (Array.isArray(bullets)) parts.push(...bullets.map((x) => String(x)));
  if (typeof d.urgency === "string") parts.push(d.urgency);
  return parts.join(" | ").toLowerCase();
}

function slugify(s: unknown): string {
  return String(s ?? "").toLowerCase().trim();
}

interface ComuneAgg {
  pressure_total: number;   // count of all ew:* rows for the comune
  velocity_total: number;   // count of OFFMARKET_DISCOVERY rows
  motivated_total: number;  // count of MOTIVATED_SELLER rows
  urgent_total: number;     // count of rows with urgency=urgent
  ew_leg_total: number;     // ew:* + leg:* combined (for label fallback)
  mz_count: number;         // number of hot_microzones in this comune
  totalDeals: number;       // deal_opportunities tally per comune
  succession_pressure_count: number; // leg:* OR evidence_type SUCCESSION_PRESSURE/LEGAL_EVENT/INHERITANCE_SIGNAL
  revaluation_count: number;         // evidence_type MICROZONE_PRESSURE/VELOCITY_ANOMALY/PRICE_REVALUATION
}

function newAgg(): ComuneAgg {
  return {
    pressure_total: 0, velocity_total: 0, motivated_total: 0, urgent_total: 0,
    ew_leg_total: 0, mz_count: 0, totalDeals: 0,
    succession_pressure_count: 0, revaluation_count: 0,
  };
}

const SUCCESSION_TYPES = new Set(["SUCCESSION_PRESSURE", "LEGAL_EVENT", "INHERITANCE_SIGNAL"]);
const REVALUATION_TYPES = new Set(["MICROZONE_PRESSURE", "VELOCITY_ANOMALY", "PRICE_REVALUATION"]);

function buildComuneEvidenceAggregates(
  evidenceRows: unknown[],
  deals: unknown[],
  hotMzRaw: unknown[],
): Map<string, ComuneAgg> {
  const map = new Map<string, ComuneAgg>();
  const getOrCreate = (c: string) => {
    let a = map.get(c);
    if (!a) { a = newAgg(); map.set(c, a); }
    return a;
  };

  for (const raw of evidenceRows) {
    const r = asRec(raw);
    const k = String(r.entity_key ?? "");
    const t = String(r.evidence_type ?? "");
    const isEw = k.startsWith("ew:");
    const isLeg = k.startsWith("leg:");
    const comune = slugify(k.split(":")[1]);
    if (!comune) continue;
    const agg = getOrCreate(comune);
    if (isEw || isLeg) {
      agg.ew_leg_total++;
      if (isEw) agg.pressure_total++;
      if (t === "OFFMARKET_DISCOVERY") agg.velocity_total++;
      if (t === "MOTIVATED_SELLER") agg.motivated_total++;
      const urgency = slugify(asRec(r.evidence_value).urgency);
      if (urgency === "urgent") agg.urgent_total++;
    }
    if (isLeg || SUCCESSION_TYPES.has(t)) agg.succession_pressure_count++;
    if (REVALUATION_TYPES.has(t)) agg.revaluation_count++;
  }

  for (const d of deals) {
    const dr = asRec(d);
    const idParts = String(dr.id ?? dr.entity_key ?? "").split(":");
    const comune = slugify(idParts[1] ?? dr.municipality ?? "");
    if (!comune) continue;
    getOrCreate(comune).totalDeals++;
  }

  for (const mz of hotMzRaw) {
    const parts = String(asRec(mz).entity_key ?? "").split(":");
    const comune = slugify(parts[1]);
    if (!comune) continue;
    getOrCreate(comune).mz_count++;
  }

  return map;
}

function enrichFocusArea(
  item: unknown,
  comuneAgg: Map<string, ComuneAgg>,
): Record<string, unknown> {
  const obj = { ...asRec(item) };
  const parts = String(obj.entity_key ?? "").split(":");
  const comuneSlug = slugify(parts[1] ?? obj.comune ?? obj.municipality);
  const agg = comuneSlug ? comuneAgg.get(comuneSlug) : undefined;
  return {
    ...obj,
    succession_pressure_count: agg?.succession_pressure_count ?? 0,
    revaluation_count: agg?.revaluation_count ?? 0,
  };
}


function enrichHotMicrozone(
  item: unknown,
  deals: unknown[],
  comuneAgg: Map<string, ComuneAgg>,
): Record<string, unknown> {
  const obj = { ...asRec(item) };
  const parts = String(obj.entity_key ?? "").split(":");
  const comuneSlug = slugify(parts[1]);
  const mzSlug = slugify(parts[2]);
  const title = displayMicrozoneName(mzSlug);

  const mzDeals = deals.filter((d) => {
    const dr = asRec(d);
    const mz = slugify(dr.microzone);
    return mz === mzSlug;
  }).map((d) => asRec(d));

  const auctions = mzDeals.filter((d) => d.target_type === "auction").length;
  const listings = mzDeals.filter((d) => d.target_type === "listing").length;
  const others = mzDeals.length - auctions - listings;

  // Per-microzone counters derived by even distribution of comune-level
  // ew:/leg: evidence. Math.max(1, ...) for pressure/velocity ensures the UI
  // shows the comune-level signal exists even if not geolocalized.
  const agg = comuneAgg.get(comuneSlug);
  const mzCount = Math.max(1, agg?.mz_count ?? 1);
  let pressure_signals = 0;
  let velocity_signals = 0;
  let motivated_sellers = 0;
  let urgent_count = 0;
  if (agg) {
    if (agg.pressure_total > 0) {
      pressure_signals = Math.max(1, Math.round(agg.pressure_total / mzCount));
    }
    if (agg.velocity_total > 0) {
      velocity_signals = Math.max(1, Math.round(agg.velocity_total / mzCount));
    }
    motivated_sellers = Math.floor(agg.motivated_total / mzCount);
    urgent_count = Math.floor(agg.urgent_total / mzCount);
  }

  const signals: string[] = [];
  if (auctions > 0) signals.push(`${auctions} ast${auctions === 1 ? "a giudiziaria" : "e giudiziarie"}`);
  if (listings > 0) signals.push(`${listings} annunc${listings === 1 ? "io attivo" : "i attivi"}`);
  if (others > 0) signals.push(`${others} altr${others === 1 ? "o segnale" : "i segnali"}`);

  // top_signal_label:
  //  - no ew:/leg: evidence at comune-level → "Zona monitorata attivamente"
  //  - mz has more deals than the comune avg → "Pressione acquirenti rilevata"
  //  - distributed motivated > 0 → "Venditore motivato identificato"
  //  - otherwise → "Attività offmarket rilevata"
  let top_signal_label: string;
  if (!agg || agg.ew_leg_total === 0) {
    top_signal_label = "Zona monitorata attivamente";
  } else {
    const avgDeals = (agg.mz_count || 0) > 0 ? agg.totalDeals / agg.mz_count : 0;
    if (avgDeals > 0 && mzDeals.length > avgDeals) {
      top_signal_label = "Pressione acquirenti rilevata";
    } else if (motivated_sellers > 0) {
      top_signal_label = "Venditore motivato identificato";
    } else {
      top_signal_label = "Attività offmarket rilevata";
    }
  }

  let summary = "";
  if (mzDeals.length > 0) {
    summary = `${signals.join(" e ")} rilevat${mzDeals.length === 1 ? "o" : "i"} in zona.`;
  } else {
    const bullets = asRec(obj.evidence_summary).explanation_bullets;
    if (Array.isArray(bullets) && bullets.length > 0 && typeof bullets[0] === "string") {
      summary = String(bullets[0]).replace(/^\[[^\]]+\]\s*/, "");
    }
  }



  let next_action: string;
  if (urgent_count > 0) next_action = "Contatta subito le opportunità urgenti rilevate";
  else if (motivated_sellers > 0) next_action = "Qualifica i venditori motivati segnalati";
  else if (auctions > 0) next_action = "Prepara dossier acquirenti per le aste in calendario";
  else if (velocity_signals > 0) next_action = "Verifica annunci con calo prezzo rapido";
  else if (listings > 0) next_action = "Contatta proprietari/agenzie degli annunci in zona";
  else if (mzDeals.length > 0) next_action = "Qualifica i segnali rilevati e pianifica il presidio";
  else next_action = "Avvia presidio territoriale su questa microzona";

  return {
    ...obj,
    title,
    name: title,
    microzone: title,
    comune: displayComuneName(comuneSlug),
    area_label: comuneSlug ? `${title} · ${displayComuneName(comuneSlug)}` : title,
    summary,
    signals,
    next_action,
    pressure_signals,
    velocity_signals,
    motivated_sellers,
    urgent_count,
    top_signal_label,
  };
}

function actionCtaFor(action_code: string): { cta_label: string; cta_to: string } {
  switch (action_code) {
    case "monitora_aste": return { cta_label: "Vedi aste", cta_to: "/opportunita?filter=auction" };
    case "verifica_annunci_prezzo": return { cta_label: "Vedi annunci", cta_to: "/opportunita?filter=listing" };
    case "confronta_omi": return { cta_label: "Apri benchmark OMI", cta_to: "/opportunita?view=market" };
    case "presidia_microzone_attive": return { cta_label: "Apri microzone calde", cta_to: "/opportunita?view=microzones" };
    default: return { cta_label: "Apri", cta_to: "/opportunita" };
  }
}

function enrichCommercialAction(item: unknown, hot: unknown[]): Record<string, unknown> {
  const obj = { ...asRec(item) };
  const parts = String(obj.entity_key ?? "").split(":");
  const granularity = obj.entity_granularity;
  let area_label: string;
  if (granularity === "microzone") {
    area_label = `${displayMicrozoneName(parts[2] ?? "")}${parts[1] ? " · " + displayComuneName(parts[1]) : ""}`;
  } else {
    area_label = displayComuneName(parts[1] ?? "") || "Area operativa";
  }
  const title = typeof obj.label === "string" && obj.label.trim() ? String(obj.label) : "Azione consigliata";
  const description = typeof obj.rationale === "string" && obj.rationale.trim()
    ? String(obj.rationale)
    : (hot.length > 0 ? "Suggerimento derivato dai segnali aggregati di zona." : "");
  const { cta_label, cta_to } = actionCtaFor(String(obj.action_code ?? ""));
  return { ...obj, title, area_label, description, cta_label, cta_to };
}



// ---------------------------------------------------------------------------
// Opportunity enrichment — 4 contract-extension fields:
//   environmental_data, market_sentiment, urban_development, offmarket_signals
// All fields tolerate missing data: null (objects) or [] (signals array).
// ---------------------------------------------------------------------------

export interface EnvironmentalData {
  brownfield_count: number;
  demolition_count: number;
  transformation_count: number;
  last_observed_at: string | null;
  sources: string[];
}

export interface MarketSentiment {
  pressure_score: number;          // 0..100, derived from MICROZONE_PRESSURE + area_opportunity_score
  stale_listings: number;
  velocity_anomalies: number;
  delisted_count: number;
  trend: "rising" | "stable" | "cooling" | "unknown";
  last_observed_at: string | null;
}

export interface UrbanDevelopment {
  active_sites: number;            // cantiere_edilizio
  transformation_areas: number;    // area_trasformazione
  concession_signals: number;      // CONCESSION_OR_LEASE_SIGNAL
  demographic_signals: number;     // segnale_demografico
  last_observed_at: string | null;
  sources: string[];
}

export interface OffmarketSignal {
  type: string;
  observed_at: string | null;
  source_code: string | null;
  explanation: string | null;
}

interface EnrichmentBucket {
  environmental_data: EnvironmentalData | null;
  market_sentiment: MarketSentiment | null;
  urban_development: UrbanDevelopment | null;
  offmarket_signals: OffmarketSignal[];
}

const ENV_TYPES = new Set(["brownfield", "demolizione", "area_trasformazione"]);
const SENTIMENT_TYPES = new Set([
  "MICROZONE_PRESSURE", "listing_velocity", "STALE_LISTING",
  "listing_ping_state", "listing_delisted", "area_opportunity_score",
]);
const URBAN_TYPES = new Set([
  "cantiere_edilizio", "area_trasformazione",
  "CONCESSION_OR_LEASE_SIGNAL", "segnale_demografico",
]);
const OFFMARKET_TYPES = new Set([
  "OFFMARKET_DISCOVERY", "offmarket_potential",
  "succession_pressure", "POSSIBLE_SUCCESSION_SIGNAL",
  "AUCTION_CONFIRMATION",
]);

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function bucketKey(comune: string, microzone: string | null): string {
  return microzone ? `${comune}::${microzone}` : `${comune}::*`;
}

function buildEnrichmentBuckets(evidenceRows: unknown[]): Map<string, EnrichmentBucket> {
  const map = new Map<string, EnrichmentBucket>();
  const ensure = (key: string): EnrichmentBucket => {
    let b = map.get(key);
    if (!b) {
      b = {
        environmental_data: null,
        market_sentiment: null,
        urban_development: null,
        offmarket_signals: [],
      };
      map.set(key, b);
    }
    return b;
  };

  for (const raw of evidenceRows) {
    const r = asRec(raw);
    const k = String(r.entity_key ?? "");
    const parts = k.split(":");
    const comune = slugify(parts[1]);
    if (!comune) continue;
    const microzone = parts[2] ? slugify(parts[2]) : null;
    const evType = String(r.evidence_type ?? "");
    const sourceCode = typeof r.source_code === "string" ? r.source_code : null;
    const observedAt = typeof r.observed_at === "string" ? r.observed_at : null;
    const explanation = typeof r.explanation === "string" ? r.explanation : null;

    const targets: EnrichmentBucket[] = [ensure(bucketKey(comune, null))];
    if (microzone) targets.push(ensure(bucketKey(comune, microzone)));

    for (const b of targets) {
      if (ENV_TYPES.has(evType)) {
        if (!b.environmental_data) {
          b.environmental_data = { brownfield_count: 0, demolition_count: 0, transformation_count: 0, last_observed_at: null, sources: [] };
        }
        if (evType === "brownfield") b.environmental_data.brownfield_count++;
        if (evType === "demolizione") b.environmental_data.demolition_count++;
        if (evType === "area_trasformazione") b.environmental_data.transformation_count++;
        b.environmental_data.last_observed_at = laterIso(b.environmental_data.last_observed_at, observedAt);
        if (sourceCode && !b.environmental_data.sources.includes(sourceCode)) b.environmental_data.sources.push(sourceCode);
      }
      if (SENTIMENT_TYPES.has(evType)) {
        if (!b.market_sentiment) {
          b.market_sentiment = { pressure_score: 0, stale_listings: 0, velocity_anomalies: 0, delisted_count: 0, trend: "unknown", last_observed_at: null };
        }
        if (evType === "MICROZONE_PRESSURE") b.market_sentiment.pressure_score = Math.min(100, b.market_sentiment.pressure_score + 20);
        if (evType === "area_opportunity_score") {
          const v = Number(asRec(r.evidence_value).score ?? asRec(r.evidence_value).value ?? 0);
          if (Number.isFinite(v) && v > 0) b.market_sentiment.pressure_score = Math.max(b.market_sentiment.pressure_score, Math.min(100, Math.round(v)));
        }
        if (evType === "STALE_LISTING") b.market_sentiment.stale_listings++;
        if (evType === "listing_velocity") b.market_sentiment.velocity_anomalies++;
        if (evType === "listing_delisted") b.market_sentiment.delisted_count++;
        b.market_sentiment.last_observed_at = laterIso(b.market_sentiment.last_observed_at, observedAt);
      }
      if (URBAN_TYPES.has(evType)) {
        if (!b.urban_development) {
          b.urban_development = { active_sites: 0, transformation_areas: 0, concession_signals: 0, demographic_signals: 0, last_observed_at: null, sources: [] };
        }
        if (evType === "cantiere_edilizio") b.urban_development.active_sites++;
        if (evType === "area_trasformazione") b.urban_development.transformation_areas++;
        if (evType === "CONCESSION_OR_LEASE_SIGNAL") b.urban_development.concession_signals++;
        if (evType === "segnale_demografico") b.urban_development.demographic_signals++;
        b.urban_development.last_observed_at = laterIso(b.urban_development.last_observed_at, observedAt);
        if (sourceCode && !b.urban_development.sources.includes(sourceCode)) b.urban_development.sources.push(sourceCode);
      }
      if (OFFMARKET_TYPES.has(evType)) {
        b.offmarket_signals.push({ type: evType, observed_at: observedAt, source_code: sourceCode, explanation });
      }
    }
  }

  // Finalize trend on market_sentiment using pressure_score vs velocity/delisting.
  for (const b of map.values()) {
    if (b.market_sentiment) {
      const ms = b.market_sentiment;
      if (ms.pressure_score >= 60 && ms.velocity_anomalies > 0) ms.trend = "rising";
      else if (ms.stale_listings > ms.velocity_anomalies && ms.stale_listings > 0) ms.trend = "cooling";
      else if (ms.pressure_score > 0 || ms.velocity_anomalies > 0) ms.trend = "stable";
    }
    // Cap offmarket_signals to most recent 10 per bucket.
    if (b.offmarket_signals.length > 1) {
      b.offmarket_signals.sort((a, c) => String(c.observed_at ?? "").localeCompare(String(a.observed_at ?? "")));
      b.offmarket_signals = b.offmarket_signals.slice(0, 10);
    }
  }

  return map;
}

export function enrichDealOpportunity(
  item: unknown,
  buckets: Map<string, EnrichmentBucket>,
): Record<string, unknown> {
  const obj = { ...asRec(item) };
  const parts = String(obj.entity_key ?? obj.id ?? "").split(":");
  const comune = slugify(parts[1] ?? obj.municipality);
  const microzone = slugify(obj.microzone ?? parts[2]);

  let bucket: EnrichmentBucket | undefined;
  if (comune && microzone) {
    bucket = buckets.get(bucketKey(comune, microzone));
  } else if (comune) {
    bucket = buckets.get(bucketKey(comune, null));
  }

  return {
    ...obj,
    environmental_data: bucket?.environmental_data ?? null,
    market_sentiment: bucket?.market_sentiment ?? null,
    urban_development: bucket?.urban_development ?? null,
    offmarket_signals: bucket ? bucket.offmarket_signals : [],
  };
}

