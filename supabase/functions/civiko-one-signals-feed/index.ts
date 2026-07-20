// Civiko One — Signals Feed (server-to-server only)
// POST /civiko-one-signals-feed
// Aggregates Padova signals from existing Core tables into a single feed.
// Protected with HMAC-SHA256 signature. Schema: civiko_signals_feed_v1

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  resolvePadovaOmiSync,
  resolvePadovaOmiBatch,
} from "../_shared/padovaOmiResolver.ts";
import {
  resolveZoneFromRecord,
  applyQuartiereZonaMapFallback,
  UNRESOLVED_OMI_CODE,
  UNRESOLVED_OMI_LABEL,
} from "../_shared/padovaZoneResolver.ts";
import { isAuctionRecord } from "../_shared/auctionExclusion.ts";

const SCHEMA_VERSION = "civiko_signals_feed_v1";
const MAX_SKEW_MS = 5 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-source-app, x-tenant-id, x-timestamp, x-core-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Core-Function": "civiko-one-signals-feed",
      "X-Core-Contract": SCHEMA_VERSION,
    },
  });
}

function err(code: string, message: string, status: number, debugId: string) {
  return jsonResp(
    { ok: false, schema_version: SCHEMA_VERSION, error: { code, message }, debug_id: debugId },
    status,
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseTimestamp(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// ─────────────────────────────────────────────────────────────
// Price normalization
// ─────────────────────────────────────────────────────────────
const PRICE_MIN = 10000;
const PRICE_MAX = 5000000;

function normalizePrice(value: unknown): { price: number | null; label: string; invalid: boolean } {
  if (value == null) return { price: null, label: "Prezzo da verificare", invalid: true };
  let s = typeof value === "number" ? String(value) : String(value);
  s = s.replace(/[€\s]/g, "").trim();
  if (!s) return { price: null, label: "Prezzo da verificare", invalid: true };
  // Remove thousand separators (. or ,) — keep only digits
  // Heuristic: if it has both . and , the last is decimal; for prices we drop decimals.
  const digitsOnly = s.replace(/[^\d]/g, "");
  if (!digitsOnly) return { price: null, label: "Prezzo da verificare", invalid: true };
  const n = Number(digitsOnly);
  if (!Number.isFinite(n) || n < PRICE_MIN || n > PRICE_MAX) {
    return { price: null, label: "Prezzo da verificare", invalid: true };
  }
  const label = n.toLocaleString("it-IT") + " €";
  return { price: n, label, invalid: false };
}

type SignalType = "contendibile" | "multi_portale" | "ribasso" | "privato" | "off_market";

interface DataQuality {
  score: number;
  flags: string[];
  needs_review: boolean;
}

interface FeedItem {
  source_id: string;
  signal_type: SignalType;
  title: string;
  city: string;
  province: string;
  zone_code: string;
  zone_label: string;
  display_zone: string;
  price: number | null;
  price_label: string;
  url: string;
  status: string;
  score: number;
  last_seen_at: string;
  raw_ref: string;
  data_quality: DataQuality;
  lat: number | null;
  lng: number | null;
  // Tassonomia segnali estesa (additive, non breaking)
  evidence_type?: string;
  label_pubblica?: string;
  portals_seen?: string[];
  agency_count_distinct?: number;
  agencies_normalized?: string[];
  needs_review?: boolean;
  operator_note?: string;
  // Ribasso-specific (additive, opzionali)
  ribasso_pct?: number;
  initial_price_eur?: number;
  current_price_eur?: number;
  drops_count?: number;
  commercial_zone_slug?: string;
  omi_zone_code?: string;
}


function resolveZone(record: Record<string, unknown>): { code: string; label: string } {
  return resolveZoneFromRecord(record);
}

function toCoord(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildItem(
  partial: Partial<FeedItem> & { signal_type: SignalType; source_id: string; price_raw?: unknown; lat_raw?: unknown; lng_raw?: unknown },
): FeedItem {
  const zone_code = partial.zone_code && partial.zone_code.trim() ? partial.zone_code : UNRESOLVED_OMI_CODE;
  const zone_label = partial.zone_label && partial.zone_label.trim() ? partial.zone_label : UNRESOLVED_OMI_LABEL;
  const norm = normalizePrice(partial.price_raw ?? partial.price);
  const flags: string[] = [];
  if (norm.invalid) flags.push("invalid_price");
  if (zone_code === UNRESOLVED_OMI_CODE) flags.push("unresolved_zone");
  const qualityScore = Math.max(0, 100 - flags.length * 30);
  const needsReviewBase = flags.includes("invalid_price") || partial.needs_review === true;
  const item: FeedItem = {
    source_id: partial.source_id,
    signal_type: partial.signal_type,
    title: partial.title?.trim() || "(senza titolo)",
    city: partial.city?.trim() || "Padova",
    province: (partial.province || "PD").toUpperCase(),
    zone_code,
    zone_label,
    display_zone: partial.display_zone?.trim() || zone_label,
    price: norm.price,
    price_label: norm.label,
    url: partial.url || "",
    status: partial.status || "active",
    score: Number.isFinite(partial.score as number) ? Number(partial.score) : 0,
    last_seen_at: partial.last_seen_at || new Date().toISOString(),
    raw_ref: partial.raw_ref || "",
    data_quality: { score: qualityScore, flags, needs_review: needsReviewBase },
    lat: toCoord(partial.lat_raw ?? partial.lat),
    lng: toCoord(partial.lng_raw ?? partial.lng),
  };

  if (partial.evidence_type) item.evidence_type = partial.evidence_type;
  if (partial.label_pubblica) item.label_pubblica = partial.label_pubblica;
  if (partial.portals_seen) item.portals_seen = partial.portals_seen;
  if (typeof partial.agency_count_distinct === "number") item.agency_count_distinct = partial.agency_count_distinct;
  if (partial.agencies_normalized) item.agencies_normalized = partial.agencies_normalized;
  if (typeof partial.needs_review === "boolean") item.needs_review = partial.needs_review;
  if (partial.operator_note) item.operator_note = partial.operator_note;
  if (typeof partial.ribasso_pct === "number") item.ribasso_pct = partial.ribasso_pct;
  if (typeof partial.initial_price_eur === "number") item.initial_price_eur = partial.initial_price_eur;
  if (typeof partial.current_price_eur === "number") item.current_price_eur = partial.current_price_eur;
  if (typeof partial.drops_count === "number") item.drops_count = partial.drops_count;
  if (partial.commercial_zone_slug) item.commercial_zone_slug = partial.commercial_zone_slug;
  if (partial.omi_zone_code) item.omi_zone_code = partial.omi_zone_code;
  return item;
}

function normalizeForKey(s: string | null | undefined): string {
  return (s || "")
    .toString()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeItems(items: FeedItem[]): { kept: FeedItem[]; removed: number } {
  const byKey = new Map<string, FeedItem>();
  for (const it of items) {
    const addr = normalizeForKey(it.title);
    const url = normalizeForKey(it.url);
    const primary = `${addr}|${it.signal_type}|${it.zone_code}`;
    const fallback = url || it.source_id;
    const key = addr ? primary : `${fallback}|${it.signal_type}`;
    const prev = byKey.get(key);
    if (!prev || it.last_seen_at > prev.last_seen_at) byKey.set(key, it);
  }
  const kept = Array.from(byKey.values());
  return { kept, removed: items.length - kept.length };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const debugId = crypto.randomUUID();

  if (req.method !== "POST") return err("METHOD_NOT_ALLOWED", "Use POST", 405, debugId);

  // ── Security gate ─────────────────────────────────────────
  const sourceApp = req.headers.get("x-source-app");
  const tenantId = req.headers.get("x-tenant-id");
  const tsHeader = req.headers.get("x-timestamp");
  const signature = req.headers.get("x-core-signature");
  const rawBody = await req.text();

  const secret = Deno.env.get("CORE_SHARED_SECRET") ?? "";
  if (!secret) return err("CONFIG_MISSING", "Server secret missing", 500, debugId);

  if (!sourceApp) return err("MISSING_SOURCE_APP", "x-source-app required", 401, debugId);
  if (sourceApp !== "civiko-one") return err("INVALID_SOURCE_APP", "x-source-app must be civiko-one", 403, debugId);
  if (!tenantId) return err("MISSING_TENANT", "x-tenant-id required", 401, debugId);
  if (!tsHeader) return err("MISSING_TIMESTAMP", "x-timestamp required", 401, debugId);
  if (!signature) return err("MISSING_SIGNATURE", "x-core-signature required", 401, debugId);

  const tsMs = parseTimestamp(tsHeader);
  if (tsMs === null) return err("INVALID_TIMESTAMP", "x-timestamp not parseable", 401, debugId);
  if (Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    return err("TIMESTAMP_SKEW", "x-timestamp too old or in the future", 401, debugId);
  }

  const expected = await hmacHex(secret, `${tsHeader}${tenantId}${rawBody}`);
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    console.warn(`[civiko-one-signals-feed] bad signature tenant=${tenantId} debug=${debugId}`);
    return err("INVALID_SIGNATURE", "HMAC signature mismatch", 403, debugId);
  }

  // ── Parse body ────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch { return err("INVALID_JSON", "Body is not valid JSON", 400, debugId); }

  const city = (typeof body.city === "string" && body.city.trim()) || "Padova";
  const province = ((typeof body.province === "string" && body.province.trim()) || "PD").toUpperCase();
  const zoneMode = (typeof body.zone_mode === "string" && body.zone_mode) || "omi_microzone";
  const limit = Math.max(1, Math.min(Number(body.limit) || 250, 1000));
  const include = Array.isArray(body.include) && body.include.length
    ? (body.include as string[]).filter((s) => typeof s === "string")
    : ["contendibili", "ribassi", "privati", "off_market"];
  const includeSet = new Set(include);

  // ── Data fetch ────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const rawItems: FeedItem[] = [];
  const sourcesUsed: string[] = [];
  let lastProviderRefresh: string | null = null;
  const bump = (ts?: string | null) => {
    if (!ts) return;
    if (!lastProviderRefresh || ts > lastProviderRefresh) lastProviderRefresh = ts;
  };

  // Freshness probes per source (independent of selected rows)
  const sourceFreshness: Record<string, { max_created_at: string | null; max_updated_at: string | null; max_last_seen_at: string | null; rows_last_24h: number | null }> = {};
  async function probeFreshness(table: string, hasUpdated: boolean, hasLastSeen: boolean, filterCol?: string, filterVal?: string) {
    try {
      const cols = ["created_at"];
      if (hasUpdated) cols.push("updated_at");
      if (hasLastSeen) cols.push("last_seen_at");
      let q = supabase.from(table).select(cols.join(","), { count: "exact", head: false }).order("created_at", { ascending: false }).limit(1);
      if (filterCol && filterVal) q = q.ilike(filterCol, filterVal);
      const { data } = await q;
      const top = (data && data[0]) as Record<string, unknown> | undefined;
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).gte("created_at", since);
      sourceFreshness[table] = {
        max_created_at: (top?.created_at as string) ?? null,
        max_updated_at: hasUpdated ? (top?.updated_at as string) ?? null : null,
        max_last_seen_at: hasLastSeen ? (top?.last_seen_at as string) ?? null : null,
        rows_last_24h: count ?? null,
      };
    } catch (e) {
      sourceFreshness[table] = { max_created_at: null, max_updated_at: null, max_last_seen_at: null, rows_last_24h: null };
    }
  }

  // CONTENDIBILI VERI — da padova_contendibili (>=2 agenzie reali distinte)
  if (includeSet.has("contendibili")) {
    await probeFreshness("padova_contendibili", false, false);
    const { data, error } = await supabase
      .from("padova_contendibili")
      .select("id, chiave_match, n_agenzie, agency_count_distinct, agencies_normalized, agenzie, portals_seen, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, created_at")
      .or("agency_count_distinct.gte.2,and(agency_count_distinct.is.null,n_agenzie.gte.2)")
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("agency_count_distinct", { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[civiko-one-signals-feed] padova_contendibili error:`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_contendibili");
      const rank: Record<string, number> = { ALTA: 30, MEDIA: 15, DA_CONFERMARE: 0 };
      for (const row of data as Record<string, unknown>[]) {
        const z = resolveZone(row);
        const minP = Number(row.prezzo_min) || 0;
        const maxP = Number(row.prezzo_max) || 0;
        const priceCandidate = minP && maxP ? Math.round((minP + maxP) / 2) : (maxP || minP || null);
        const lastSeen = (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const urls = Array.isArray(row.urls) ? (row.urls as string[]) : [];
        const portals = Array.isArray(row.portals_seen) ? (row.portals_seen as string[])
          : (Array.isArray(row.fonti) ? (row.fonti as string[]) : []);
        const agenciesNorm = Array.isArray(row.agencies_normalized) ? (row.agencies_normalized as string[]) : [];
        const nAg = Number(row.agency_count_distinct ?? row.n_agenzie) || 0;
        const conf = String(row.confidenza || "");
        const score = Math.min(100, 50 + Math.min(nAg, 10) * 4 + (rank[conf] || 0));
        const title = String(row.chiave_match || `Contendibile ${row.id}`)
          .split("|")[0].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        rawItems.push(buildItem({
          source_id: `cont:${row.id}`,
          signal_type: "contendibile",
          title: `${title} — ${nAg} agenzie distinte`,
          city, province,
          zone_code: z.code, zone_label: z.label, display_zone: z.label,
          price_raw: priceCandidate,
          url: urls[0] || "",
          status: "active",
          score,
          last_seen_at: lastSeen,
          raw_ref: `padova_contendibili:${row.id}`,
          lat_raw: row.lat,
          lng_raw: row.lng,

          evidence_type: "multiple_distinct_agencies",
          label_pubblica: "Contendibile verificato",
          portals_seen: portals,
          agency_count_distinct: nAg,
          agencies_normalized: agenciesNorm,
          needs_review: false,
        }));
      }
    }
  }

  // MULTI-PORTALE — stessi immobili visti su >=2 portali ma SENZA prova di agenzie distinte
  if (includeSet.has("contendibili") || includeSet.has("multi_portale")) {
    await probeFreshness("padova_multi_portale", false, false);
    const { data, error } = await supabase
      .from("padova_multi_portale")
      .select("id, chiave_match, portal_count, portals_seen, agency_count_distinct, agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, n_annunci, created_at")
      .gte("portal_count", 2)
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("portal_count", { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[civiko-one-signals-feed] padova_multi_portale error:`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_multi_portale");
      for (const row of data as Record<string, unknown>[]) {
        const z = resolveZone(row);
        const minP = Number(row.prezzo_min) || 0;
        const maxP = Number(row.prezzo_max) || 0;
        const priceCandidate = minP && maxP ? Math.round((minP + maxP) / 2) : (maxP || minP || null);
        const lastSeen = (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const urls = Array.isArray(row.urls) ? (row.urls as string[]) : [];
        const portals = Array.isArray(row.portals_seen) ? (row.portals_seen as string[]) : [];
        const agenciesNorm = Array.isArray(row.agencies_normalized) ? (row.agencies_normalized as string[]) : [];
        const nPortals = Number(row.portal_count) || portals.length;
        const nAg = Number(row.agency_count_distinct) || 0;
        const score = Math.min(85, 40 + Math.min(nPortals, 6) * 5);
        const title = String(row.chiave_match || `Multi-portale ${row.id}`)
          .split("|")[0].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        rawItems.push(buildItem({
          source_id: `mp:${row.id}`,
          signal_type: "multi_portale",
          title: `${title} — ${nPortals} portali`,
          city, province,
          zone_code: z.code, zone_label: z.label, display_zone: z.label,
          price_raw: priceCandidate,
          url: urls[0] || "",
          status: "active",
          score,
          last_seen_at: lastSeen,
          raw_ref: `padova_multi_portale:${row.id}`,
          lat_raw: row.lat,
          lng_raw: row.lng,

          evidence_type: "multi_portal_without_agency_confirmation",
          label_pubblica: "Alta esposizione",
          portals_seen: portals,
          agency_count_distinct: nAg,
          agencies_normalized: agenciesNorm,
          needs_review: true,
          operator_note: "Immobile presente su più portali. Verificare se la gestione è realmente frammentata prima di proporre l'esclusiva.",
        }));
      }
    }
  }


  // RIBASSI — fonte primaria: RPC get_padova_verified_price_drops
  // Fallback (zero-downtime, se la migrazione non è ancora stata applicata):
  //   ramo storico padova_collect_v2_items con soglia >=5%, esclusione aste,
  //   zona risolta obbligatoria.
  // PRIVATI restano gestiti da padova_collect_v2_items.
  const ribassiDiag = {
    ribassi_rpc_returned: 0,
    ribassi_auction_excluded: 0,
    ribassi_unzoned_excluded: 0,
    ribassi_invalid_price_excluded: 0,
    ribassi_source: "listing_price_snapshots" as "listing_price_snapshots" | "fallback_collect_v2" | "unused",
  };

  if (includeSet.has("ribassi")) {
    let rpcOk = false;
    try {
      const { data: rpcRows, error: rpcErr } = await supabase.rpc(
        "get_padova_verified_price_drops",
        { p_limit: limit, p_min_drop_pct: 5, p_max_age_days: 14 },
      );
      if (!rpcErr && Array.isArray(rpcRows)) {
        rpcOk = true;
        sourcesUsed.push("listing_price_snapshots");
        ribassiDiag.ribassi_rpc_returned = rpcRows.length;
        for (const row of rpcRows as Record<string, unknown>[]) {
          if (isAuctionRecord(row)) { ribassiDiag.ribassi_auction_excluded++; continue; }
          const slug = (row.commercial_zone_slug as string) || "";
          if (!slug) { ribassiDiag.ribassi_unzoned_excluded++; continue; }
          const url = String(row.url || "");
          if (!url.startsWith("https://")) { ribassiDiag.ribassi_invalid_price_excluded++; continue; }
          const current = Number(row.current_price_eur) || 0;
          const initial = Number(row.initial_price_eur) || 0;
          if (!(current >= PRICE_MIN && current <= PRICE_MAX && initial > 0 && current < initial)) {
            ribassiDiag.ribassi_invalid_price_excluded++; continue;
          }
          const dropPct = Number(row.total_drop_pct) || 0;
          if (dropPct < 5) continue;
          const lastSeen = (row.last_seen_at as string) || new Date().toISOString();
          bump(lastSeen);
          const omiCode = (row.omi_zone as string) || "";
          const zoneLabel = omiCode || UNRESOLVED_OMI_LABEL;
          const title = (row.title as string) || `Ribasso ${row.listing_id ?? ""}`;
          rawItems.push(buildItem({
            source_id: `drop:${row.source_id ?? row.listing_id ?? url}`,
            signal_type: "ribasso",
            title: `${title} — ribasso ${dropPct}%`,
            city, province,
            zone_code: omiCode || UNRESOLVED_OMI_CODE,
            zone_label: zoneLabel,
            display_zone: zoneLabel,
            price_raw: current,
            url,
            status: "active",
            score: Math.min(100, 50 + Math.round(dropPct)),
            last_seen_at: lastSeen,
            raw_ref: `listing_price_snapshots:${row.source_id ?? ""}`,
            lat_raw: row.lat,
            lng_raw: row.lng,
            ribasso_pct: Math.round(dropPct * 10) / 10,
            initial_price_eur: initial,
            current_price_eur: current,
            drops_count: Number(row.drops_count) || 0,
            commercial_zone_slug: slug,
            omi_zone_code: omiCode || undefined,
          }));
        }
      } else if (rpcErr) {
        console.warn(`[civiko-one-signals-feed] ribassi RPC unavailable: ${rpcErr.code ?? ""}`);
      }
    } catch (e) {
      console.warn(`[civiko-one-signals-feed] ribassi RPC exception:`, (e as Error)?.message ?? "err");
    }

    if (!rpcOk) {
      // Fallback: ramo padova_collect_v2_items, soglia 5%, no aste, zona risolta.
      ribassiDiag.ribassi_source = "fallback_collect_v2";
      try {
        const { data: fb, error: fbErr } = await supabase
          .from("padova_collect_v2_items")
          .select("id, portal, listing_id, url, raw_address, citta, cap, lat, lng, omi_zone, quartiere, prezzo, prezzo_iniziale, agency, created_at, processed_at")
          .order("processed_at", { ascending: false, nullsFirst: false })
          .limit(limit * 2);
        if (!fbErr && fb) {
          sourcesUsed.push("padova_collect_v2_items:fallback_ribassi");
          for (const row of fb as Record<string, unknown>[]) {
            const price = Number(row.prezzo ?? 0) || 0;
            const initial = Number(row.prezzo_iniziale ?? 0) || 0;
            if (!(initial > 0 && price > 0 && price < initial)) continue;
            const dropPct = ((initial - price) / initial) * 100;
            if (dropPct < 5) continue;
            if (isAuctionRecord(row)) { ribassiDiag.ribassi_auction_excluded++; continue; }
            const z = resolveZone(row);
            if (z.code === UNRESOLVED_OMI_CODE) { ribassiDiag.ribassi_unzoned_excluded++; continue; }
            const url = String(row.url || "");
            if (!url.startsWith("https://")) { ribassiDiag.ribassi_invalid_price_excluded++; continue; }
            const lastSeen = (row.processed_at as string) || (row.created_at as string) || new Date().toISOString();
            bump(lastSeen);
            const baseTitle = (row.raw_address as string) || (row.listing_id as string) || `Listing ${row.id}`;
            rawItems.push(buildItem({
              source_id: `pdv:${row.id}`,
              signal_type: "ribasso",
              title: `${baseTitle} — ribasso ${Math.round(dropPct)}%`,
              city, province,
              zone_code: z.code, zone_label: z.label, display_zone: z.label,
              price_raw: price,
              url,
              status: "active",
              score: Math.min(100, 50 + Math.round(dropPct)),
              last_seen_at: lastSeen,
              raw_ref: `padova_collect_v2_items:${row.id}`,
              lat_raw: row.lat,
              lng_raw: row.lng,
              ribasso_pct: Math.round(dropPct * 10) / 10,
              initial_price_eur: initial,
              current_price_eur: price,
              omi_zone_code: z.code,
            }));
          }
        }
      } catch (e) {
        console.warn(`[civiko-one-signals-feed] ribassi fallback error:`, (e as Error)?.message ?? "err");
      }
    }
  } else {
    ribassiDiag.ribassi_source = "unused";
  }

  // PRIVATI — invariato: da padova_collect_v2_items
  if (includeSet.has("privati")) {
    await probeFreshness("padova_collect_v2_items", false, false);
    const { data, error } = await supabase
      .from("padova_collect_v2_items")
      .select("id, portal, listing_id, url, raw_address, citta, cap, lat, lng, omi_zone, quartiere, prezzo, mq, locali, agency, contendibile, created_at, processed_at")
      .order("processed_at", { ascending: false, nullsFirst: false })
      .limit(limit * 2);
    if (error) {
      console.error(`[civiko-one-signals-feed] padova_collect_v2_items error:`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_collect_v2_items");
      for (const row of data as Record<string, unknown>[]) {
        if (isAuctionRecord(row)) continue;
        const z = resolveZone(row);
        const price = Number(row.prezzo ?? 0) || 0;
        const lastSeen = (row.processed_at as string) || (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const baseTitle = (row.raw_address as string) || (row.listing_id as string) || `Listing ${row.id}`;
        if (!row.agency || String(row.agency).trim() === "") {
          rawItems.push(buildItem({
            source_id: `pdv:${row.id}`,
            signal_type: "privato",
            title: baseTitle,
            city, province,
            zone_code: z.code, zone_label: z.label, display_zone: z.label,
            price_raw: price,
            url: (row.url as string) || "",
            status: "active",
            score: 55,
            last_seen_at: lastSeen,
            raw_ref: `padova_collect_v2_items:${row.id}`,
            lat_raw: row.lat, lng_raw: row.lng,
          }));
        }
      }
    }
  }

  // OFF_MARKET
  const offmarketDiag = {
    offmarket_candidates_read: 0,
    offmarket_privacy_excluded: 0,
    offmarket_auction_excluded: 0,
    offmarket_not_importable_excluded: 0,
    offmarket_published: 0,
  };
  if (includeSet.has("off_market")) {
    await probeFreshness("early_offmarket_signal_candidates", true, false, "comune", city);
    const { data, error } = await supabase
      .from("early_offmarket_signal_candidates")
      .select("*")
      .ilike("comune", city)
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) {
      console.warn(`[civiko-one-signals-feed] off_market query error:`, error.message);
    } else if (data) {
      sourcesUsed.push("early_offmarket_signal_candidates");
      for (const row of data as Record<string, unknown>[]) {
        offmarketDiag.offmarket_candidates_read++;
        const status = String((row as Record<string, unknown>).status ?? "").toLowerCase();
        if (status === "rejected" || status === "discarded") { offmarketDiag.offmarket_not_importable_excluded++; continue; }
        if ((row as Record<string, unknown>).privacy_safe !== true) { offmarketDiag.offmarket_privacy_excluded++; continue; }
        const rec = (row as Record<string, unknown>).import_recommendation;
        if (rec && String(rec).toLowerCase() !== "importable") { offmarketDiag.offmarket_not_importable_excluded++; continue; }
        if (isAuctionRecord(row)) { offmarketDiag.offmarket_auction_excluded++; continue; }
        const z = resolveZone(row);
        const lastSeen = ((row as Record<string, unknown>).updated_at as string) || ((row as Record<string, unknown>).created_at as string) || new Date().toISOString();
        bump(lastSeen);
        rawItems.push(buildItem({
          source_id: `offm:${(row as Record<string, unknown>).id}`,
          signal_type: "off_market",
          title: ((row as Record<string, unknown>).title as string) || ((row as Record<string, unknown>).address_text as string) || `Off-market ${(row as Record<string, unknown>).id}`,
          city, province,
          zone_code: z.code, zone_label: z.label, display_zone: z.label,
          price_raw: (row as Record<string, unknown>).estimated_price ?? (row as Record<string, unknown>).price ?? null,
          url: ((row as Record<string, unknown>).source_url as string) || "",
          status: (status || "active"),
          score: Number((row as Record<string, unknown>).signal_score ?? (row as Record<string, unknown>).score ?? 60) || 60,
          last_seen_at: lastSeen,
          raw_ref: `early_offmarket_signal_candidates:${(row as Record<string, unknown>).id}`,
          lat_raw: (row as Record<string, unknown>).lat ?? (row as Record<string, unknown>).latitude,
          lng_raw: (row as Record<string, unknown>).lng ?? (row as Record<string, unknown>).longitude,
        }));
        offmarketDiag.offmarket_published++;
      }
    }
  }

  // Batch resolve OMI zone via point-in-polygon for items still UNRESOLVED with valid coords
  try {
    const pending: { item: FeedItem; rec: Record<string, unknown> }[] = [];
    for (const it of rawItems) {
      if (it.zone_code === UNRESOLVED_OMI_CODE &&
          typeof it.lat === "number" && Number.isFinite(it.lat) &&
          typeof it.lng === "number" && Number.isFinite(it.lng) &&
          (it.lat !== 0 || it.lng !== 0)) {
        pending.push({ item: it, rec: { lat: it.lat, lng: it.lng } });
      }
    }
    if (pending.length > 0) {
      const resolutions = await resolvePadovaOmiBatch(pending.map((p) => p.rec), supabase);
      for (let i = 0; i < pending.length; i++) {
        const res = resolutions[i];
        if (res && res.omi_zone_code && res.omi_zone_code !== UNRESOLVED_OMI_CODE) {
          const it = pending[i].item;
          it.zone_code = res.omi_zone_code;
          it.zone_label = res.omi_zone_label || it.zone_label || UNRESOLVED_OMI_LABEL;
          if (!it.display_zone || it.display_zone === UNRESOLVED_OMI_LABEL) {
            it.display_zone = it.zone_label;
          }
          it.data_quality.flags = it.data_quality.flags.filter((f) => f !== "unresolved_zone");
          it.data_quality.score = Math.max(0, 100 - it.data_quality.flags.length * 30);
        }
      }
    }
  } catch (e) {
    console.error(`[civiko-one-signals-feed] batch OMI resolve error:`, (e as Error)?.message ?? e);
  }

  // Fallback resolve via public.quartiere_zona_map for items still UNRESOLVED
  // Applied to every signal_type that reached this point (contendibile, multi_portale,
  // privato, ribasso, off_market). Never invents a code: only remaps when a row exists.
  try {
    await applyQuartiereZonaMapFallback(supabase, rawItems);
  } catch (e) {
    console.error(`[civiko-one-signals-feed] quartiere_zona_map fallback error:`, (e as Error)?.message ?? e);
  }


  // Dedupe
  const { kept, removed: duplicatesRemoved } = dedupeItems(rawItems);

  // Sort & trim — freshness primary, score secondary (so new ingestions surface immediately)
  kept.sort((a, b) => {
    if (a.last_seen_at !== b.last_seen_at) return a.last_seen_at > b.last_seen_at ? -1 : 1;
    return b.score - a.score;
  });
  const trimmed = kept.slice(0, limit);

  const summary = {
    total: trimmed.length,
    contendibili: 0,
    multi_portale: 0,
    privati: 0,
    ribassi: 0,
    off_market: 0,
    unresolved_zone: 0,
    invalid_price: 0,
    duplicates_removed: duplicatesRemoved,
  };
  const countBySignalType: Record<string, number> = {};
  for (const it of trimmed) {
    countBySignalType[it.signal_type] = (countBySignalType[it.signal_type] ?? 0) + 1;
    if (it.signal_type === "contendibile") summary.contendibili++;
    else if (it.signal_type === "multi_portale") summary.multi_portale++;
    else if (it.signal_type === "ribasso") summary.ribassi++;
    else if (it.signal_type === "privato") summary.privati++;
    else if (it.signal_type === "off_market") summary.off_market++;
    if (it.zone_code === UNRESOLVED_OMI_CODE) summary.unresolved_zone++;
    if (it.data_quality.flags.includes("invalid_price")) summary.invalid_price++;
  }

  // Feed-level freshness extremes
  let oldestCreated: string | null = null, newestCreated: string | null = null;
  let oldestSeen: string | null = null, newestSeen: string | null = null;
  const uniqueSourceIds = new Set<string>();
  for (const it of trimmed) {
    uniqueSourceIds.add(it.source_id);
    const ls = it.last_seen_at;
    if (ls) {
      if (!oldestSeen || ls < oldestSeen) oldestSeen = ls;
      if (!newestSeen || ls > newestSeen) newestSeen = ls;
    }
    // FeedItem doesn't carry created_at separately; reuse last_seen_at as proxy
    if (ls) {
      if (!oldestCreated || ls < oldestCreated) oldestCreated = ls;
      if (!newestCreated || ls > newestCreated) newestCreated = ls;
    }
  }

  // Aggregate newest across all probed source tables
  let newestSourceCreated: string | null = null;
  let newestSourceUpdated: string | null = null;
  let newestSourceLastSeen: string | null = null;
  for (const v of Object.values(sourceFreshness)) {
    if (v.max_created_at && (!newestSourceCreated || v.max_created_at > newestSourceCreated)) newestSourceCreated = v.max_created_at;
    if (v.max_updated_at && (!newestSourceUpdated || v.max_updated_at > newestSourceUpdated)) newestSourceUpdated = v.max_updated_at;
    if (v.max_last_seen_at && (!newestSourceLastSeen || v.max_last_seen_at > newestSourceLastSeen)) newestSourceLastSeen = v.max_last_seen_at;
  }

  const generatedAt = new Date().toISOString();
  console.log(
    `[civiko-one-signals-feed] tenant=${tenantId} total=${summary.total} ` +
    `cont=${summary.contendibili} rib=${summary.ribassi} priv=${summary.privati} off=${summary.off_market} ` +
    `unresolved=${summary.unresolved_zone} invalid_price=${summary.invalid_price} dup=${summary.duplicates_removed} debug=${debugId}`,
  );

  return jsonResp({
    ok: true,
    schema_version: SCHEMA_VERSION,
    scope: { city, province, zone_mode: zoneMode },
    generated_at: generatedAt,
    summary,
    items: trimmed,
    diagnostics: await (async () => {
      // Agency real coverage per portal + idealista status
      const portals = ["casa", "immobiliare", "idealista", "subito"] as const;
      const agencyCoverage: Record<string, { total: number; with_real_agency: number; coverage_pct: number; last_seen: string | null }> = {};
      for (const p of portals) {
        try {
          const { count: total } = await supabase
            .from("padova_collect_v2_items")
            .select("id", { count: "exact", head: true })
            .eq("portal", p);
          const { count: withAg } = await supabase
            .from("padova_collect_v2_items")
            .select("id", { count: "exact", head: true })
            .eq("portal", p)
            .not("agency", "is", null)
            .neq("agency", "")
            .not("agency", "ilike", "portal:%");
          const { data: lastRow } = await supabase
            .from("padova_collect_v2_items")
            .select("created_at")
            .eq("portal", p)
            .order("created_at", { ascending: false })
            .limit(1);
          const t = total ?? 0;
          const w = withAg ?? 0;
          agencyCoverage[p] = {
            total: t,
            with_real_agency: w,
            coverage_pct: t > 0 ? Math.round((w / t) * 1000) / 10 : 0,
            last_seen: (lastRow?.[0]?.created_at as string) ?? null,
          };
        } catch {
          agencyCoverage[p] = { total: 0, with_real_agency: 0, coverage_pct: 0, last_seen: null };
        }
      }
      const ide = agencyCoverage["idealista"];
      const ideAgeDays = ide?.last_seen ? Math.floor((Date.now() - new Date(ide.last_seen).getTime()) / 86400000) : null;
      let idealistaStatus = "unknown";
      if (!ide || ide.total === 0) idealistaStatus = "no_data";
      else if (ide.with_real_agency === 0) idealistaStatus = ideAgeDays !== null && ideAgeDays > 7 ? "stale_no_agency_coverage" : "active_no_agency_coverage";
      else idealistaStatus = "active_with_agency_coverage";

      return {
        tenant_id: tenantId,
        generated_at: generatedAt,
        requested_limit: limit,
        included: include,
        sources_used: sourcesUsed,
        source_tables_used: sourcesUsed,
        last_provider_refresh: lastProviderRefresh,
        last_provider_refresh_at: sourceFreshness,
        newest_source_created_at: newestSourceCreated,
        newest_source_updated_at: newestSourceUpdated,
        newest_source_last_seen_at: newestSourceLastSeen,
        oldest_item_in_feed_created_at: oldestCreated,
        newest_item_in_feed_created_at: newestCreated,
        oldest_item_in_feed_last_seen_at: oldestSeen,
        newest_item_in_feed_last_seen_at: newestSeen,
        unique_source_ids_count: uniqueSourceIds.size,
        duplicate_candidates_removed: duplicatesRemoved,
        // Nuova tassonomia
        taxonomy_version: "v2_contendibile_strict_multi_portale_split",
        count_by_signal_type: countBySignalType,
        verified_contendibili_count: summary.contendibili,
        multi_portale_count: summary.multi_portale,
        false_contendibili_removed: 0,
        agency_real_coverage_by_portal: agencyCoverage,
        idealista_status: { status: idealistaStatus, last_seen: ide?.last_seen ?? null, age_days: ideAgeDays, total: ide?.total ?? 0, with_real_agency: ide?.with_real_agency ?? 0 },
        first_10_source_ids: trimmed.slice(0, 10).map((it) => it.source_id),
        cache_hit: false,
        cache_key: null,
        upstream_refresh_status: newestSourceCreated && (Date.now() - new Date(newestSourceCreated).getTime() < 24 * 3600 * 1000) ? "fresh" : "stale",
        sort_strategy: "freshness_desc,score_desc",
        ribassi: ribassiDiag,
        offmarket: offmarketDiag,
        security_gate: "ok",
        debug_id: debugId,
      };
    })(),
  });
});
