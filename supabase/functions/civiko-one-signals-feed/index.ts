// Civiko One — Signals Feed (server-to-server only)
// POST /civiko-one-signals-feed
// Aggregates Padova signals from existing Core tables into a single feed.
// Protected with HMAC-SHA256 signature. Schema: civiko_signals_feed_v1

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  resolvePadovaOmiSync,
  UNRESOLVED_OMI_CODE,
  UNRESOLVED_OMI_LABEL,
} from "../_shared/padovaOmiResolver.ts";

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

type SignalType = "contendibile" | "ribasso" | "privato" | "off_market";

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
}

function resolveZone(record: Record<string, unknown>): { code: string; label: string } {
  try {
    const r = resolvePadovaOmiSync(record);
    if (r && r.code) return { code: r.code, label: r.label || UNRESOLVED_OMI_LABEL };
  } catch (_) { /* fall through */ }
  const omi = (record.omi_zone as string) || "";
  if (omi && omi.trim()) return { code: omi.trim(), label: (record.quartiere as string) || omi };
  const quart = (record.quartiere as string) || "";
  if (quart && quart.trim()) {
    return { code: UNRESOLVED_OMI_CODE, label: quart.trim() };
  }
  return { code: UNRESOLVED_OMI_CODE, label: UNRESOLVED_OMI_LABEL };
}

function buildItem(
  partial: Partial<FeedItem> & { signal_type: SignalType; source_id: string; price_raw?: unknown },
): FeedItem {
  const zone_code = partial.zone_code && partial.zone_code.trim() ? partial.zone_code : UNRESOLVED_OMI_CODE;
  const zone_label = partial.zone_label && partial.zone_label.trim() ? partial.zone_label : UNRESOLVED_OMI_LABEL;
  const norm = normalizePrice(partial.price_raw ?? partial.price);
  const flags: string[] = [];
  if (norm.invalid) flags.push("invalid_price");
  if (zone_code === UNRESOLVED_OMI_CODE) flags.push("unresolved_zone");
  const qualityScore = Math.max(0, 100 - flags.length * 30);
  return {
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
    data_quality: { score: qualityScore, flags, needs_review: flags.includes("invalid_price") },
  };
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

  // CONTENDIBILI — from padova_contendibili (already computed cross-portal matches)
  if (includeSet.has("contendibili")) {
    const { data, error } = await supabase
      .from("padova_contendibili")
      .select("id, chiave_match, n_agenzie, confidenza, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, created_at, prezzo_immobile_eur_mq, differenza_zona_pct, giorni_sul_mercato")
      .gte("n_agenzie", 2)
      .order("n_agenzie", { ascending: false })
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
        // Pick midpoint when both available, else whichever is set
        const priceCandidate = minP && maxP ? Math.round((minP + maxP) / 2) : (maxP || minP || null);
        const lastSeen = (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const urls = Array.isArray(row.urls) ? (row.urls as string[]) : [];
        const nAg = Number(row.n_agenzie) || 0;
        const conf = String(row.confidenza || "");
        const score = Math.min(100, 40 + Math.min(nAg, 10) * 4 + (rank[conf] || 0));
        const title = String(row.chiave_match || `Contendibile ${row.id}`)
          .split("|")[0]
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        rawItems.push(buildItem({
          source_id: `cont:${row.id}`,
          signal_type: "contendibile",
          title: `${title} — ${nAg} agenzie`,
          city, province,
          zone_code: z.code,
          zone_label: z.label,
          display_zone: z.label,
          price_raw: priceCandidate,
          url: urls[0] || "",
          status: "active",
          score,
          last_seen_at: lastSeen,
          raw_ref: `padova_contendibili:${row.id}`,
        }));
      }
    }
  }

  // RIBASSI + PRIVATI from padova_collect_v2_items
  const needCollect = includeSet.has("ribassi") || includeSet.has("privati");
  if (needCollect) {
    const { data, error } = await supabase
      .from("padova_collect_v2_items")
      .select("id, portal, listing_id, url, raw_address, citta, cap, lat, lng, omi_zone, quartiere, prezzo, prezzo_iniziale, mq, locali, agency, contendibile, created_at, processed_at")
      .order("processed_at", { ascending: false, nullsFirst: false })
      .limit(limit * 2);
    if (error) {
      console.error(`[civiko-one-signals-feed] padova_collect_v2_items error:`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_collect_v2_items");
      for (const row of data as Record<string, unknown>[]) {
        const z = resolveZone(row);
        const price = Number(row.prezzo ?? 0) || 0;
        const initial = Number(row.prezzo_iniziale ?? 0) || 0;
        const lastSeen = (row.processed_at as string) || (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const baseTitle = (row.raw_address as string) || (row.listing_id as string) || `Listing ${row.id}`;
        const base = {
          source_id: `pdv:${row.id}`,
          title: baseTitle,
          city, province,
          zone_code: z.code,
          zone_label: z.label,
          display_zone: z.label,
          url: (row.url as string) || "",
          status: "active",
          last_seen_at: lastSeen,
          raw_ref: `padova_collect_v2_items:${row.id}`,
        };
        if (includeSet.has("ribassi") && initial > 0 && price > 0 && price < initial) {
          const dropPct = Math.round(((initial - price) / initial) * 100);
          rawItems.push(buildItem({
            ...base,
            signal_type: "ribasso",
            price_raw: price,
            score: Math.min(100, 50 + dropPct),
            title: `${baseTitle} — ribasso ${dropPct}%`,
          }));
        } else if (includeSet.has("privati") && (!row.agency || String(row.agency).trim() === "")) {
          rawItems.push(buildItem({
            ...base,
            signal_type: "privato",
            price_raw: price,
            score: 55,
          }));
        }
      }
    }
  }

  // OFF_MARKET
  if (includeSet.has("off_market")) {
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
        const z = resolveZone(row);
        const lastSeen = (row.updated_at as string) || (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        rawItems.push(buildItem({
          source_id: `offm:${row.id}`,
          signal_type: "off_market",
          title: (row.title as string) || (row.address_text as string) || `Off-market ${row.id}`,
          city, province,
          zone_code: z.code,
          zone_label: z.label,
          display_zone: z.label,
          price_raw: row.estimated_price ?? row.price ?? null,
          url: (row.source_url as string) || "",
          status: (row.status as string) || "active",
          score: Number(row.signal_score ?? row.score ?? 60) || 60,
          last_seen_at: lastSeen,
          raw_ref: `early_offmarket_signal_candidates:${row.id}`,
        }));
      }
    }
  }

  // Dedupe
  const { kept, removed: duplicatesRemoved } = dedupeItems(rawItems);

  // Sort & trim
  kept.sort((a, b) => b.score - a.score || (b.last_seen_at > a.last_seen_at ? 1 : -1));
  const trimmed = kept.slice(0, limit);

  const summary = {
    total: trimmed.length,
    contendibili: 0,
    privati: 0,
    ribassi: 0,
    off_market: 0,
    unresolved_zone: 0,
    invalid_price: 0,
    duplicates_removed: duplicatesRemoved,
  };
  for (const it of trimmed) {
    if (it.signal_type === "contendibile") summary.contendibili++;
    else if (it.signal_type === "ribasso") summary.ribassi++;
    else if (it.signal_type === "privato") summary.privati++;
    else if (it.signal_type === "off_market") summary.off_market++;
    if (it.zone_code === UNRESOLVED_OMI_CODE) summary.unresolved_zone++;
    if (it.data_quality.flags.includes("invalid_price")) summary.invalid_price++;
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
    diagnostics: {
      tenant_id: tenantId,
      generated_at: generatedAt,
      requested_limit: limit,
      included: include,
      sources_used: sourcesUsed,
      last_provider_refresh: lastProviderRefresh,
      security_gate: "ok",
      debug_id: debugId,
    },
  });
});
