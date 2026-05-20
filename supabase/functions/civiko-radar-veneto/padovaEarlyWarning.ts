// ═══════════════════════════════════════════════════════════════
// Padova Early Warning Aggregator
// Cross-source signal aggregator for acquisition early-warning.
//
// HARD RULES:
//  - No invented data; only joins existing real signals.
//  - No personal data; skip sources flagged sensitive.
//  - Auction signals are CONFIRMATION ONLY (never primary).
//  - Each opportunity is rebuilt fully each run (idempotent upsert).
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const COMUNE = "Padova";
const PROV = "PD";

const SIGNAL_WEIGHTS: Record<string, number> = {
  // anticipatori
  giacenza_lunga: 30,
  omi_gap_alto: 28,
  omi_gap_basso: 22,
  ribasso: 26,
  cluster_ribassi: 32,
  cross_portal_reappear: 26,
  price_jump_after_disappear: 24,
  agency_swap: 18,
  duplicate_listing: 12,
  stock_anomalo: 16,
  // velocity (early indicators only)
  velocity_stale: 24,
  velocity_repost: 28,
  velocity_price_drop: 26,
  velocity_fresh: 6,
  // motivated seller (drops over time)
  motivated_seller: 30,
  // offmarket
  offmarket_promoted: 24,
  // legal/aste — solo conferma
  auction_confirmation: 12,
  inheritance_aggregate: 10,
  // legal & life-event layer (privacy-safe)
  foreclosure_signal: 34,
  pre_auction_signal: 30,
  public_notice_signal: 14,
  possible_succession_signal: 10,
  public_asset_disposal: 22,
  municipal_property_signal: 18,
  urban_planning_signal: 16,
  concession_or_lease_signal: 16,
};

const PRIMARY_PRIORITY = [
  "MULTISOURCE_DISTRESS",
  "PRICE_DROP_DISTRESS",
  "RELISTING_PATTERN",
  "STALE_LISTING",
  "OMI_MISPRICING",
  "MICROZONE_PRESSURE",
  "OFFMARKET_DISCOVERY",
  "POSSIBLE_INHERITANCE_SIGNAL",
  "AUCTION_CONFIRMATION",
];

interface RawSignal {
  identity_hash?: string | null;
  type: string;            // internal weight key
  source: string;          // source_name
  source_url?: string | null;
  weight: number;
  payload?: Record<string, unknown>;
  privacy_safe: boolean;
}

interface Aggregate {
  identity_hash: string | null;
  comune: string;
  provincia: string;
  microzona: string | null;
  area_label: string | null;
  property_type: string | null;
  signals: RawSignal[];
}

function clean(s: unknown): string | null {
  if (s == null) return null;
  const v = String(s).trim();
  return v.length ? v : null;
}

function pickPrimary(types: Set<string>, signals: RawSignal[]): string {
  // Multi-source listing-level → MULTISOURCE_DISTRESS
  const sourceSet = new Set(signals.map((s) => s.source));
  if (sourceSet.size >= 2 && signals.length >= 3) return "MULTISOURCE_DISTRESS";
  if (types.has("velocity_price_drop") || types.has("ribasso") || types.has("cluster_ribassi")) return "PRICE_DROP_DISTRESS";
  if (types.has("velocity_repost") || types.has("cross_portal_reappear") || types.has("price_jump_after_disappear")) return "RELISTING_PATTERN";
  if (types.has("velocity_stale") || types.has("giacenza_lunga")) return "STALE_LISTING";
  if (types.has("omi_gap_alto") || types.has("omi_gap_basso")) return "OMI_MISPRICING";
  if (types.has("stock_anomalo")) return "MICROZONE_PRESSURE";
  if (types.has("offmarket_promoted")) return "OFFMARKET_DISCOVERY";
  if (types.has("inheritance_aggregate")) return "POSSIBLE_INHERITANCE_SIGNAL";
  if (types.has("auction_confirmation")) return "AUCTION_CONFIRMATION";
  if (types.has("agency_swap") || types.has("motivated_seller")) return "MICROZONE_PRESSURE";
  return PRIMARY_PRIORITY[PRIMARY_PRIORITY.length - 1];
}

function fingerprintFor(agg: Aggregate): string {
  const base = agg.identity_hash ?? `${agg.comune}|${agg.area_label ?? ""}|${agg.signals.map((s) => s.type).sort().join(",")}`;
  return `ewo|padova|${base}`;
}

function scoreFor(signals: RawSignal[]): { score: number; confidence: string } {
  const sumWeights = signals.reduce((a, s) => a + (s.weight || 0), 0);
  const sourceSet = new Set(signals.map((s) => s.source));
  const sourcesBonus = Math.min(40, (sourceSet.size - 1) * 15);
  const evidenceBonus = Math.min(20, Math.max(0, signals.length - 1) * 4);
  // Auction-only should not dominate
  const onlyAuction = signals.every((s) => s.type === "auction_confirmation");
  const auctionPenalty = onlyAuction ? -20 : 0;
  const allPrivacySafe = signals.every((s) => s.privacy_safe);
  const score = Math.min(100, Math.round(Math.max(0, sumWeights * 0.7 + sourcesBonus + evidenceBonus + auctionPenalty)));
  // HIGH-CONFIDENCE policy (commercial gate):
  //   evidence_count >= 3 AND sources_count >= 2 AND privacy_safe
  //   AND not auction-only AND not single-perplexity-only AND not single-stale-only
  const onlyPerplexity = signals.every((s) => /perplex/i.test(s.source));
  const singleStaleOnly = signals.length === 1 && signals[0].type === "velocity_stale";
  let confidence: string;
  const highEligible =
    signals.length >= 3 &&
    sourceSet.size >= 2 &&
    allPrivacySafe &&
    !onlyAuction &&
    !onlyPerplexity &&
    !singleStaleOnly;
  if (highEligible && (sourceSet.size >= 3 || (sourceSet.size >= 2 && signals.length >= 4))) confidence = "alta";
  else if (sourceSet.size >= 2 || signals.length >= 3) confidence = "media";
  else confidence = "bassa";
  if (onlyAuction || onlyPerplexity) confidence = "bassa";
  return { score, confidence };
}

function recommendedActionFor(primary: string): string {
  switch (primary) {
    case "MULTISOURCE_DISTRESS": return "Contatto agenzia attuale + due diligence prezzo: leva alta su trattativa.";
    case "PRICE_DROP_DISTRESS":  return "Valutare offerta a ribasso entro 7 giorni; verificare ipoteche/iscrizioni.";
    case "RELISTING_PATTERN":    return "Aprire dialogo con venditore: probabile fatigue, finestra trattativa aperta.";
    case "STALE_LISTING":        return "Proporre mandato in esclusiva con pricing review OMI.";
    case "OMI_MISPRICING":       return "Verificare scostamento OMI: opportunità di acquisto o errore di pricing.";
    case "MICROZONE_PRESSURE":   return "Monitorare microzona: pressione di mercato, possibile finestra a 30-60gg.";
    case "OFFMARKET_DISCOVERY":  return "Approfondire fonte pubblica (bando/concessione) per opportunità non in vetrina.";
    case "POSSIBLE_INHERITANCE_SIGNAL": return "Segnale aggregato area: usare solo come prior, non come azione diretta.";
    case "AUCTION_CONFIRMATION": return "Asta pubblica: usare come conferma di distress, non come canale primario.";
    default: return "Approfondire manualmente.";
  }
}

function explanationFor(signals: RawSignal[], primary: string): string {
  const sourceSet = new Set(signals.map((s) => s.source));
  const types = signals.map((s) => s.type).join(", ");
  return `${primary} con ${signals.length} segnali da ${sourceSet.size} fonti: ${types}.`;
}

// ─────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────
async function loadListingMeta(sb: SupabaseClient): Promise<Map<string, { microzone: string | null; area_label: string | null; property_type: string | null; url: string | null; source: string | null }>> {
  const map = new Map<string, any>();
  const { data } = await sb
    .from("listing_price_snapshots")
    .select("identity_hash, url, source, property_type, raw_address")
    .ilike("municipality", COMUNE)
    .not("identity_hash", "is", null)
    .limit(2000);
  for (const r of (data ?? []) as any[]) {
    if (!r.identity_hash) continue;
    if (!map.has(r.identity_hash)) {
      map.set(r.identity_hash, {
        microzone: null,
        area_label: r.raw_address ?? null,
        property_type: r.property_type ?? null,
        url: r.url ?? null,
        source: r.source ?? null,
      });
    }
  }
  return map;
}

export interface PadovaEarlyWarningRequest {
  dryRun?: boolean;
}

export interface PadovaEarlyWarningResult {
  ok: boolean;
  dry_run: boolean;
  started_at: string;
  ended_at: string;
  comune: string;
  candidates: number;
  upserted: number;
  multi_source: number;
  high_confidence: number;
  non_auction: number;
  by_primary: Record<string, number>;
  rejected: number;
  rejected_reasons: Record<string, number>;
  samples: Array<Record<string, unknown>>;
  warnings: string[];
}

export async function runPadovaEarlyWarning(req: PadovaEarlyWarningRequest = {}): Promise<PadovaEarlyWarningResult> {
  const startedAt = new Date().toISOString();
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const warnings: string[] = [];
  const rejected_reasons: Record<string, number> = {};
  const rejectCount = (k: string) => { rejected_reasons[k] = (rejected_reasons[k] ?? 0) + 1; };

  const runStart = await sb.from("ingestion_runs").insert({
    job_name: "build-padova-early-warning",
    source_name: "internal_aggregator",
    status: "started",
  }).select("id").maybeSingle();
  const runId = (runStart.data as any)?.id ?? null;

  const listingMeta = await loadListingMeta(sb);

  // Build per-identity_hash aggregates
  const aggMap = new Map<string, Aggregate>();
  const getAgg = (key: string, base: Partial<Aggregate>): Aggregate => {
    let a = aggMap.get(key);
    if (!a) {
      a = {
        identity_hash: base.identity_hash ?? null,
        comune: COMUNE,
        provincia: PROV,
        microzona: base.microzona ?? null,
        area_label: base.area_label ?? null,
        property_type: base.property_type ?? null,
        signals: [],
      };
      aggMap.set(key, a);
    }
    return a;
  };

  // market_anomalies
  const { data: anomalies } = await sb
    .from("market_anomalies")
    .select("anomaly_type, confidence, identity_hash, payload")
    .ilike("municipality", COMUNE)
    .eq("is_active", true);
  for (const r of (anomalies ?? []) as any[]) {
    if (!r.identity_hash) continue;
    const key = `lh:${r.identity_hash}`;
    const meta = listingMeta.get(r.identity_hash) ?? {};
    const agg = getAgg(key, { identity_hash: r.identity_hash, area_label: meta.area_label, property_type: meta.property_type });
    const w = SIGNAL_WEIGHTS[r.anomaly_type] ?? 10;
    agg.signals.push({
      identity_hash: r.identity_hash,
      type: r.anomaly_type,
      source: "market_anomalies",
      source_url: meta.url ?? null,
      weight: r.confidence === "high" ? w : Math.round(w * 0.7),
      payload: r.payload ?? {},
      privacy_safe: true,
    });
  }

  // listing_velocity_signals — only early indicators count strongly
  const { data: velocity } = await sb
    .from("listing_velocity_signals")
    .select("identity_hash:listing_hash, source_name, source_url, velocity_type, stale_listing, repost_detected, price_drop_percent, fresh_listing, payload")
    .ilike("comune", COMUNE)
    .eq("is_active", true);
  for (const r of (velocity ?? []) as any[]) {
    const ih = r.identity_hash ?? null;
    if (!ih) continue;
    const key = `lh:${ih}`;
    const meta = listingMeta.get(ih) ?? {};
    const agg = getAgg(key, { identity_hash: ih, area_label: meta.area_label, property_type: meta.property_type });
    let type = "velocity_fresh";
    if (r.price_drop_percent && Number(r.price_drop_percent) >= 5) type = "velocity_price_drop";
    else if (r.repost_detected) type = "velocity_repost";
    else if (r.stale_listing) type = "velocity_stale";
    else if (r.fresh_listing) type = "velocity_fresh";
    agg.signals.push({
      identity_hash: ih,
      type,
      source: r.source_name ?? "listing_velocity",
      source_url: r.source_url ?? meta.url ?? null,
      weight: SIGNAL_WEIGHTS[type] ?? 6,
      payload: r.payload ?? {},
      privacy_safe: true,
    });
  }

  // motivated_sellers (real only)
  const { data: motivated } = await sb
    .from("motivated_sellers")
    .select("identity_hash, source, url, fatigue_score, fatigue_label, days_online, drops_count, payload")
    .ilike("municipality", COMUNE)
    .eq("is_active", true)
    .neq("source", "seed_demo_veneto");
  for (const r of (motivated ?? []) as any[]) {
    const ih = r.identity_hash;
    if (!ih) continue;
    const key = `lh:${ih}`;
    const meta = listingMeta.get(ih) ?? {};
    const agg = getAgg(key, { identity_hash: ih, area_label: meta.area_label, property_type: meta.property_type });
    agg.signals.push({
      identity_hash: ih,
      type: "motivated_seller",
      source: r.source ?? "motivated_sellers",
      source_url: r.url ?? meta.url ?? null,
      weight: SIGNAL_WEIGHTS.motivated_seller,
      payload: r.payload ?? {},
      privacy_safe: true,
    });
  }

  // auction_signals — CONFIRMATION only
  const { data: auctions } = await sb
    .from("auction_signals")
    .select("source_name, source_url, fingerprint, payload, property_type")
    .ilike("municipality", COMUNE)
    .eq("is_active", true);
  for (const r of (auctions ?? []) as any[]) {
    const key = `auc:${r.fingerprint}`;
    const agg = getAgg(key, { identity_hash: null, area_label: clean(r.payload?.address) ?? null, property_type: r.property_type ?? null });
    agg.signals.push({
      identity_hash: null,
      type: "auction_confirmation",
      source: r.source_name ?? "auction",
      source_url: r.source_url ?? null,
      weight: SIGNAL_WEIGHTS.auction_confirmation,
      payload: r.payload ?? {},
      privacy_safe: true,
    });
  }

  // early_offmarket promoted
  const { data: offmarket } = await sb
    .from("early_offmarket_signal_candidates")
    .select("title, source_name, source_url, signal_type, comune, payload, privacy_safe")
    .ilike("comune", COMUNE)
    .eq("status", "promoted")
    .neq("signal_type", "irrelevant");
  for (const r of (offmarket ?? []) as any[]) {
    if (r.privacy_safe === false) { rejectCount("offmarket_not_privacy_safe"); continue; }
    const key = `off:${r.source_url ?? r.title}`;
    const agg = getAgg(key, { identity_hash: null, area_label: clean(r.title) });
    agg.signals.push({
      identity_hash: null,
      type: "offmarket_promoted",
      source: r.source_name ?? "offmarket",
      source_url: r.source_url ?? null,
      weight: SIGNAL_WEIGHTS.offmarket_promoted,
      payload: r.payload ?? {},
      privacy_safe: true,
    });
  }

  // inheritance_pressure_signals (aggregate)
  const { data: inheritance } = await sb
    .from("inheritance_pressure_signals")
    .select("area_label, microzona, source_urls, source_names, indicators, score")
    .ilike("comune", COMUNE)
    .eq("is_active", true);
  for (const r of (inheritance ?? []) as any[]) {
    const key = `inh:${r.area_label ?? "padova"}`;
    const agg = getAgg(key, { identity_hash: null, area_label: r.area_label ?? null, microzona: r.microzona ?? null });
    agg.signals.push({
      identity_hash: null,
      type: "inheritance_aggregate",
      source: (r.source_names && r.source_names[0]) ?? "inheritance_aggregate",
      source_url: (r.source_urls && r.source_urls[0]) ?? null,
      weight: SIGNAL_WEIGHTS.inheritance_aggregate,
      payload: { indicators: r.indicators ?? {}, score: r.score ?? null },
      privacy_safe: true,
    });
  }

  // legal_life_event_signals — privacy-safe legal & life-event layer
  const { data: lle } = await sb
    .from("legal_life_event_signals")
    .select("signal_type, source_name, source_url, area_or_microzone, confidence, privacy_safe, pii_redacted, contains_personal_data, dedupe_key, payload_minimized")
    .ilike("municipality", COMUNE)
    .eq("is_active", true)
    .eq("privacy_safe", true)
    .eq("pii_redacted", true)
    .eq("contains_personal_data", false)
    .range(0, 999);
  for (const r of (lle ?? []) as any[]) {
    const t = String(r.signal_type ?? "").toLowerCase();
    const weight = SIGNAL_WEIGHTS[t] ?? 12;
    // Group by area: legal/life-event are area-level signals; auctions group with auction key
    const key = t === "auction_confirmation"
      ? `auc:${r.dedupe_key}`
      : `lle:${r.area_or_microzone ?? "padova"}`;
    const agg = getAgg(key, { identity_hash: null, area_label: r.area_or_microzone ?? null });
    agg.signals.push({
      identity_hash: null,
      type: t,
      source: r.source_name ?? "legal_life_event",
      source_url: r.source_url ?? null,
      weight: r.confidence === "alta" ? weight : (r.confidence === "media" ? Math.round(weight * 0.85) : Math.round(weight * 0.6)),
      payload: r.payload_minimized ?? {},
      privacy_safe: true,
    });
  }
  const rows: any[] = [];
  let multiSource = 0;
  let highConfidence = 0;
  let nonAuction = 0;
  const byPrimary: Record<string, number> = {};
  const samples: Array<Record<string, unknown>> = [];

  for (const agg of aggMap.values()) {
    if (agg.signals.length === 0) { rejectCount("no_signals"); continue; }
    const types = new Set(agg.signals.map((s) => s.type));
    const primary = pickPrimary(types, agg.signals);
    const { score, confidence } = scoreFor(agg.signals);
    if (score < 15) { rejectCount("score_too_low"); continue; }

    const sourceSet = new Set(agg.signals.map((s) => s.source));
    const isMultiSource = sourceSet.size >= 2;
    const isAuctionOnly = agg.signals.every((s) => s.type === "auction_confirmation");
    const warns: string[] = [];
    if (isAuctionOnly) warns.push("Solo conferma asta: segnale debole come driver primario.");
    if (sourceSet.size < 2) warns.push("Singola fonte: confidence limitata.");

    const fingerprint = fingerprintFor(agg);
    const title = primary === "AUCTION_CONFIRMATION"
      ? `Conferma asta a Padova${agg.area_label ? " · " + agg.area_label : ""}`
      : primary === "OFFMARKET_DISCOVERY"
      ? `Opportunità off-market a Padova${agg.area_label ? " · " + agg.area_label : ""}`
      : primary === "POSSIBLE_INHERITANCE_SIGNAL"
      ? `Pressione successoria area Padova${agg.area_label ? " · " + agg.area_label : ""}`
      : `${primary.replace(/_/g, " ").toLowerCase()} a Padova${agg.area_label ? " · " + agg.area_label : ""}`;

    const row = {
      fingerprint,
      title,
      region: "veneto",
      provincia: PROV,
      comune: COMUNE,
      microzona: agg.microzona,
      area_label: agg.area_label,
      property_type: agg.property_type,
      identity_hash: agg.identity_hash,
      primary_signal_type: primary,
      signal_types: Array.from(types),
      secondary_signals: agg.signals
        .filter((s) => s.type !== primary)
        .map((s) => ({ type: s.type, source: s.source })),
      evidence_count: agg.signals.length,
      sources_count: sourceSet.size,
      source_names: Array.from(sourceSet),
      source_urls: Array.from(new Set(agg.signals.map((s) => s.source_url).filter(Boolean))) as string[],
      early_acquisition_score: score,
      confidence,
      explanation: explanationFor(agg.signals, primary),
      recommended_action: recommendedActionFor(primary),
      warnings: warns,
      privacy_safe: true,
      is_active: true,
      payload: { signals: agg.signals.map((s) => ({ type: s.type, source: s.source, weight: s.weight })) },
      updated_at: new Date().toISOString(),
    };
    rows.push(row);

    byPrimary[primary] = (byPrimary[primary] ?? 0) + 1;
    if (isMultiSource) multiSource++;
    if (confidence === "alta") highConfidence++;
    if (primary !== "AUCTION_CONFIRMATION") nonAuction++;
    if (samples.length < 3 && primary !== "AUCTION_CONFIRMATION") {
      samples.push({
        title: row.title,
        primary: row.primary_signal_type,
        score: row.early_acquisition_score,
        confidence: row.confidence,
        evidence_count: row.evidence_count,
        sources_count: row.sources_count,
        sources: row.source_names,
        explanation: row.explanation,
        recommended_action: row.recommended_action,
      });
    }
  }

  let upserted = 0;
  if (!req.dryRun && rows.length > 0) {
    // Upsert in chunks
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error, count } = await sb
        .from("early_warning_opportunities")
        .upsert(chunk, { onConflict: "fingerprint", count: "exact" });
      if (error) { warnings.push(`upsert: ${error.message}`); }
      else { upserted += count ?? chunk.length; }
    }
    // Mark older opportunities not refreshed in this run as inactive
    const fps = rows.map((r) => r.fingerprint);
    if (fps.length > 0) {
      await sb
        .from("early_warning_opportunities")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("comune", COMUNE)
        .not("fingerprint", "in", `(${fps.map((f) => `"${f}"`).join(",")})`);
    }
  }

  const endedAt = new Date().toISOString();
  if (runId) {
    await sb.from("ingestion_runs").update({
      status: "completed",
      completed_at: endedAt,
      rows_in: aggMap.size,
      rows_out: upserted,
      duration_ms: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      report: { candidates: rows.length, upserted, multi_source: multiSource, high_confidence: highConfidence, non_auction: nonAuction, by_primary: byPrimary, dry_run: req.dryRun === true },
      warnings,
    }).eq("id", runId);
  }

  return {
    ok: true,
    dry_run: req.dryRun === true,
    started_at: startedAt,
    ended_at: endedAt,
    comune: COMUNE,
    candidates: rows.length,
    upserted,
    multi_source: multiSource,
    high_confidence: highConfidence,
    non_auction: nonAuction,
    by_primary: byPrimary,
    rejected: Object.values(rejected_reasons).reduce((a, b) => a + b, 0),
    rejected_reasons,
    samples,
    warnings,
  };
}
