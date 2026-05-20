// ═══════════════════════════════════════════════════════════════
// refreshPadovaAuctions — end-to-end pipeline Padova.
// Riusa: auctionDiscovery (scrape+parse) + auctionImport (dedupe+insert).
// Nessun mock. Niente bypass. Solo sample_candidates con conf>=0.70.
// Source primaria: astegiudiziarie.it (provincia di Padova).
// PVP resta manual_only nel registry; non bloccante.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { discoverVenetoAuctions } from "./auctionDiscovery.ts";
import { importVenetoAuctions, type AuctionRowInput } from "../auctionImport.ts";
import type { AuctionCandidate } from "./auctionParser.ts";

export interface RefreshPadovaRequest {
  dryRun?: boolean;
  includeNeedsReview?: boolean;
  maxPagesPerSource?: number;
  sourceName?: string;
}

export interface RefreshPadovaReport {
  ok: boolean;
  job: "refresh-padova-auctions";
  dryRun: boolean;
  source_name: string;
  auction_signals_before: number;
  auction_signals_after: number;
  discovery: {
    sources_used_firecrawl: number;
    sources_used_apify: number;
    candidates_found: number;
    candidates_importable: number;
    candidates_needs_review: number;
    pages_seen: number;
    errors: string[];
    warnings: string[];
  };
  import: {
    received: number;
    accepted: number;
    rejected: number;
    inserted: number;
    duplicates: number;
    warnings: string[];
  };
  notes: string[];
}

function svcClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function countPadovaSignals(): Promise<number> {
  const sb = svcClient();
  if (!sb) return -1;
  const { count } = await sb
    .from("auction_signals")
    .select("id", { head: true, count: "exact" })
    .eq("province", "PD");
  return count ?? 0;
}

function candidateToRow(c: AuctionCandidate, sourceName: string): AuctionRowInput | null {
  if (!c.comune || !c.province || c.province !== "PD") return null;
  if (!c.source_url) return null;
  const basis = Array.isArray(c.data_basis) && c.data_basis.length > 0
    ? c.data_basis.filter((b) => typeof b === "string" && b.length > 0)
    : ["firecrawl", sourceName];
  return {
    source_url: c.source_url,
    comune: c.comune,
    provincia: c.province,
    tipologia: c.asset_type,
    categoria: c.asset_type,
    prezzo_base: c.base_price,
    offerta_minima: c.minimum_offer,
    data_vendita: c.auction_date,
    tribunale: c.tribunal,
    stato: c.status ?? "active",
    quality: c.quality === "reale" ? "reale" : "parziale",
    data_basis: basis,
  };
}

export async function refreshPadovaAuctions(req: RefreshPadovaRequest = {}): Promise<RefreshPadovaReport> {
  const dryRun = req.dryRun !== false; // default true
  const sourceName = (req.sourceName ?? "astegiudiziarie_it_padova_weekly").trim();
  const includeNR = req.includeNeedsReview === true;
  const maxPages = Math.min(Math.max(req.maxPagesPerSource ?? 8, 1), 12);

  const before = await countPadovaSignals();

  // FASE 1+2: scrape + parse via discovery (compliance-safe)
  const disc = await discoverVenetoAuctions({
    dryRun: true,
    province: ["PD"],
    sourceTypes: ["delegated_auction_portal", "tribunal"],
    maxSources: 6,
    maxPagesPerSource: maxPages,
    runFirecrawl: true,
    fallbackToApifyOnFirecrawlError: true,
    enableDetailSecondPass: true,
  });

  const pool: AuctionCandidate[] = [
    ...(disc.sample_candidates ?? []),
    ...(includeNR ? (disc.sample_needs_review ?? []) : []),
  ];

  // FASE 3+4+5: normalize + dedupe + insert via importVenetoAuctions
  const rows: AuctionRowInput[] = [];
  for (const c of pool) {
    const row = candidateToRow(c, sourceName);
    if (row) rows.push(row);
  }

  const imp = await importVenetoAuctions({ source_name: sourceName, dryRun, rows });
  const after = await countPadovaSignals();

  const notes: string[] = [];
  if (pool.length === 0) notes.push("Nessun candidato importabile estratto in questo run.");
  if (disc.errors.length > 0) notes.push(`discovery_errors=${disc.errors.length}`);
  notes.push("PVP (pvp.giustizia.it) resta manual_only: non scrapato.");

  return {
    ok: imp.ok && disc.ok,
    job: "refresh-padova-auctions",
    dryRun,
    source_name: sourceName,
    auction_signals_before: before,
    auction_signals_after: after,
    discovery: {
      sources_used_firecrawl: disc.sources_used_firecrawl,
      sources_used_apify: disc.sources_used_apify,
      candidates_found: disc.candidates_found,
      candidates_importable: disc.candidates_importable,
      candidates_needs_review: disc.candidates_needs_review,
      pages_seen: disc.pages_seen,
      errors: disc.errors.slice(0, 5),
      warnings: disc.warnings.slice(0, 5),
    },
    import: {
      received: imp.totals.received,
      accepted: imp.totals.accepted,
      rejected: imp.totals.rejected,
      inserted: imp.totals.inserted,
      duplicates: imp.totals.duplicates,
      warnings: imp.warnings.slice(0, 5),
    },
    notes,
  };
}
