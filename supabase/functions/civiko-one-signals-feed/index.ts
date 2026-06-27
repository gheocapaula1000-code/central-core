// Civiko One — Signals Feed (server-to-server only)
// POST /civiko-one-signals-feed
// Aggregates Padova signals from existing Core tables into a single feed.
// Protected with HMAC-SHA256 signature. Schema: civiko_signals_feed_v1
//
// Required headers:
//   x-source-app:   civiko-one
//   x-tenant-id:    <tenant>
//   x-timestamp:    <unix ms or ISO>
//   x-core-signature: HMAC_SHA256(timestamp + tenant + rawBody, CORE_SHARED_SECRET) hex

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

type SignalType = "contendibile" | "ribasso" | "privato" | "off_market";

interface FeedItem {
  source_id: string;
  signal_type: SignalType;
  title: string;
  city: string;
  province: string;
  zone_code: string;
  zone_label: string;
  display_zone: string;
  price: number;
  url: string;
  status: string;
  score: number;
  last_seen_at: string;
  raw_ref: string;
}

function normalizeItem(
  partial: Partial<FeedItem> & { signal_type: SignalType; source_id: string },
): FeedItem {
  const zone_code = partial.zone_code && partial.zone_code.trim() ? partial.zone_code : UNRESOLVED_OMI_CODE;
  const zone_label = partial.zone_label && partial.zone_label.trim() ? partial.zone_label : UNRESOLVED_OMI_LABEL;
  return {
    source_id: partial.source_id,
    signal_type: partial.signal_type,
    title: partial.title?.trim() || "(senza titolo)",
    city: partial.city?.trim() || "Padova",
    province: (partial.province || "PD").toUpperCase(),
    zone_code,
    zone_label,
    display_zone: partial.display_zone?.trim() || zone_label,
    price: Number.isFinite(partial.price as number) ? Number(partial.price) : 0,
    url: partial.url || "",
    status: partial.status || "active",
    score: Number.isFinite(partial.score as number) ? Number(partial.score) : 0,
    last_seen_at: partial.last_seen_at || new Date().toISOString(),
    raw_ref: partial.raw_ref || "",
  };
}

function resolveZone(record: Record<string, unknown>): { code: string; label: string } {
  try {
    const r = resolvePadovaOmiSync(record);
    if (r && r.code) {
      return { code: r.code, label: r.label || UNRESOLVED_OMI_LABEL };
    }
  } catch (_) { /* fall through */ }
  const omi = (record.omi_zone as string) || "";
  if (omi && omi.trim()) return { code: omi.trim(), label: (record.quartiere as string) || omi };
  return { code: UNRESOLVED_OMI_CODE, label: UNRESOLVED_OMI_LABEL };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const debugId = crypto.randomUUID();

  if (req.method !== "POST") {
    return err("METHOD_NOT_ALLOWED", "Use POST", 405, debugId);
  }

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
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return err("INVALID_JSON", "Body is not valid JSON", 400, debugId);
  }
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

  const items: FeedItem[] = [];
  const sourcesUsed: string[] = [];
  let lastProviderRefresh: string | null = null;

  // Helper: track most recent timestamp
  const bump = (ts?: string | null) => {
    if (!ts) return;
    if (!lastProviderRefresh || ts > lastProviderRefresh) lastProviderRefresh = ts;
  };

  // CONTENDIBILI + RIBASSI + PRIVATI share the same base table
  const needCollect = includeSet.has("contendibili") || includeSet.has("ribassi") || includeSet.has("privati");
  if (needCollect) {
    const { data, error } = await supabase
      .from("padova_collect_v2_items")
      .select(
        "id, portal, listing_id, url, raw_address, citta, cap, lat, lng, omi_zone, quartiere, prezzo, prezzo_iniziale, mq, locali, agency, contendibile, contendibile_confidenza, created_at, processed_at, raw_json",
      )
      .order("processed_at", { ascending: false, nullsFirst: false })
      .limit(limit * 2);

    if (error) {
      console.error(`[civiko-one-signals-feed] padova_collect_v2_items error:`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_collect_v2_items");
      for (const row of data) {
        const z = resolveZone(row as Record<string, unknown>);
        const price = Number(row.prezzo ?? 0) || 0;
        const initial = Number(row.prezzo_iniziale ?? 0) || 0;
        const lastSeen = (row.processed_at as string) || (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const base = {
          source_id: `pdv:${row.id}`,
          title: (row.raw_address as string) || (row.listing_id as string) || `Listing ${row.id}`,
          city, province,
          zone_code: z.code,
          zone_label: z.label,
          display_zone: z.label,
          price,
          url: (row.url as string) || "",
          status: "active",
          score: 0,
          last_seen_at: lastSeen,
          raw_ref: `padova_collect_v2_items:${row.id}`,
        };
        if (includeSet.has("contendibili") && row.contendibile === true) {
          items.push(normalizeItem({ ...base, signal_type: "contendibile", score: 70 }));
        } else if (includeSet.has("ribassi") && initial > 0 && price > 0 && price < initial) {
          const dropPct = Math.round(((initial - price) / initial) * 100);
          items.push(
            normalizeItem({
              ...base,
              signal_type: "ribasso",
              score: Math.min(100, 50 + dropPct),
              title: `${base.title} — ribasso ${dropPct}%`,
            }),
          );
        } else if (includeSet.has("privati") && (!row.agency || String(row.agency).trim() === "")) {
          items.push(normalizeItem({ ...base, signal_type: "privato", score: 55 }));
        }
      }
    }
  }

  // OFF_MARKET — early_offmarket_signal_candidates
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
        items.push(
          normalizeItem({
            source_id: `offm:${row.id}`,
            signal_type: "off_market",
            title: (row.title as string) || (row.address_text as string) || `Off-market ${row.id}`,
            city, province,
            zone_code: z.code,
            zone_label: z.label,
            display_zone: z.label,
            price: Number(row.estimated_price ?? row.price ?? 0) || 0,
            url: (row.source_url as string) || "",
            status: (row.status as string) || "active",
            score: Number(row.signal_score ?? row.score ?? 60) || 60,
            last_seen_at: lastSeen,
            raw_ref: `early_offmarket_signal_candidates:${row.id}`,
          }),
        );
      }
    }
  }

  // Trim & sort
  items.sort((a, b) => b.score - a.score || (b.last_seen_at > a.last_seen_at ? 1 : -1));
  const trimmed = items.slice(0, limit);

  const breakdown = {
    contendibili: 0,
    ribassi: 0,
    privati: 0,
    off_market: 0,
    unresolved_zone: 0,
  };
  for (const it of trimmed) {
    if (it.signal_type === "contendibile") breakdown.contendibili++;
    else if (it.signal_type === "ribasso") breakdown.ribassi++;
    else if (it.signal_type === "privato") breakdown.privati++;
    else if (it.signal_type === "off_market") breakdown.off_market++;
    if (it.zone_code === UNRESOLVED_OMI_CODE) breakdown.unresolved_zone++;
  }

  const generatedAt = new Date().toISOString();

  console.log(
    `[civiko-one-signals-feed] tenant=${tenantId} total=${trimmed.length} ` +
      `cont=${breakdown.contendibili} rib=${breakdown.ribassi} priv=${breakdown.privati} ` +
      `off=${breakdown.off_market} unresolved=${breakdown.unresolved_zone} debug=${debugId}`,
  );

  return jsonResp({
    ok: true,
    schema_version: SCHEMA_VERSION,
    scope: { city, province, zone_mode: zoneMode },
    generated_at: generatedAt,
    summary: {
      total: trimmed.length,
      contendibili: breakdown.contendibili,
      ribassi: breakdown.ribassi,
      privati: breakdown.privati,
      off_market: breakdown.off_market,
      unresolved_zone: breakdown.unresolved_zone,
    },
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
