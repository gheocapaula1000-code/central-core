// Civiko One — Signals Feed (server-to-server, zone-isolated).
// POST /civiko-one-signals-feed
//
// Contract:
//   HMAC-SHA256 su (x-timestamp | x-tenant-id | body).
//   x-tenant-id (già coperto dalla firma) È il workspace UUID.
//   Il workspace ha esattamente UNA zona commerciale ufficiale, risolta
//   server-side da public.civiko_commercial_zones (occupata / in_trial).
//   OGNI query, RPC, conteggio, freshness probe applica il filtro zona
//   direttamente nel DB tramite viste server-only:
//     - public.padova_contendibili_by_zone_v
//     - public.padova_multi_portale_by_zone_v
//     - public.padova_collect_v2_items_by_zone_v
//     - public.get_padova_verified_price_drops_by_zone(...)
//   Nessuna fetch globale seguita da filtro/arricchimento in memoria.
//   Nessun fallback permissivo: fallimento risoluzione → 403 fail-closed.
//   Il client non può scegliere workspace, zona o città: Padova/PD forzati.
//
// Schema di risposta: civiko_signals_feed_v1 (immutato).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  resolvePadovaOmiBatch,
} from "../_shared/padovaOmiResolver.ts";
import {
  resolveZoneFromRecord,
  applyQuartiereZonaMapFallback,
  UNRESOLVED_OMI_CODE,
  UNRESOLVED_OMI_LABEL,
} from "../_shared/padovaZoneResolver.ts";
import { isAuctionRecord } from "../_shared/auctionExclusion.ts";
import { isCivikoCommercialZoneSlug } from "../_shared/civikoCommercialZoneContract.ts";

const SCHEMA_VERSION = "civiko_signals_feed_v1";
const MAX_SKEW_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Città/provincia FORZATE server-side. Il client non può alterarle.
const FORCED_CITY = "Padova";
const FORCED_PROVINCE = "PD";

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
  evidence_type?: string;
  label_pubblica?: string;
  portals_seen?: string[];
  agency_count_distinct?: number;
  agencies_normalized?: string[];
  needs_review?: boolean;
  operator_note?: string;
  ribasso_pct?: number;
  initial_price_eur?: number;
  current_price_eur?: number;
  drops_count?: number;
  observations_count?: number;
  first_seen_at?: string;
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

// buildItem — riceve SEMPRE lo slug autorizzato (assignedSlug) dal caller.
// Non tenta più di leggere/propagare uno slug alternativo.
function buildItem(
  authorizedSlug: string,
  partial: Partial<FeedItem> & {
    signal_type: SignalType;
    source_id: string;
    price_raw?: unknown;
    lat_raw?: unknown;
    lng_raw?: unknown;
  },
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
    city: FORCED_CITY,
    province: FORCED_PROVINCE,
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
    // Slug commerciale = SEMPRE la zona autorizzata. Nessuna scelta client-side.
    commercial_zone_slug: authorizedSlug,
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
  if (
    typeof partial.observations_count === "number" &&
    Number.isFinite(partial.observations_count) &&
    Number.isInteger(partial.observations_count) &&
    partial.observations_count >= 0
  ) {
    item.observations_count = partial.observations_count;
  }
  if (typeof partial.first_seen_at === "string" && partial.first_seen_at.trim() !== "") {
    const t = Date.parse(partial.first_seen_at);
    if (Number.isFinite(t)) item.first_seen_at = partial.first_seen_at;
  }
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

  // ── Security gate: HMAC (invariato) ───────────────────────
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

  // ── Workspace identity (tenantId è l'unica fonte) ─────────
  const workspaceId = tenantId.trim();
  if (!UUID_RE.test(workspaceId)) {
    return err("INVALID_WORKSPACE", "x-tenant-id must be a valid workspace UUID", 401, debugId);
  }

  // ── Parse body (city/province/workspace CLIENT-SIDE IGNORATI) ──
  let body: Record<string, unknown> = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch { return err("INVALID_JSON", "Body is not valid JSON", 400, debugId); }

  // Città/provincia sempre forzate. I campi city, province, workspace identity
  // e slug commerciale eventualmente presenti nel body vengono ignorati.
  const city = FORCED_CITY;
  const province = FORCED_PROVINCE;
  const zoneMode = (typeof body.zone_mode === "string" && body.zone_mode) || "omi_microzone";
  const limit = Math.max(1, Math.min(Number(body.limit) || 250, 1000));
  const include = Array.isArray(body.include) && body.include.length
    ? (body.include as string[]).filter((s) => typeof s === "string")
    : ["contendibili", "ribassi", "privati", "off_market"];
  const includeSet = new Set(include);

  // ── Supabase client (service_role) ────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // ── Server-side zone resolution (identica a padova-contendibili-list) ─
  const { data: zonesRows, error: zoneErr } = await supabase
    .from("civiko_commercial_zones")
    .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
    .or(
      `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
        `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
    );
  if (zoneErr) {
    console.error(`[civiko-one-signals-feed] ${debugId} zone lookup`, zoneErr.message);
    return err("DB_ERROR", "zone lookup failed", 500, debugId);
  }
  const now = Date.now();
  const valid = (zonesRows ?? []).filter((z: Record<string, unknown>) => {
    if (z.status === "occupata" && z.occupied_agency_id === workspaceId) return true;
    if (
      z.status === "in_trial" &&
      z.trial_agency_id === workspaceId &&
      typeof z.trial_reserved_until === "string" &&
      new Date(z.trial_reserved_until as string).getTime() > now
    ) return true;
    return false;
  });
  if (valid.length === 0) {
    return err("NO_ZONE_ASSIGNED", "No active zone for workspace", 403, debugId);
  }
  if (valid.length > 1) {
    return err("MULTIPLE_ZONES_ASSIGNED", "Ambiguous zone assignment", 403, debugId);
  }
  const assignedSlug = String(valid[0].slug ?? "");
  if (!isCivikoCommercialZoneSlug(assignedSlug)) {
    return err("SLUG_OUT_OF_CONTRACT", "Assigned slug not in contract", 403, debugId);
  }

  // display_zone resolution — server-side, contratto ufficiale.
  // Il DB (viste *_by_zone_v e vincoli) risolve la zona di ogni riga via
  // public.civiko_resolve_commercial_zone_slug(quartiere) e la filtra su
  // assignedSlug. Qui carichiamo UNA sola volta la mappa slug→name da
  // public.civiko_commercial_zones e la usiamo come cache in memoria:
  // niente query per riga, nessun helper locale di risoluzione.
  const slugToName = new Map<string, string>();
  try {
    const { data: zoneNameRows } = await supabase
      .from("civiko_commercial_zones")
      .select("slug, name");
    for (const r of (zoneNameRows ?? []) as Array<Record<string, unknown>>) {
      const s = typeof r.slug === "string" ? r.slug : "";
      const n = typeof r.name === "string" ? r.name : "";
      if (s && n) slugToName.set(s, n);
    }
  } catch (e) {
    console.error(`[civiko-one-signals-feed] ${debugId} slug→name lookup error:`, (e as Error)?.message ?? e);
  }
  const canonicalDisplayZone = slugToName.get(assignedSlug) ?? "Altre zone";



  const rawItems: FeedItem[] = [];
  const sourcesUsed: string[] = [];
  let lastProviderRefresh: string | null = null;
  const bump = (ts?: string | null) => {
    if (!ts) return;
    if (!lastProviderRefresh || ts > lastProviderRefresh) lastProviderRefresh = ts;
  };

  // Freshness probes — SEMPRE con filtro zona lato DB.
  const sourceFreshness: Record<string, { max_created_at: string | null; max_updated_at: string | null; max_last_seen_at: string | null; rows_last_24h: number | null }> = {};
  async function probeFreshnessByZone(
    table: string,
    hasUpdated: boolean,
    hasLastSeen: boolean,
  ) {
    try {
      const cols = ["created_at"];
      if (hasUpdated) cols.push("updated_at");
      if (hasLastSeen) cols.push("last_seen_at");
      const { data } = await supabase
        .from(table)
        .select(cols.join(","))
        .eq("commercial_zone_slug", assignedSlug)
        .order("created_at", { ascending: false })
        .limit(1);
      const top = (data && data[0]) as Record<string, unknown> | undefined;
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("commercial_zone_slug", assignedSlug)
        .gte("created_at", since);
      sourceFreshness[table] = {
        max_created_at: (top?.created_at as string) ?? null,
        max_updated_at: hasUpdated ? (top?.updated_at as string) ?? null : null,
        max_last_seen_at: hasLastSeen ? (top?.last_seen_at as string) ?? null : null,
        rows_last_24h: count ?? null,
      };
    } catch {
      sourceFreshness[table] = { max_created_at: null, max_updated_at: null, max_last_seen_at: null, rows_last_24h: null };
    }
  }

  // ── CONTENDIBILI — padova_contendibili_by_zone_v, filtro DB ───────
  if (includeSet.has("contendibili")) {
    await probeFreshnessByZone("padova_contendibili_by_zone_v", false, false);
    const { data, error } = await supabase
      .from("padova_contendibili_by_zone_v")
      .select("id, chiave_match, n_agenzie, agency_count_distinct, agencies_normalized, agenzie, portals_seen, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, created_at, commercial_zone_slug")
      .eq("commercial_zone_slug", assignedSlug)
      .or("agency_count_distinct.gte.2,and(agency_count_distinct.is.null,n_agenzie.gte.2)")
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("agency_count_distinct", { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[civiko-one-signals-feed] ${debugId} contendibili`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_contendibili_by_zone_v");
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
        rawItems.push(buildItem(assignedSlug, {
          source_id: `cont:${row.id}`,
          signal_type: "contendibile",
          title: `${title} — ${nAg} agenzie distinte`,
          zone_code: z.code, zone_label: z.label, display_zone: canonicalDisplayZone,

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

  // ── MULTI-PORTALE — padova_multi_portale_by_zone_v, filtro DB ────
  if (includeSet.has("contendibili") || includeSet.has("multi_portale")) {
    await probeFreshnessByZone("padova_multi_portale_by_zone_v", false, false);
    const { data, error } = await supabase
      .from("padova_multi_portale_by_zone_v")
      .select("id, chiave_match, portal_count, portals_seen, agency_count_distinct, agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, n_annunci, created_at, commercial_zone_slug")
      .eq("commercial_zone_slug", assignedSlug)
      .gte("portal_count", 2)
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("portal_count", { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[civiko-one-signals-feed] ${debugId} multi_portale`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_multi_portale_by_zone_v");
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
        rawItems.push(buildItem(assignedSlug, {
          source_id: `mp:${row.id}`,
          signal_type: "multi_portale",
          title: `${title} — ${nPortals} portali`,
          zone_code: z.code, zone_label: z.label, display_zone: canonicalDisplayZone,

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

  // ── RIBASSI — RPC by_zone con parametro OBBLIGATORIO ────────────
  // NIENTE fallback su padova_collect_v2_items: fail-closed su errore RPC.
  const ribassiDiag = {
    ribassi_rpc_returned: 0,
    ribassi_auction_excluded: 0,
    ribassi_unzoned_excluded: 0,
    ribassi_invalid_price_excluded: 0,
    ribassi_source: "unused" as "listing_price_snapshots" | "unused" | "rpc_error",
  };
  if (includeSet.has("ribassi")) {
    ribassiDiag.ribassi_source = "listing_price_snapshots";
    const { data: rpcRows, error: rpcErr } = await supabase.rpc(
      "get_padova_verified_price_drops_by_zone",
      {
        p_commercial_zone_slug: assignedSlug,
        p_limit: limit,
        p_min_drop_pct: 5,
        p_max_age_days: 14,
      },
    );
    if (rpcErr) {
      // Fail-closed: nessun fallback.
      ribassiDiag.ribassi_source = "rpc_error";
      console.error(`[civiko-one-signals-feed] ${debugId} ribassi RPC error: ${rpcErr.message}`);
    } else if (Array.isArray(rpcRows)) {
      sourcesUsed.push("get_padova_verified_price_drops_by_zone");
      ribassiDiag.ribassi_rpc_returned = rpcRows.length;
      for (const row of rpcRows as Record<string, unknown>[]) {
        // Difesa in profondità: la RPC filtra già, ma verifichiamo lo slug.
        const slug = (row.commercial_zone_slug as string) || "";
        if (slug !== assignedSlug) { ribassiDiag.ribassi_unzoned_excluded++; continue; }
        if (isAuctionRecord(row)) { ribassiDiag.ribassi_auction_excluded++; continue; }
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
        rawItems.push(buildItem(assignedSlug, {
          source_id: `drop:${row.source_id ?? row.listing_id ?? url}`,
          signal_type: "ribasso",
          title: `${title} — ribasso ${dropPct}%`,
          zone_code: omiCode || UNRESOLVED_OMI_CODE,
          zone_label: zoneLabel,
          display_zone: canonicalDisplayZone,
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
          observations_count: typeof row.observations_count === "number" && Number.isFinite(row.observations_count)
            ? row.observations_count
            : undefined,
          first_seen_at: typeof row.first_seen_at === "string" ? row.first_seen_at : undefined,
          omi_zone_code: omiCode || undefined,
        }));
      }
    }
  }

  // ── PRIVATI — padova_collect_v2_items_by_zone_v, filtro DB ───────
  if (includeSet.has("privati")) {
    await probeFreshnessByZone("padova_collect_v2_items_by_zone_v", false, false);
    const { data, error } = await supabase
      .from("padova_collect_v2_items_by_zone_v")
      .select("id, portal, listing_id, url, raw_address, citta, cap, lat, lng, omi_zone, quartiere, prezzo, mq, locali, agency, contendibile, created_at, processed_at, commercial_zone_slug")
      .eq("commercial_zone_slug", assignedSlug)
      .order("processed_at", { ascending: false, nullsFirst: false })
      .limit(limit * 2);
    if (error) {
      console.error(`[civiko-one-signals-feed] ${debugId} privati`, error.message);
    } else if (data) {
      sourcesUsed.push("padova_collect_v2_items_by_zone_v");
      for (const row of data as Record<string, unknown>[]) {
        if (isAuctionRecord(row)) continue;
        if (row.agency && String(row.agency).trim() !== "") continue;
        const z = resolveZone(row);
        const price = Number(row.prezzo ?? 0) || 0;
        const lastSeen = (row.processed_at as string) || (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const baseTitle = (row.raw_address as string) || (row.listing_id as string) || `Listing ${row.id}`;
        rawItems.push(buildItem(assignedSlug, {
          source_id: `pdv:${row.id}`,
          signal_type: "privato",
          title: baseTitle,
          zone_code: z.code, zone_label: z.label, display_zone: canonicalDisplayZone,
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

  // ── OFF-MARKET — DISABILITATO (fail-closed) ─────────────────────
  // La tabella early_offmarket_signal_candidates non espone quartiere/OMI
  // affidabile: senza una colonna zona non è possibile applicare un
  // filtro DB-side. Fino a quando non sarà disponibile una vista
  // early_offmarket_signal_candidates_by_zone_v con commercial_zone_slug
  // derivato in modo autoritativo, questa fonte NON viene mai letta.
  const offmarketDiag = {
    offmarket_candidates_read: 0,
    offmarket_privacy_excluded: 0,
    offmarket_auction_excluded: 0,
    offmarket_not_importable_excluded: 0,
    offmarket_published: 0,
    offmarket_disabled_reason: includeSet.has("off_market")
      ? "no_reliable_zone_column_fail_closed"
      : "not_included_in_request",
  };

  // ── Arricchimento OMI (SOLO display, nessuna implicazione di authz) ─
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
          // display_zone NON viene toccato qui: resta il nome canonico
          // derivato server-side dal contratto (slug→name).

          it.data_quality.flags = it.data_quality.flags.filter((f) => f !== "unresolved_zone");
          it.data_quality.score = Math.max(0, 100 - it.data_quality.flags.length * 30);
        }
      }
    }
  } catch (e) {
    console.error(`[civiko-one-signals-feed] batch OMI display enrichment error:`, (e as Error)?.message ?? e);
  }

  try {
    await applyQuartiereZonaMapFallback(supabase, rawItems);
  } catch (e) {
    console.error(`[civiko-one-signals-feed] quartiere_zona_map display fallback error:`, (e as Error)?.message ?? e);
  }

  // display_zone canonico e stabile per tutti gli item: nome ufficiale
  // della zona autorizzata da public.civiko_commercial_zones, "Altre zone"
  // se il resolver non è risolvibile per il workspace.
  for (const it of rawItems) {
    it.display_zone = canonicalDisplayZone;
  }

  // Difesa in profondità finale: TUTTI gli item devono portare lo slug
  // autorizzato. Se qualcosa non l'ha (impossibile per costruzione),
  // viene scartato — MAI riemesso senza slug.
  const preAssertCount = rawItems.length;
  const zoneAsserted = rawItems.filter((it) => it.commercial_zone_slug === assignedSlug);
  const droppedByAssert = preAssertCount - zoneAsserted.length;
  if (droppedByAssert > 0) {
    console.error(`[civiko-one-signals-feed] ${debugId} FINAL_ASSERT dropped=${droppedByAssert}`);
  }

  const { kept, removed: duplicatesRemoved } = dedupeItems(zoneAsserted);

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

  let oldestCreated: string | null = null, newestCreated: string | null = null;
  let oldestSeen: string | null = null, newestSeen: string | null = null;
  const uniqueSourceIds = new Set<string>();
  for (const it of trimmed) {
    uniqueSourceIds.add(it.source_id);
    const ls = it.last_seen_at;
    if (ls) {
      if (!oldestSeen || ls < oldestSeen) oldestSeen = ls;
      if (!newestSeen || ls > newestSeen) newestSeen = ls;
      if (!oldestCreated || ls < oldestCreated) oldestCreated = ls;
      if (!newestCreated || ls > newestCreated) newestCreated = ls;
    }
  }

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
    `[civiko-one-signals-feed] tenant=${workspaceId} zone=${assignedSlug} total=${summary.total} ` +
    `cont=${summary.contendibili} rib=${summary.ribassi} priv=${summary.privati} ` +
    `unresolved=${summary.unresolved_zone} invalid_price=${summary.invalid_price} dup=${summary.duplicates_removed} debug=${debugId}`,
  );

  // Copertura agenzia per portale — SEMPRE scoped alla zona autorizzata.
  const portals = ["casa", "immobiliare", "idealista", "subito"] as const;
  const agencyCoverage: Record<string, { total: number; with_real_agency: number; coverage_pct: number; last_seen: string | null }> = {};
  for (const p of portals) {
    try {
      const { count: total } = await supabase
        .from("padova_collect_v2_items_by_zone_v")
        .select("id", { count: "exact", head: true })
        .eq("commercial_zone_slug", assignedSlug)
        .eq("portal", p);
      const { count: withAg } = await supabase
        .from("padova_collect_v2_items_by_zone_v")
        .select("id", { count: "exact", head: true })
        .eq("commercial_zone_slug", assignedSlug)
        .eq("portal", p)
        .not("agency", "is", null)
        .neq("agency", "")
        .not("agency", "ilike", "portal:%");
      const { data: lastRow } = await supabase
        .from("padova_collect_v2_items_by_zone_v")
        .select("created_at")
        .eq("commercial_zone_slug", assignedSlug)
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

  return jsonResp({
    ok: true,
    schema_version: SCHEMA_VERSION,
    scope: { city, province, zone_mode: zoneMode, commercial_zone_slug: assignedSlug },
    generated_at: generatedAt,
    summary,
    items: trimmed,
    diagnostics: {
      tenant_id: workspaceId,
      workspace_id: workspaceId,
      assigned_zone: assignedSlug,
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
      taxonomy_version: "v3_zone_isolated_db_filter",
      count_by_signal_type: countBySignalType,
      verified_contendibili_count: summary.contendibili,
      multi_portale_count: summary.multi_portale,
      false_contendibili_removed: 0,
      dropped_by_final_zone_assert: droppedByAssert,
      agency_real_coverage_by_portal: agencyCoverage,
      idealista_status: { status: idealistaStatus, last_seen: ide?.last_seen ?? null, age_days: ideAgeDays, total: ide?.total ?? 0, with_real_agency: ide?.with_real_agency ?? 0 },
      first_10_source_ids: trimmed.slice(0, 10).map((it) => it.source_id),
      cache_hit: false,
      cache_key: null,
      upstream_refresh_status: newestSourceCreated && (Date.now() - new Date(newestSourceCreated).getTime() < 24 * 3600 * 1000) ? "fresh" : "stale",
      sort_strategy: "freshness_desc,score_desc",
      ribassi: ribassiDiag,
      offmarket: offmarketDiag,
      commercial_zone_scope: "db_side_zone_filter_only",
      security_gate: "ok",
      debug_id: debugId,
    },
  });
});
