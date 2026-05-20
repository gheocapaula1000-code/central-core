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
  const [fcRun, pplxRun, apifyRun] = await Promise.all([
    lastIngestion(sb, "firecrawl"),
    lastIngestion(sb, "perplexity"),
    lastIngestion(sb, "apify"),
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

  // ── Status decision ──
  const motivations: string[] = [];
  let status: "NOT_READY" | "PARTIAL" | "READY" = "NOT_READY";

  const hasAnyReal = listingReal > 0 || motivated > 0 || anomalies > 0 || signals > 0;

  if (!hasAnyReal) {
    status = "NOT_READY";
    motivations.push("Nessun dato reale per Padova Comune nei dataset radar.");
  } else {
    const missing: string[] = [];
    if (listingReal < 20) missing.push(`listing reali insufficienti (${listingReal} < 20)`);
    if (omiRows < 1)       missing.push("nessuna riga OMI per Padova");
    if (auctions < 1)      missing.push("auction_signals=0 (richiesto >=1 per READY)");
    if (!providers.firecrawl_configured)  missing.push("FIRECRAWL_API_KEY mancante");
    if (!providers.perplexity_configured) missing.push("PERPLEXITY_API_KEY mancante");
    if (!providers.apify_configured)      missing.push("APIFY_API_TOKEN mancante");
    if (!isFresh)          missing.push("dati non aggiornati negli ultimi 14 giorni");
    if (anomalies < 1 && signals < 1) missing.push("nessun segnale/anomalia di mercato");

    if (missing.length === 0) {
      status = "READY";
      motivations.push("Dataset reale, fresco e con copertura sufficiente per il MVP Padova Comune.");
    } else {
      status = "PARTIAL";
      motivations.push(`Dati reali parziali. Mancano: ${missing.join("; ")}.`);
    }
  }

  const reason = motivations.join(" ");

  // ── Envelope compatibile con Acquisition Radar /admin/readiness ──
  return ok(req, {
    status,
    reason,
    updated_at: lastDataUpdate,
    signals: {
      real_listings: listingReal,
      motivated_sellers: motivated,
      market_anomalies: anomalies,
      radar_signals: signals,
      auction_signals: auctions,
      omi: omiRows,
    },
    // ── extra diagnostica (non rompe il consumer PWA) ──
    function: FUNCTION_NAME,
    counts_padova_comune: {
      listing_price_snapshots_total: listingTotal,
      listing_price_snapshots_real: listingReal,
      motivated_sellers: motivated,
      market_anomalies: anomalies,
      radar_signals: signals,
      auction_signals: auctions,
      omi_rows: omiRows,
    },
    fresh_within_14d: isFresh,
    providers,
    last_runs: { firecrawl: fcRun, perplexity: pplxRun, apify: apifyRun },
    recent_errors: recentErrors ?? [],
    fonti: [
      "listing_price_snapshots", "motivated_sellers", "market_anomalies",
      "radar_signals", "auction_signals", "omi_zone_geometry",
      "Firecrawl", "Perplexity", "Apify",
    ],
  }, [], debugId);
});
