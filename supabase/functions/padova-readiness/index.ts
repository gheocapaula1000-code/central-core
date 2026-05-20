// ═══════════════════════════════════════════════════════════════
// padova-readiness — diagnostica server-side
// GET/POST /functions/v1/padova-readiness
//
// Auth: x-diagnostic-secret = DIAGNOSTIC_SECRET (server-side only)
//
// Envelope atteso da Acquisition Radar (/admin/readiness):
//   {
//     ok: true,
//     data: {
//       status: "NOT_READY" | "PARTIAL" | "READY",
//       reason: string,
//       updated_at: string | null,
//       signals: {
//         real_listings, motivated_sellers, market_anomalies,
//         radar_signals, auction_signals, omi
//       }
//     }
//   }
//
// Regole status:
//   NOT_READY = nessun dato reale / solo demo
//   PARTIAL   = dati reali parziali o stale (>14gg) o auction_signals=0
//   READY     = dataset reali, freschi (<=14gg), copertura sufficiente
//               INCLUSO auction_signals >= 1
// ═══════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { makeDebugId, requireDiagnosticSecret, ok, handleOptions } from "../_shared/http.ts";

const FUNCTION_NAME = "padova-readiness";
const PADOVA = "Padova";
const PROV = "PD";

interface RunInfo {
  job_name: string;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  rows_out: number | null;
  errors: unknown;
}

async function lastIngestion(sb: ReturnType<typeof createClient>, like: string): Promise<RunInfo | null> {
  const { data, error } = await sb
    .from("ingestion_runs")
    .select("job_name, status, started_at, completed_at, rows_out, errors")
    .ilike("job_name", `%${like}%`)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as RunInfo | null) ?? null;
}

async function countByComune(sb: ReturnType<typeof createClient>, table: string, col = "municipality"): Promise<number> {
  const { count, error } = await sb
    .from(table)
    .select("*", { count: "exact", head: true })
    .ilike(col, PADOVA);
  if (error) return -1;
  return count ?? 0;
}

async function countByComuneAlt(sb: ReturnType<typeof createClient>, table: string, col: string): Promise<number> {
  const { count, error } = await sb
    .from(table)
    .select("*", { count: "exact", head: true })
    .ilike(col, PADOVA);
  if (error) return -1;
  return count ?? 0;
}

async function countRealByComune(sb: ReturnType<typeof createClient>, table: string, col = "municipality"): Promise<number> {
  // listing_price_snapshots non ha colonna 'quality' → conta tutti
  const { count, error } = await sb
    .from(table)
    .select("*", { count: "exact", head: true })
    .ilike(col, PADOVA)
    .neq("source", "demo");
  if (error) return -1;
  return count ?? 0;
}

async function omiRowCount(sb: ReturnType<typeof createClient>): Promise<number> {
  const { count, error } = await sb
    .from("omi_zone_geometry")
    .select("*", { count: "exact", head: true })
    .ilike("comune_descrizione", PADOVA);
  if (error) return -1;
  return count ?? 0;
}

async function lastUpdateAt(sb: ReturnType<typeof createClient>, table: string, col = "municipality", tsCol = "captured_at"): Promise<string | null> {
  const { data, error } = await sb
    .from(table)
    .select(tsCol)
    .ilike(col, PADOVA)
    .order(tsCol, { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as Record<string, string>)[tsCol] ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const authFail = requireDiagnosticSecret(req, debugId);
  if (authFail) return authFail;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Secret/provider availability
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const stripeMode = stripeKey.startsWith("sk_live_")
    ? "live"
    : stripeKey.startsWith("sk_test_") || stripeKey.startsWith("rk_test_")
      ? "test"
      : "unconfigured";
  // Mostra solo prefisso (8 char) + suffisso (4 char) — mai la chiave intera
  const stripePrefix = stripeKey
    ? `${stripeKey.slice(0, 8)}...${stripeKey.slice(-4)}`
    : null;
  const providers = {
    firecrawl_configured: !!Deno.env.get("FIRECRAWL_API_KEY"),
    perplexity_configured: !!Deno.env.get("PERPLEXITY_API_KEY"),
    apify_configured: !!Deno.env.get("APIFY_API_TOKEN"),
    stripe_configured: !!stripeKey,
    stripe_mode: stripeMode,
    stripe_key_masked: stripePrefix,
    stripe_webhook_configured: !!Deno.env.get("STRIPE_WEBHOOK_SECRET"),
  };

  // Last ingestion runs (best-effort string match in job_name)
  const [fcRun, pplxRun, apifyRun, auctionRun] = await Promise.all([
    lastIngestion(sb, "firecrawl"),
    lastIngestion(sb, "perplexity"),
    lastIngestion(sb, "apify"),
    lastIngestion(sb, "refresh-padova-auctions"),
  ]);

  // Counts on Padova Comune
  const [
    listingTotal, listingReal,
    motivated, anomalies, signals, auctions, omiRows,
    lastListing, lastAnomaly, lastSignal,
  ] = await Promise.all([
    countByComune(sb, "listing_price_snapshots", "municipality"),
    countRealByComune(sb, "listing_price_snapshots", "municipality"),
    countByComuneAlt(sb, "motivated_sellers", "municipality"),
    countByComuneAlt(sb, "market_anomalies", "municipality"),
    countByComuneAlt(sb, "radar_signals", "municipality"),
    countByComuneAlt(sb, "auction_signals", "municipality"),
    omiRowCount(sb),
    lastUpdateAt(sb, "listing_price_snapshots", "municipality", "captured_at"),
    lastUpdateAt(sb, "market_anomalies", "municipality", "detected_at").catch(() => null),
    lastUpdateAt(sb, "radar_signals", "municipality", "detected_at").catch(() => null),
  ]);

  // ── Real (non-demo) motivated sellers Padova ──
  const { count: motivatedReal } = await sb
    .from("motivated_sellers")
    .select("*", { count: "exact", head: true })
    .ilike("municipality", PADOVA)
    .eq("is_active", true)
    .neq("source", "seed_demo_veneto");

  // ── Early-warning real anticipatory signals (NON-asta) ──
  // 1) market_anomalies attivi (giacenza_lunga, omi_gap_alto/basso, ribasso, cluster_ribassi, agency_swap, cross_portal_reappear, price_jump_after_disappear)
  const { data: anomaliesByType } = await sb
    .from("market_anomalies")
    .select("anomaly_type, confidence, identity_hash, detected_at, payload")
    .ilike("municipality", PADOVA)
    .eq("is_active", true);
  const anomalyTypeCounts: Record<string, number> = {};
  const anomalyHighConf: string[] = [];
  for (const r of (anomaliesByType ?? []) as Array<{ anomaly_type: string; confidence: string; identity_hash: string }>) {
    anomalyTypeCounts[r.anomaly_type] = (anomalyTypeCounts[r.anomaly_type] ?? 0) + 1;
    if (r.confidence === "high") anomalyHighConf.push(r.identity_hash);
  }

  // 2) listing_velocity_signals stale/repost/price_drop (NOT pure freshness)
  const { count: velocityEarly } = await sb
    .from("listing_velocity_signals")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("is_active", true)
    .or("stale_listing.eq.true,repost_detected.eq.true,price_drop_percent.gte.5");

  // 3) early_offmarket promoted (Comune patrimonio, bandi, alienazioni) — privacy-safe già
  const { count: offmarketPromoted } = await sb
    .from("early_offmarket_signal_candidates")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("status", "promoted")
    .neq("signal_type", "irrelevant");

  // 4) inheritance_pressure_signals (aggregate-only, privacy-safe by design)
  const { count: inheritancePressure } = await sb
    .from("inheritance_pressure_signals")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("is_active", true)
    .eq("standard_radar_visible", false); // resta agency_private_only

  // 5) Multi-source: identity_hash che compare in motivated_sellers (reali) E market_anomalies
  const { data: msHashes } = await sb
    .from("motivated_sellers")
    .select("identity_hash")
    .ilike("municipality", PADOVA)
    .eq("is_active", true)
    .neq("source", "seed_demo_veneto");
  const msHashSet = new Set((msHashes ?? []).map((r) => (r as { identity_hash: string }).identity_hash));
  let multiSource = 0;
  for (const r of (anomaliesByType ?? []) as Array<{ identity_hash: string }>) {
    if (msHashSet.has(r.identity_hash)) multiSource++;
  }

  const earlyWarningRealCount =
    Object.values(anomalyTypeCounts).reduce((a, b) => a + b, 0) +
    (velocityEarly ?? 0) +
    (offmarketPromoted ?? 0) +
    (inheritancePressure ?? 0);

  const earlyWarningHighConfCount =
    anomalyHighConf.length + (offmarketPromoted ?? 0);

  // Auction freshness: newest detected_at on PD auctions + most common source_name
  const { data: lastAuctionRow } = await sb
    .from("auction_signals")
    .select("detected_at, source_name")
    .ilike("municipality", PADOVA)
    .order("detected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastAuctionAt = (lastAuctionRow as { detected_at?: string } | null)?.detected_at ?? null;
  const lastAuctionSource = (lastAuctionRow as { source_name?: string } | null)?.source_name ?? null;
  const auctionAgeDays = lastAuctionAt
    ? Math.floor((Date.now() - new Date(lastAuctionAt).getTime()) / (24 * 3600 * 1000))
    : null;
  const AUCTION_STALE_DAYS = 30;
  const auctionsFresh = auctionAgeDays !== null && auctionAgeDays <= AUCTION_STALE_DAYS;

  const lastDataUpdate = [lastListing, lastAnomaly, lastSignal]
    .filter((x): x is string => !!x)
    .sort()
    .pop() ?? null;

  const fourteenDaysMs = 14 * 24 * 3600 * 1000;
  const isFresh = lastDataUpdate ? (Date.now() - new Date(lastDataUpdate).getTime() < fourteenDaysMs) : false;

  // Errors recenti
  const { data: recentErrors } = await sb
    .from("ingestion_runs")
    .select("job_name, status, errors, started_at")
    .eq("status", "error")
    .order("started_at", { ascending: false })
    .limit(5);

  const { data: recentAuctionErrors } = await sb
    .from("ingestion_runs")
    .select("job_name, status, errors, started_at")
    .ilike("job_name", "%refresh-padova-auctions%")
    .eq("status", "error")
    .order("started_at", { ascending: false })
    .limit(5);

  // ── Commercial Early Warning Aggregator stats ──
  const { count: ewoTotal } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("is_active", true);
  const { count: ewoNonAuction } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("is_active", true)
    .neq("primary_signal_type", "AUCTION_CONFIRMATION");
  const { count: ewoMultiSource } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("is_active", true)
    .gte("sources_count", 2);
  const { count: ewoHighConf } = await sb
    .from("early_warning_opportunities")
    .select("*", { count: "exact", head: true })
    .ilike("comune", PADOVA)
    .eq("is_active", true)
    .eq("confidence", "alta");
  const lastEwRun = await lastIngestion(sb, "build-padova-early-warning");
  const { data: topOpps } = await sb
    .from("early_warning_opportunities")
    .select("title, primary_signal_type, early_acquisition_score, confidence, evidence_count, sources_count, source_names")
    .ilike("comune", PADOVA)
    .eq("is_active", true)
    .order("early_acquisition_score", { ascending: false })
    .limit(5);

  // ── Commercial thresholds: primo cliente pagante 499€/mese ──
  const COM_MIN_NON_AUCTION = 10;
  const COM_MIN_MULTI = 5;
  const COM_MIN_HIGH = 2;
  const PROVIDER_FRESH_DAYS = 7;

  // Provider freshness: almeno un provider esterno con run reale negli ultimi 7 giorni
  const providerRuns = [fcRun, pplxRun, apifyRun, auctionRun].filter(Boolean) as Array<{ started_at?: string }>;
  const mostRecentProviderAt = providerRuns
    .map((r) => r?.started_at ? new Date(r.started_at).getTime() : 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const providerFreshAgeDays = mostRecentProviderAt
    ? Math.floor((Date.now() - mostRecentProviderAt) / (24 * 3600 * 1000))
    : null;
  const providerFresh = providerFreshAgeDays !== null && providerFreshAgeDays <= PROVIDER_FRESH_DAYS;

  // Cron attivi? lettura best-effort da cron.job (può fallire per RLS → si presume off)
  let cronActive = false;
  let cronJobs: Array<{ jobname: string; schedule: string; active: boolean }> = [];
  try {
    const { data: crons } = await sb
      // @ts-expect-error schema cron non tipizzato
      .schema("cron").from("job").select("jobname, schedule, active");
    cronJobs = (crons ?? []) as typeof cronJobs;
    cronActive = cronJobs.some((j) => j.active && /padova|early-warning|refresh-padova/i.test(j.jobname));
  } catch { /* cron schema non leggibile dal client → cronActive resta false */ }

  const commercialMissing: string[] = [];
  if ((ewoNonAuction ?? 0) < COM_MIN_NON_AUCTION) commercialMissing.push(`opportunità non-asta insufficienti (${ewoNonAuction ?? 0} < ${COM_MIN_NON_AUCTION})`);
  if ((ewoMultiSource ?? 0) < COM_MIN_MULTI) commercialMissing.push(`opportunità multi-fonte insufficienti (${ewoMultiSource ?? 0} < ${COM_MIN_MULTI})`);
  if ((ewoHighConf ?? 0) < COM_MIN_HIGH) commercialMissing.push(`opportunità high-confidence insufficienti (${ewoHighConf ?? 0} < ${COM_MIN_HIGH})`);
  if (!providers.firecrawl_configured) commercialMissing.push("FIRECRAWL_API_KEY mancante");
  if (!providerFresh) commercialMissing.push(`nessun run provider negli ultimi ${PROVIDER_FRESH_DAYS} giorni (ultimo: ${providerFreshAgeDays ?? "mai"}g fa)`);

  let commercial_status: "NOT_READY" | "PARTIAL_TECHNICAL" | "READY_FOR_CONTROLLED_CLIENT" | "READY_FOR_PUBLIC_SALES";
  if ((ewoTotal ?? 0) === 0) commercial_status = "NOT_READY";
  else if (commercialMissing.length === 0 && cronActive) commercial_status = "READY_FOR_PUBLIC_SALES";
  else if (commercialMissing.length === 0) commercial_status = "READY_FOR_CONTROLLED_CLIENT";
  else commercial_status = "PARTIAL_TECHNICAL";


  // ── Status decision: commercial readiness, NOT solo aste ──
  const motivations: string[] = [];
  let status: "NOT_READY" | "PARTIAL" | "READY" = "NOT_READY";

  // Soglie commerciali realistiche per Padova Comune
  const MIN_LISTING_REAL = 20;
  const MIN_EARLY_WARNING = 8;          // almeno 8 segnali anticipatori reali non-asta
  const MIN_EARLY_HIGH_CONF = 3;        // di cui almeno 3 ad alta confidenza
  const MIN_LEGAL_OR_AUCTION = 1;       // almeno 1 fonte legale/asta come conferma

  const hasAnyReal = listingReal > 0 || (motivatedReal ?? 0) > 0 || anomalies > 0 || signals > 0;

  if (!hasAnyReal) {
    status = "NOT_READY";
    motivations.push("Nessun dato reale per Padova Comune nei dataset radar.");
  } else {
    const missing: string[] = [];
    if (listingReal < MIN_LISTING_REAL) missing.push(`listing reali insufficienti (${listingReal} < ${MIN_LISTING_REAL})`);
    if (omiRows < 1)       missing.push("nessuna riga OMI per Padova");
    if (auctions < MIN_LEGAL_OR_AUCTION) missing.push(`fonte legale/asta insufficiente (${auctions} < ${MIN_LEGAL_OR_AUCTION})`);
    if (!auctionsFresh && auctions >= 1) {
      missing.push(`auction_signals stale (>${AUCTION_STALE_DAYS}gg, età=${auctionAgeDays}gg)`);
    }
    if (earlyWarningRealCount < MIN_EARLY_WARNING) {
      missing.push(`early_warning non-asta insufficienti (${earlyWarningRealCount} < ${MIN_EARLY_WARNING})`);
    }
    if (earlyWarningHighConfCount < MIN_EARLY_HIGH_CONF) {
      missing.push(`segnali early_warning high-confidence insufficienti (${earlyWarningHighConfCount} < ${MIN_EARLY_HIGH_CONF})`);
    }
    if (!providers.firecrawl_configured)  missing.push("FIRECRAWL_API_KEY mancante");
    if (!providers.perplexity_configured) missing.push("PERPLEXITY_API_KEY mancante");
    if (!providers.apify_configured)      missing.push("APIFY_API_TOKEN mancante");
    if (!isFresh)          missing.push("dati non aggiornati negli ultimi 14 giorni");

    if (missing.length === 0) {
      status = "READY";
      motivations.push("Acquisition Radar: dati reali, segnali anticipatori multipli, fonti incrociate, freschezza ok.");
    } else {
      status = "PARTIAL";
      motivations.push(`Dati reali parziali. Mancano: ${missing.join("; ")}.`);
    }
  }

  const reason = motivations.join(" ");

  const auctionsBlock = {
    count: auctions,
    last_detected_at: lastAuctionAt,
    age_days: auctionAgeDays,
    fresh_within_days: AUCTION_STALE_DAYS,
    is_fresh: auctionsFresh,
    source_name: lastAuctionSource,
    last_run: auctionRun,
    recent_errors: recentAuctionErrors ?? [],
    role: "confirmation_signal_only",
  };

  const earlyWarningBlock = {
    total_real_non_auction: earlyWarningRealCount,
    high_confidence: earlyWarningHighConfCount,
    multi_source_listings: multiSource,
    by_anomaly_type: anomalyTypeCounts, // es. {agency_swap:16, omi_gap_alto:3, giacenza_lunga:1}
    velocity_early_signals: velocityEarly ?? 0,
    offmarket_promoted_real: offmarketPromoted ?? 0,
    inheritance_pressure_aggregate: inheritancePressure ?? 0,
    motivated_sellers_real: motivatedReal ?? 0,
    motivated_sellers_total_including_demo: motivated,
    thresholds: {
      min_early_warning: MIN_EARLY_WARNING,
      min_high_confidence: MIN_EARLY_HIGH_CONF,
      min_legal_or_auction: MIN_LEGAL_OR_AUCTION,
      min_listing_real: MIN_LISTING_REAL,
    },
    privacy_policy: "aggregate-only for inheritance/turnover; no personal names exposed",
  };

  return ok(req, {
    status,
    reason,
    updated_at: lastDataUpdate,
    signals: {
      real_listings: listingReal,
      motivated_sellers: motivatedReal ?? 0,
      market_anomalies: anomalies,
      radar_signals: signals,
      auction_signals: auctions,
      omi: omiRows,
      early_warning_non_auction: earlyWarningRealCount,
      early_warning_high_confidence: earlyWarningHighConfCount,
      multi_source_listings: multiSource,
    },
    function: FUNCTION_NAME,
    counts_padova_comune: {
      listing_price_snapshots_total: listingTotal,
      listing_price_snapshots_real: listingReal,
      motivated_sellers_real: motivatedReal ?? 0,
      motivated_sellers_total_including_demo: motivated,
      market_anomalies: anomalies,
      radar_signals: signals,
      auction_signals: auctions,
      omi_rows: omiRows,
    },
    fresh_within_14d: isFresh,
    auctions: auctionsBlock,
    early_warning: earlyWarningBlock,
    commercial_readiness: {
      status: commercial_status,
      missing: commercialMissing,
      thresholds: {
        controlled_client: { non_auction: COM_MIN_NON_AUCTION, multi_source: COM_MIN_MULTI, high_confidence: COM_MIN_HIGH },
        public_sales: { multi_source: 5, high_confidence: 3 },
      },
      opportunities: {
        total: ewoTotal ?? 0,
        non_auction: ewoNonAuction ?? 0,
        multi_source: ewoMultiSource ?? 0,
        high_confidence: ewoHighConf ?? 0,
      },
      last_run: lastEwRun,
      top_opportunities: topOpps ?? [],
    },
    providers,
    last_runs: { firecrawl: fcRun, perplexity: pplxRun, apify: apifyRun, padova_auctions: auctionRun, padova_early_warning: lastEwRun },
    recent_errors: recentErrors ?? [],
    fonti: [
      "listing_price_snapshots", "motivated_sellers", "market_anomalies",
      "radar_signals", "auction_signals", "early_offmarket_signal_candidates",
      "inheritance_pressure_signals", "listing_velocity_signals",
      "omi_zone_geometry", "Firecrawl", "Perplexity", "Apify",
    ],
  }, [], debugId);
});
