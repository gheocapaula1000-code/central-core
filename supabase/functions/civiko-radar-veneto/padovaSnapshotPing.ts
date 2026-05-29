// civiko-radar-veneto/padovaSnapshotPing.ts
// Nightly stage: re-check known Padova listings via Firecrawl /v2/scrape so that
//  - giorni_online grows monotonically even when the portal doesn't re-promote the ad;
//  - a delisting (404 / "rimosso") becomes itself a signal after TWO failures on
//    distinct UTC days.
//
// Hard rules:
//  - Sequential requests with a delay (default 1500ms) — no aggressive parallelism
//    against casa.it / immobiliare.it / idealista.it.
//  - Hard wall-clock budget; whatever doesn't fit rolls to the next nightly run.
//  - Same-day idempotency: at most ONE snapshot per listing per UTC day.
//  - No invented data: a transient error never produces a fake price, and a single
//    404 is NEVER confirmed as delisted (waits for a second failure on another day).
//  - Reuses civiko_evidence as the ledger for ping state — no new schema.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  parseFirecrawlPing,
  shouldConfirmDelisted,
  utcDateKey,
  type FirecrawlPingResult,
} from "../_shared/snapshotPing.ts";
import { sourceCodeForListing } from "../_shared/listingVelocity.ts";
import { upsertEvidenceRows, buildEvidenceRow } from "../_shared/evidenceLedger.ts";

const COMUNE = "Padova";
const DEFAULT_DELAY_MS = 1500;
// Supabase edge function hard wall-clock cap is ~400s. We stay safely below
// that (360s) so a single nightly run can chew through as many Padova listings
// as possible without being killed mid-flight. With ~8s effective cost per
// listing (1.5s politeness delay + ~6-7s Firecrawl scrape) this yields ~40-45
// listings per run; the cron is configured to fire multiple times per night to
// cover the full ~120 inventory.
const DEFAULT_MAX_LISTINGS = 130;
const DEFAULT_WALL_BUDGET_MS = 360_000;
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const SCRAPE_TIMEOUT_MS = 25_000;

interface KnownListing {
  listing_id: string;
  url: string;
  source: string;
  identity_hash: string | null;
  province: string | null;
  raw_title: string | null;
  raw_address: string | null;
  property_type: string | null;
  rooms: number | null;
  surface_sqm: number | null;
  lat: number | null;
  lng: number | null;
  first_seen_at: string | null;
  last_captured_at: string;
}

export interface PadovaSnapshotPingResult {
  ok: boolean;
  comune: string;
  candidates: number;
  pinged: number;
  ok_count: number;
  removed_count: number;
  error_count: number;
  skipped_same_day: number;
  skipped_already_delisted: number;
  newly_delisted: number;
  snapshots_inserted: number;
  duration_ms: number;
  warnings: string[];
  samples: Array<Record<string, unknown>>;
}

/** Pull the most recent snapshot per listing_id for Padova (last 30 days). */
async function loadKnownListings(sb: SupabaseClient, lookbackDays: number): Promise<KnownListing[]> {
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const pageSize = 1000;
  const seen = new Map<string, KnownListing>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("listing_price_snapshots")
      .select("listing_id, identity_hash, source, url, province, raw_title, raw_address, property_type, rooms, surface_sqm, lat, lng, first_seen_at, captured_at")
      .ilike("municipality", COMUNE)
      .gte("captured_at", cutoff)
      .order("captured_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = typeof r.listing_id === "string" ? r.listing_id : null;
      const url = typeof r.url === "string" ? r.url : null;
      if (!id || !url) continue;
      if (seen.has(id)) continue; // first row per listing wins (most recent due to ORDER BY)
      seen.set(id, {
        listing_id: id,
        url,
        source: typeof r.source === "string" ? r.source : "",
        identity_hash: typeof r.identity_hash === "string" ? r.identity_hash : null,
        province: typeof r.province === "string" ? r.province : null,
        raw_title: typeof r.raw_title === "string" ? r.raw_title : null,
        raw_address: typeof r.raw_address === "string" ? r.raw_address : null,
        property_type: typeof r.property_type === "string" ? r.property_type : null,
        rooms: typeof r.rooms === "number" ? r.rooms : null,
        surface_sqm: typeof r.surface_sqm === "number" ? r.surface_sqm : null,
        lat: typeof r.lat === "number" ? r.lat : null,
        lng: typeof r.lng === "number" ? r.lng : null,
        first_seen_at: typeof r.first_seen_at === "string" ? r.first_seen_at : null,
        last_captured_at: typeof r.captured_at === "string" ? r.captured_at : "",
      });
    }
    if (rows.length < pageSize) break;
  }
  // Prioritise stalest: oldest captured_at first → giorni_online matures faster.
  return Array.from(seen.values()).sort((a, b) =>
    (a.last_captured_at ?? "").localeCompare(b.last_captured_at ?? ""),
  );
}

/** Load ping state per entity_key from civiko_evidence (delisted + failure history). */
async function loadPingState(
  sb: SupabaseClient,
  entityKeys: string[],
): Promise<Map<string, { delisted: boolean; failures: string[] }>> {
  const out = new Map<string, { delisted: boolean; failures: string[] }>();
  if (entityKeys.length === 0) return out;
  const pageSize = 500;
  for (let i = 0; i < entityKeys.length; i += pageSize) {
    const slice = entityKeys.slice(i, i + pageSize);
    const { data } = await sb
      .from("civiko_evidence")
      .select("entity_key, evidence_type, evidence_value, observed_at")
      .eq("entity_type", "opportunity")
      .in("entity_key", slice)
      .in("evidence_type", ["listing_delisted", "listing_ping_state"]);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const k = String(r.entity_key);
      const cur = out.get(k) ?? { delisted: false, failures: [] };
      if (r.evidence_type === "listing_delisted") cur.delisted = true;
      if (r.evidence_type === "listing_ping_state") {
        const v = r.evidence_value as Record<string, unknown> | null;
        const arr = v && Array.isArray(v.recent_failures) ? v.recent_failures : [];
        cur.failures = arr.filter((x): x is string => typeof x === "string");
      }
      out.set(k, cur);
    }
  }
  return out;
}

async function isSnapshotToday(sb: SupabaseClient, listing_id: string): Promise<boolean> {
  const today = utcDateKey(new Date());
  const since = `${today}T00:00:00.000Z`;
  const { data } = await sb
    .from("listing_price_snapshots")
    .select("id")
    .eq("listing_id", listing_id)
    .gte("captured_at", since)
    .limit(1);
  return !!(data && data.length > 0);
}

async function firecrawlPing(url: string, key: string): Promise<FirecrawlPingResult> {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: [
          "markdown",
          {
            type: "json",
            prompt: "Estrai il prezzo richiesto in euro e la superficie in metri quadri se presenti.",
            schema: {
              type: "object",
              properties: {
                price: { type: "string" },
                surface_sqm: { type: "string" },
              },
            },
          },
        ],
        onlyMainContent: true,
        waitFor: 1200,
      }),
      signal: ctrl.signal,
    });
    if (res.status === 404 || res.status === 410) {
      return { outcome: "removed", http_status: res.status, price_eur: null, surface_sqm: null };
    }
    if (!res.ok) {
      return { outcome: "error", http_status: res.status, price_eur: null, surface_sqm: null };
    }
    const body = await res.json().catch(() => null);
    return parseFirecrawlPing(body);
  } catch {
    return { outcome: "error", http_status: null, price_eur: null, surface_sqm: null };
  } finally {
    clearTimeout(tm);
  }
}

async function persistSnapshot(
  sb: SupabaseClient,
  l: KnownListing,
  ping: FirecrawlPingResult,
): Promise<void> {
  // Preserve first_seen_at: the oldest known for this listing_id.
  let firstSeen = l.first_seen_at;
  if (!firstSeen) {
    const { data } = await sb
      .from("listing_price_snapshots")
      .select("first_seen_at")
      .eq("listing_id", l.listing_id)
      .not("first_seen_at", "is", null)
      .order("first_seen_at", { ascending: true })
      .limit(1);
    if (data && data.length > 0 && typeof data[0].first_seen_at === "string") {
      firstSeen = data[0].first_seen_at;
    }
  }
  await sb.from("listing_price_snapshots").insert({
    listing_id: l.listing_id,
    source: l.source,
    url: l.url,
    price_eur: ping.price_eur,
    municipality: COMUNE,
    province: l.province,
    lat: l.lat,
    lng: l.lng,
    raw_title: l.raw_title,
    raw_address: l.raw_address,
    first_seen_at: firstSeen ?? new Date().toISOString(),
    surface_sqm: ping.surface_sqm ?? l.surface_sqm,
    rooms: l.rooms,
    property_type: l.property_type,
    identity_hash: l.identity_hash,
  });
}

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface PadovaSnapshotPingOptions {
  maxListings?: number;
  delayMs?: number;
  wallBudgetMs?: number;
  lookbackDays?: number;
  dryRun?: boolean;
}

export async function runPadovaSnapshotPing(
  opts: PadovaSnapshotPingOptions = {},
): Promise<PadovaSnapshotPingResult> {
  const startedMs = Date.now();
  const warnings: string[] = [];
  const result: PadovaSnapshotPingResult = {
    ok: true, comune: COMUNE,
    candidates: 0, pinged: 0, ok_count: 0, removed_count: 0, error_count: 0,
    skipped_same_day: 0, skipped_already_delisted: 0,
    newly_delisted: 0, snapshots_inserted: 0,
    duration_ms: 0, warnings, samples: [],
  };

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const sr  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const fc  = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!url || !sr) { result.ok = false; warnings.push("supabase_env_missing"); return result; }
  if (!fc)         { result.ok = false; warnings.push("firecrawl_key_missing"); return result; }

  const sb = createClient(url, sr, { auth: { persistSession: false } });

  const maxListings  = opts.maxListings  ?? DEFAULT_MAX_LISTINGS;
  const delayMs      = opts.delayMs      ?? DEFAULT_DELAY_MS;
  const wallBudgetMs = opts.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS;
  const lookbackDays = opts.lookbackDays ?? 30;

  const known = await loadKnownListings(sb, lookbackDays);
  result.candidates = known.length;

  const keys = known.map((k) => `op:${slug(COMUNE)}:${k.listing_id}`);
  const state = await loadPingState(sb, keys);

  for (const l of known) {
    if (Date.now() - startedMs > wallBudgetMs) {
      warnings.push("wall_budget_reached");
      break;
    }
    if (result.pinged >= maxListings) break;

    const entityKey = `op:${slug(COMUNE)}:${l.listing_id}`;
    const st = state.get(entityKey);
    if (st?.delisted) { result.skipped_already_delisted++; continue; }
    if (await isSnapshotToday(sb, l.listing_id)) { result.skipped_same_day++; continue; }

    if (opts.dryRun) { result.pinged++; continue; }

    const ping = await firecrawlPing(l.url, fc);
    result.pinged++;
    const now = new Date();
    const sourceCode = sourceCodeForListing(l.source);

    if (ping.outcome === "ok" && ping.price_eur != null) {
      result.ok_count++;
      await persistSnapshot(sb, l, ping);
      result.snapshots_inserted++;
      // Reset failure state on success.
      if (st && st.failures.length > 0) {
        await upsertEvidenceRows(sb, [buildEvidenceRow({
          entity_type: "opportunity",
          entity_key: entityKey,
          source_code: sourceCode,
          evidence_type: "listing_ping_state",
          evidence_value: { recent_failures: [], last_ok_at: now.toISOString() },
          confidence: "low",
          explanation: "Snapshot ping ok, stato fallimenti azzerato",
          observed_at: now.toISOString(),
        })]);
      }
      if (result.samples.length < 3) {
        result.samples.push({ listing_id: l.listing_id, outcome: "ok", price_eur: ping.price_eur });
      }
    } else if (ping.outcome === "removed") {
      result.removed_count++;
      const previousFailures = st?.failures ?? [];
      const newFailures = [...previousFailures, now.toISOString()].slice(-5);
      const willConfirm = shouldConfirmDelisted(previousFailures, now);

      const rows = [buildEvidenceRow({
        entity_type: "opportunity",
        entity_key: entityKey,
        source_code: sourceCode,
        evidence_type: "listing_ping_state",
        evidence_value: {
          recent_failures: newFailures,
          last_http_status: ping.http_status,
        },
        confidence: "low",
        explanation: `Snapshot ping fallito (HTTP ${ping.http_status ?? "?"})`,
        observed_at: now.toISOString(),
      })];

      if (willConfirm) {
        result.newly_delisted++;
        rows.push(buildEvidenceRow({
          entity_type: "opportunity",
          entity_key: entityKey,
          source_code: sourceCode,
          evidence_type: "listing_delisted",
          evidence_value: {
            delisted_at: now.toISOString(),
            confirmed_after_failures: newFailures.length,
            url: l.url,
            explanation_bullets: ["Annuncio non più online — verifica se venduto o ritirato"],
          },
          confidence: "medium",
          explanation: "Annuncio non più online — verifica se venduto o ritirato",
          observed_at: now.toISOString(),
        }));
        if (result.samples.length < 3) {
          result.samples.push({ listing_id: l.listing_id, outcome: "delisted", url: l.url });
        }
      }
      await upsertEvidenceRows(sb, rows);
    } else {
      result.error_count++;
      // Transient error → do NOT mark failure; retry next nightly run.
    }

    // Politeness delay between portal requests.
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  }

  // Trace run (best-effort).
  try {
    await sb.from("ingestion_runs").insert({
      job_name: "ping-padova-snapshots",
      source_name: "internal_ping",
      status: "completed",
      rows_out: result.snapshots_inserted,
      errors: warnings.length ? { warnings } : null,
    });
  } catch { /* trace optional */ }

  result.duration_ms = Date.now() - startedMs;
  return result;
}

/** Return entity_keys (op:padova:<listing_id>) already confirmed as delisted. */
export async function loadDelistedKeys(sb: SupabaseClient): Promise<Set<string>> {
  const out = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("civiko_evidence")
      .select("entity_key")
      .eq("entity_type", "opportunity")
      .eq("evidence_type", "listing_delisted")
      .like("entity_key", `op:${slug(COMUNE)}:%`)
      .range(from, from + pageSize - 1);
    if (error) break;
    const rows = (data ?? []) as Array<{ entity_key: string }>;
    for (const r of rows) out.add(r.entity_key);
    if (rows.length < pageSize) break;
  }
  return out;
}
