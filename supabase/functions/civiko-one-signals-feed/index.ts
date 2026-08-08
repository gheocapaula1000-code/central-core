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
import { commercialZoneForQuartiere } from "../_shared/civikoCommercialZoneByQuartiere.ts";
import {
  applyCivikoSingleZoneGate,
} from "../_shared/civikoZoneAccessGate.ts";
import { corsHeaders as buildCorsHeaders, handleOptions, requireSecret, makeDebugId } from "../_shared/http.ts";

const SCHEMA_VERSION = "civiko_signals_feed_v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Città/provincia FORZATE server-side. Il client non può alterarle.
const FORCED_CITY = "Padova";
const FORCED_PROVINCE = "PD";

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
    price_optional?: boolean; // off_market: NULL price is legitimate, no invalid_price flag
    price_label_override?: string;
    lat_raw?: unknown;
    lng_raw?: unknown;
  },
): FeedItem {
  const zone_code = partial.zone_code && partial.zone_code.trim() ? partial.zone_code : UNRESOLVED_OMI_CODE;
  const zone_label = partial.zone_label && partial.zone_label.trim() ? partial.zone_label : UNRESOLVED_OMI_LABEL;
  const rawHasPrice = partial.price_raw !== undefined && partial.price_raw !== null && partial.price_raw !== "";
  const norm = normalizePrice(partial.price_raw ?? partial.price);
  const flags: string[] = [];
  const priceOptionalAndMissing = partial.price_optional === true && !rawHasPrice;
  if (norm.invalid && !priceOptionalAndMissing) flags.push("invalid_price");
  if (zone_code === UNRESOLVED_OMI_CODE) flags.push("unresolved_zone");
  const qualityScore = Math.max(0, 100 - flags.length * 30);
  const needsReviewBase = flags.includes("invalid_price") || partial.needs_review === true;
  const priceLabel = priceOptionalAndMissing
    ? (partial.price_label_override || "Prezzo non applicabile")
    : norm.label;
  const priceValue = priceOptionalAndMissing ? null : norm.price;
  const item: FeedItem = {
    source_id: partial.source_id,
    signal_type: partial.signal_type,
    title: partial.title?.trim() || "(senza titolo)",
    city: FORCED_CITY,
    province: FORCED_PROVINCE,
    zone_code,
    zone_label,
    display_zone: partial.display_zone?.trim() || zone_label,
    price: priceValue,
    price_label: priceLabel,
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
  // 1. OPTIONS con CORS.
  if (req.method === "OPTIONS") return handleOptions(req);

  // 2. debug id.
  const debugId = makeDebugId();

  const cors = buildCorsHeaders(req);
  const jsonResp = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "X-Core-Function": "civiko-one-signals-feed",
        "X-Core-Contract": SCHEMA_VERSION,
        "x-debug-id": debugId,
      },
    });
  const err = (code: string, message: string, status: number) =>
    jsonResp({ ok: false, schema_version: SCHEMA_VERSION, error: { code, message }, debug_id: debugId }, status);

  if (req.method !== "POST" && req.method !== "GET") {
    return err("METHOD_NOT_ALLOWED", "Use POST", 405);
  }

  // 3. requireSecret PRIMA di body parsing, client Supabase o query.
  const secretFail = requireSecret(req, debugId);
  if (secretFail) return secretFail;

  // 4. Workspace obbligatorio, UUID valido.
  // Compatibilità runtime: alcune PWA storiche inviano x-tenant-id.
  const workspaceId = (req.headers.get("x-workspace-id") ?? req.headers.get("x-tenant-id") ?? "").trim();
  if (!UUID_RE.test(workspaceId)) {
    return err("WORKSPACE_REQUIRED", "Missing or invalid workspace id", 401);
  }

  // Parse body/query DOPO il gate. commercial_zone_slug e workspace_id
  // eventualmente presenti sono IGNORATI. Il client non può scegliere zona.
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = {}; }
    if (!body || typeof body !== "object") body = {};
  }
  const url = new URL(req.url);
  const qp = url.searchParams;
  const pickStr = (k: string): string | undefined => {
    const v = qp.get(k) ?? (body as Record<string, unknown>)[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const city = FORCED_CITY;
  const province = FORCED_PROVINCE;
  const zoneMode = pickStr("zone_mode") || "omi_microzone";
  const limitRaw = Number(qp.get("limit") ?? (body as Record<string, unknown>).limit) || 250;
  const limit = Math.max(1, Math.min(limitRaw, 1000));
  const DEFAULT_INCLUDE = ["contendibili", "ribassi", "privati", "off_market"];
  const INCLUDE_ALIAS: Record<string, string> = {
    contendibile: "contendibili",
    contendibili: "contendibili",
    ribasso: "ribassi",
    ribassi: "ribassi",
    privato: "privati",
    privati: "privati",
    multi_portale: "multi_portale",
    off_market: "off_market",
    offmarket: "off_market",
  };
  const includeRawArr = Array.isArray((body as Record<string, unknown>).include)
    ? ((body as Record<string, unknown>).include as unknown[]).filter((s) => typeof s === "string") as string[]
    : (qp.get("include") ? qp.get("include")!.split(",") : []);
  const includeNormalized = includeRawArr
    .map((s) => s.trim().toLowerCase())
    .map((s) => INCLUDE_ALIAS[s] ?? s)
    .filter((s) => s.length > 0);
  // include assente OR include:[] → feed completo
  const include = includeNormalized.length ? includeNormalized : DEFAULT_INCLUDE;
  const includeSet = new Set(include);
  const quartiereRaw = pickStr("quartiere");

  // 5. Supabase service-role client.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Risoluzione server-side della zona (occupata / in_trial valido).
  const { data: zonesRows, error: zoneErr } = await supabase
    .from("civiko_commercial_zones")
    .select("slug,status,occupied_agency_id,trial_agency_id,trial_reserved_until")
    .or(
      `and(status.eq.occupata,occupied_agency_id.eq.${workspaceId}),` +
        `and(status.eq.in_trial,trial_agency_id.eq.${workspaceId})`,
    );
  if (zoneErr) {
    console.error(`[civiko-one-signals-feed] ${debugId} zone lookup`, zoneErr.message);
    return err("DB_ERROR", "zone lookup failed", 500);
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

  let isAdmin = false;
  {
    const { data: adminRes } = await supabase.rpc("civiko_is_admin_agency", { _agency_id: workspaceId });
    isAdmin = adminRes === true;
  }

  let assignedSlugs: string[];
  if (isAdmin) {
    assignedSlugs = [
      "centro-storico", "nord-arcella", "est-brenta", "nord-est",
      "sud-est-sant-osvaldo", "sud-voltabarozzo-guizza", "sud-ovest-mandria",
      "ovest-chiesanuova-brentelle",
    ];
  } else {
    if (valid.length === 0) return err("NO_ZONE_ASSIGNED", "No active zone for workspace", 403);
    assignedSlugs = (valid as Array<Record<string, unknown>>)
      .map((z) => String(z.slug ?? ""))
      .filter((s) => isCivikoCommercialZoneSlug(s))
      .sort();
    if (assignedSlugs.length === 0) {
      return err("SLUG_OUT_OF_CONTRACT", "Assigned slug not in contract", 403);
    }
  }

  // Checkpoint 11B-A — gate "una sola zona ufficiale assegnata".
  // Nessun full-city per Civiko One: lo slug client puo' solo restringere.
  // L'admin owner verificato server-side non e' un'agenzia cliente: nessun gate monozona.
  if (!isAdmin) {
    const requestedForGate =
      pickStr("zone_slug") ?? pickStr("commercial_zone_slug");
    const gate = applyCivikoSingleZoneGate(
      req.headers.get("x-source-app"),
      assignedSlugs,
      requestedForGate,
    );
    if (gate.civiko) {
      if (!gate.ok) return err(gate.code, "Zone access denied", 403);
      assignedSlugs = gate.slugs;
      isAdmin = false;
    }
  }
  // Multi-zone workspaces (sales/demo/admin): if the client passes an explicit
  // `zone_slug`, we scope to that one zone; otherwise we AGGREGATE across all
  // assigned zones. `assignedSlug` remains the primary/representative slug for
  // legacy fields (assigned_zone, scope.commercial_zone_slug).
  const requestedZoneRaw = pickStr("zone_slug") ?? pickStr("commercial_zone_slug");
  // ADMIN BYPASS: admin sempre in modalita' aggregata su tutte le zone assegnate,
  // anche se la PWA passa uno zone_slug specifico (es. 'centro-storico' di default).
  const requestedZone = isAdmin ? undefined : requestedZoneRaw;
  let assignedSlug: string;
  let zoneFilter: string[];
  if (requestedZone) {
    if (!assignedSlugs.includes(requestedZone)) {
      return err("ZONE_NOT_ASSIGNED", "Requested zone not assigned to workspace", 403);
    }
    assignedSlug = requestedZone;
    zoneFilter = [requestedZone];
  } else {
    assignedSlug = assignedSlugs[0];
    zoneFilter = assignedSlugs;
  }

  // Optional quartiere filter: consentito solo se risolve a una delle zone assegnate.
  let quartiereFilter: string | undefined;
  if (quartiereRaw) {
    const resolved = commercialZoneForQuartiere(quartiereRaw);
    if (!resolved || !zoneFilter.includes(resolved)) {
      return err("QUARTIERE_OUT_OF_ZONE", "Quartiere not in assigned zone", 403);
    }
    quartiereFilter = quartiereRaw;
  }


  // slug→name lookup — caricata UNA sola volta da public.civiko_commercial_zones.
  // La risoluzione dello slug per singolo item è per-item (vedi loop finale).
  // Colonne reali: slug (text), nome (text).
  const slugToName = new Map<string, string>();
  try {
    const { data: zoneNameRows } = await supabase
      .from("civiko_commercial_zones")
      .select("slug, nome");
    for (const r of (zoneNameRows ?? []) as Array<Record<string, unknown>>) {
      const s = typeof r.slug === "string" ? r.slug : "";
      const n = typeof r.nome === "string" ? r.nome : "";
      if (s && n) slugToName.set(s, n);
    }
  } catch (e) {
    console.error(`[civiko-one-signals-feed] ${debugId} slug→nome lookup error:`, (e as Error)?.message ?? e);
  }

  // Traccia il quartiere grezzo per ogni item, chiave = source_id.
  // Usato SOLO nel loop di risoluzione per-item finale.
  const itemQuartiereBySourceId = new Map<string, string | null>();





  const rawItems: FeedItem[] = [];
  const sourcesUsed: string[] = [];
  const sourceErrors: Array<{ source: string; category: string }> = [];
  let lastProviderRefresh: string | null = null;
  const bump = (ts?: string | null) => {
    if (!ts) return;
    if (!lastProviderRefresh || ts > lastProviderRefresh) lastProviderRefresh = ts;
  };

  // Freshness probes — SEMPRE con filtro zona lato DB.
  // Column set configurable: padova_listings has no created_at (uses imported_at/last_seen_at).
  const sourceFreshness: Record<string, { max_created_at: string | null; max_updated_at: string | null; max_last_seen_at: string | null; max_imported_at: string | null; rows_last_24h: number | null }> = {};
  interface FreshnessCols {
    hasCreated?: boolean;
    hasUpdated?: boolean;
    hasLastSeen?: boolean;
    hasImported?: boolean;
    orderBy?: "created_at" | "last_seen_at" | "imported_at" | "updated_at";
  }
  async function probeFreshnessByZone(table: string, cols: FreshnessCols = {}) {
    const hasCreated = cols.hasCreated !== false;
    const orderBy = cols.orderBy || (hasCreated ? "created_at" : (cols.hasLastSeen ? "last_seen_at" : (cols.hasImported ? "imported_at" : "updated_at")));
    try {
      const selCols: string[] = [];
      if (hasCreated) selCols.push("created_at");
      if (cols.hasUpdated) selCols.push("updated_at");
      if (cols.hasLastSeen) selCols.push("last_seen_at");
      if (cols.hasImported) selCols.push("imported_at");
      if (selCols.length === 0) selCols.push(orderBy);
      const { data } = await supabase
        .from(table)
        .select(selCols.join(","))
        .in("commercial_zone_slug", zoneFilter)
        .order(orderBy, { ascending: false })
        .limit(1);
      const top = (data && data[0]) as Record<string, unknown> | undefined;
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .in("commercial_zone_slug", zoneFilter)
        .gte(orderBy, since);
      sourceFreshness[table] = {
        max_created_at: hasCreated ? ((top?.created_at as string) ?? null) : null,
        max_updated_at: cols.hasUpdated ? ((top?.updated_at as string) ?? null) : null,
        max_last_seen_at: cols.hasLastSeen ? ((top?.last_seen_at as string) ?? null) : null,
        max_imported_at: cols.hasImported ? ((top?.imported_at as string) ?? null) : null,
        rows_last_24h: count ?? null,
      };
    } catch {
      sourceFreshness[table] = { max_created_at: null, max_updated_at: null, max_last_seen_at: null, max_imported_at: null, rows_last_24h: null };
    }
  }

  // ── CONTENDIBILI — padova_contendibili_by_zone_v, filtro DB ───────
  if (includeSet.has("contendibili")) {
    await probeFreshnessByZone("padova_contendibili_by_zone_v", { hasUpdated: true, hasLastSeen: true, orderBy: "last_seen_at" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contQ: any = supabase
      .from("padova_contendibili_by_zone_v")
      .select("id, chiave_match, n_agenzie, agency_count_distinct, agencies_normalized, agenzie, portals_seen, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, created_at, last_seen_at, commercial_zone_slug")
      .in("commercial_zone_slug", zoneFilter);
    if (quartiereFilter) contQ = contQ.eq("quartiere", quartiereFilter);
    // Prefer last_seen_at when available (post-migration), fallback to created_at.
    const { data, error } = await contQ
      .or("agency_count_distinct.gte.2,and(agency_count_distinct.is.null,n_agenzie.gte.2)")
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("agency_count_distinct", { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[civiko-one-signals-feed] ${debugId} contendibili`, error.message);
      sourceErrors.push({ source: "padova_contendibili_by_zone_v", category: "query_error" });
    } else if (data) {
      sourcesUsed.push("padova_contendibili_by_zone_v");
      const rank: Record<string, number> = { ALTA: 30, MEDIA: 15, DA_CONFERMARE: 0 };
      for (const row of data as Record<string, unknown>[]) {
        const z = resolveZone(row);
        const minP = Number(row.prezzo_min) || 0;
        const maxP = Number(row.prezzo_max) || 0;
        const priceCandidate = minP && maxP ? Math.round((minP + maxP) / 2) : (maxP || minP || null);
        const lastSeen = (row.last_seen_at as string) || (row.created_at as string) || new Date().toISOString();
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
        // Stable source_id keyed by chiave_match (survives id regenerations).
        const stableCont = String(row.chiave_match || `id:${row.id}`);
        rawItems.push(buildItem(String(row.commercial_zone_slug || ""), {
          source_id: `cont:${stableCont}`,
          signal_type: "contendibile",
          title: `${title} — ${nAg} agenzie distinte`,
          zone_code: z.code, zone_label: z.label,

          price_raw: priceCandidate,
          url: urls[0] || "",
          status: "active",
          score,
          last_seen_at: lastSeen,
          first_seen_at: typeof row.created_at === "string" ? row.created_at : undefined,
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
        itemQuartiereBySourceId.set(`cont:${stableCont}`, typeof row.quartiere === "string" ? row.quartiere : null);

      }
    }
  }

  // ── MULTI-PORTALE — padova_multi_portale_by_zone_v, filtro DB ────
  if (includeSet.has("contendibili") || includeSet.has("multi_portale")) {
    await probeFreshnessByZone("padova_multi_portale_by_zone_v", { hasUpdated: true, hasLastSeen: true, orderBy: "last_seen_at" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mpQ: any = supabase
      .from("padova_multi_portale_by_zone_v")
      .select("id, chiave_match, portal_count, portals_seen, agency_count_distinct, agencies_normalized, agenzie, prezzo_min, prezzo_max, mq, locali, quartiere, lat, lng, urls, n_annunci, created_at, last_seen_at, commercial_zone_slug")
      .in("commercial_zone_slug", zoneFilter);
    if (quartiereFilter) mpQ = mpQ.eq("quartiere", quartiereFilter);
    const { data, error } = await mpQ
      .gte("portal_count", 2)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("portal_count", { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[civiko-one-signals-feed] ${debugId} multi_portale`, error.message);
      sourceErrors.push({ source: "padova_multi_portale_by_zone_v", category: "query_error" });
    } else if (data) {
      sourcesUsed.push("padova_multi_portale_by_zone_v");
      for (const row of data as Record<string, unknown>[]) {
        const z = resolveZone(row);
        const minP = Number(row.prezzo_min) || 0;
        const maxP = Number(row.prezzo_max) || 0;
        const priceCandidate = minP && maxP ? Math.round((minP + maxP) / 2) : (maxP || minP || null);
        const lastSeen = (row.last_seen_at as string) || (row.created_at as string) || new Date().toISOString();
        bump(lastSeen);
        const urls = Array.isArray(row.urls) ? (row.urls as string[]) : [];
        const portals = Array.isArray(row.portals_seen) ? (row.portals_seen as string[]) : [];
        const agenciesNorm = Array.isArray(row.agencies_normalized) ? (row.agencies_normalized as string[]) : [];
        const nPortals = Number(row.portal_count) || portals.length;
        const nAg = Number(row.agency_count_distinct) || 0;
        const score = Math.min(85, 40 + Math.min(nPortals, 6) * 5);
        const title = String(row.chiave_match || `Multi-portale ${row.id}`)
          .split("|")[0].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const stableMp = String(row.chiave_match || `id:${row.id}`);
        rawItems.push(buildItem(String(row.commercial_zone_slug || ""), {
          source_id: `mp:${stableMp}`,
          // PWA-compat: multi-portale mappato come "contendibile"; l'origine
          // resta tracciabile via evidence_type/label_pubblica/raw_ref.
          signal_type: "contendibile",
          title: `${title} — ${nPortals} portali`,
          zone_code: z.code, zone_label: z.label,

          price_raw: priceCandidate,
          url: urls[0] || "",
          status: "active",
          score,
          last_seen_at: lastSeen,
          first_seen_at: typeof row.created_at === "string" ? row.created_at : undefined,
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
        itemQuartiereBySourceId.set(`mp:${stableMp}`, typeof row.quartiere === "string" ? row.quartiere : null);

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
    // v2 ONLY: no silent fallback to v1. If v2 is missing or errors,
    // emit zero ribassi and record a diagnostic. Falling back to v1
    // would mask an incomplete migration and could re-introduce data
    // that is not zone-verified against padova_listings_price_history.
    let rpcRows: unknown = null;
    let rpcErr: { message: string; code?: string } | null = null;
    // Aggregate over all zones in zoneFilter (single zone if requestedZone was set).
    // Cap per-zone limit and race each call against a client-side timeout so a
    // slow/hanging RPC cannot stall the whole feed (fail-closed: zero ribassi
    // on timeout, diagnostic recorded).
    const RIBASSI_PER_ZONE_LIMIT = Math.min(20, limit);
    const RIBASSI_RPC_TIMEOUT_MS = 12000;
    const withTimeout = <T,>(p: Promise<T>): Promise<T | { data: null; error: { message: string; code?: string } }> =>
      Promise.race([
        p,
        new Promise<{ data: null; error: { message: string; code: string } }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: { message: "client_timeout", code: "TIMEOUT" } }), RIBASSI_RPC_TIMEOUT_MS),
        ),
      ]) as Promise<T>;
    // Batching deterministico: max 2 RPC contemporanee. Il fanout simultaneo
    // su 8 zone saturava il DB e causava statement_timeout (57014).
    // Ordine dei risultati identico a zoneFilter.
    const RIBASSI_RPC_CONCURRENCY = 2;
    const rpcCalls: Array<{ data?: unknown; error?: { message: string; code?: string } | null }> = [];
    for (let i = 0; i < zoneFilter.length; i += RIBASSI_RPC_CONCURRENCY) {
      const batch = zoneFilter.slice(i, i + RIBASSI_RPC_CONCURRENCY);
      const settled = await Promise.all(batch.map((slug) =>
        withTimeout(
          supabase.rpc("get_padova_verified_price_drops_by_zone_v2", {
            p_commercial_zone_slug: slug,
            p_quartiere: quartiereFilter ?? null,
            p_limit: RIBASSI_PER_ZONE_LIMIT,
            p_min_drop_pct: 5,
            p_max_age_days: 14,
          })
        )
      ));
      for (const r of settled) rpcCalls.push(r as { data?: unknown; error?: { message: string; code?: string } | null });
    }

    const firstErr = rpcCalls.find((r) => r.error);
    if (firstErr?.error) {
      const missing = /function .* does not exist/i.test(firstErr.error.message ?? "");
      rpcErr = firstErr.error;
      sourceErrors.push({
        source: "get_padova_verified_price_drops_by_zone_v2",
        category: missing ? "rpc_missing_no_fallback" : "rpc_error",
      });
    } else {
      rpcRows = rpcCalls.flatMap((r) => Array.isArray(r.data) ? r.data : []);
    }
    if (rpcErr) {
      ribassiDiag.ribassi_source = "rpc_error";
      console.error(`[civiko-one-signals-feed] ${debugId} ribassi RPC error: ${rpcErr.message}`);
      sourceErrors.push({ source: "get_padova_verified_price_drops_by_zone_v2", category: "rpc_error" });
    } else if (Array.isArray(rpcRows)) {
      sourcesUsed.push("get_padova_verified_price_drops_by_zone_v2");
      ribassiDiag.ribassi_rpc_returned = rpcRows.length;
      for (const row of rpcRows as Record<string, unknown>[]) {
        // Difesa in profondità: la RPC filtra già, ma verifichiamo lo slug.
        const slug = (row.commercial_zone_slug as string) || "";
        if (!zoneFilter.includes(slug)) { ribassiDiag.ribassi_unzoned_excluded++; continue; }
        if (quartiereFilter) {
          const rq = typeof row.quartiere === "string" ? row.quartiere : "";
          if (rq !== quartiereFilter) continue;
        }
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
        rawItems.push(buildItem(String(row.commercial_zone_slug || ""), {
          source_id: `drop:${row.source_id ?? row.listing_id ?? url}`,
          signal_type: "ribasso",
          title: `${title} — ribasso ${dropPct}%`,
          zone_code: omiCode || UNRESOLVED_OMI_CODE,
          zone_label: zoneLabel,
          price_raw: current,
          url,
          status: "active",
          score: Math.min(100, 50 + Math.round(dropPct)),
          last_seen_at: lastSeen,
          first_seen_at: typeof row.imported_at === "string" ? row.imported_at : undefined,
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
        itemQuartiereBySourceId.set(
          `drop:${row.source_id ?? row.listing_id ?? url}`,
          typeof row.quartiere === "string" ? row.quartiere : null,
        );

      }
    }
  }

  // ── PRIVATI — padova_listings (stessa sorgente di padova-privati-list) ─
  // Solo annunci privati reali attivi (expired_at IS NULL), filtro zona DB
  // prima di order/limit. Massimo 50 opportunità. Nessun telefono/email/PII.
  const privatiDiag = {
    privati_source: "padova_listings",
    privati_returned: 0,
    privati_auction_excluded: 0,
    privati_max_last_seen_at: null as string | null,
  };
  if (includeSet.has("privati")) {
    await probeFreshnessByZone("padova_listings", { hasCreated: false, hasLastSeen: true, hasImported: true, orderBy: "last_seen_at" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prvQ: any = supabase
      .from("padova_listings")
      .select("id, fonte, url, mq, locali, bagni, prezzo, lat, lng, indirizzo, quartiere, imported_at, last_seen_at, tipo_lead, comune, omi_zone, commercial_zone_slug")
      .in("tipo_lead", ["PRIVATO", "privato", "privato_stanco"])
      .eq("comune", "Padova")
      .in("commercial_zone_slug", zoneFilter)
      .is("expired_at", null);
    if (quartiereFilter) prvQ = prvQ.eq("quartiere", quartiereFilter);
    const { data, error } = await prvQ
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .order("imported_at", { ascending: false, nullsFirst: false })
      .limit(50);
    if (error) {
      console.error(`[civiko-one-signals-feed] ${debugId} privati`, error.message);
      sourceErrors.push({ source: "padova_listings", category: "query_error" });
    } else if (data) {
      sourcesUsed.push("padova_listings");
      for (const row of data as Record<string, unknown>[]) {
        if (isAuctionRecord(row)) { privatiDiag.privati_auction_excluded++; continue; }
        const z = resolveZone(row);
        const price = Number(row.prezzo ?? 0) || 0;
        const lastSeen =
          (row.last_seen_at as string) ||
          (row.imported_at as string) ||
          new Date().toISOString();
        bump(lastSeen);
        if (!privatiDiag.privati_max_last_seen_at || lastSeen > privatiDiag.privati_max_last_seen_at) {
          privatiDiag.privati_max_last_seen_at = lastSeen;
        }
        const baseTitle = (row.indirizzo as string) || `Immobile ${z.label}`;
        rawItems.push(buildItem(String(row.commercial_zone_slug || ""), {
          source_id: `pdv:${row.id}`,
          signal_type: "privato",
          title: baseTitle,
          zone_code: z.code, zone_label: z.label,
          price_raw: price,
          url: (row.url as string) || "",
          status: "active",
          score: 55,
          last_seen_at: lastSeen,
          raw_ref: `padova_listings:${row.id}`,
          lat_raw: row.lat, lng_raw: row.lng,
          label_pubblica: "Opportunità privata attiva",
        }));
        itemQuartiereBySourceId.set(`pdv:${row.id}`, typeof row.quartiere === "string" ? row.quartiere : null);
        privatiDiag.privati_returned++;
      }
    }
  }


  // ── OFF-MARKET — early_offmarket_signal_candidates_by_zone_v (fail-closed) ─
  // DB-side zone filter via view derived from civiko_resolve_commercial_zone_slug(quartiere).
  // Missing/legacy schema (view not yet created) → fail-closed to zero, recorded in source_errors.
  // FAIL-CLOSED: la sola presenza di commercial_zone_slug NON basta a considerare
  // un candidato "verificato". Applichiamo lo stesso criterio canonico usato
  // dai runner (earlyOffmarketRunner.reco): privacy_safe=true,
  // import_recommendation='importable' (che il runner emette solo con
  // confidence_score >= 0.7), needs_review=false e status non in
  // ('rejected','needs_review','discovered'). Se nessuna riga supera il gate
  // il feed emette 0 off-market: non inventiamo segnali.
  const VERIFIED_STATUSES = ["approved", "promoted", "importable"] as const;
  const offmarketDiag = {
    off_market_zone_resolved_count: 0,
    off_market_verified_count: 0,
    off_market_emitted_count: 0,
    offmarket_auction_excluded: 0,
    offmarket_invalid_url_excluded: 0,
    offmarket_disabled_reason: null as string | null,
  };
  if (includeSet.has("off_market")) {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    // 1) zone-resolved count (informativo — NON usato per emettere)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let zoneCntQ: any = supabase
      .from("early_offmarket_signal_candidates_by_zone_v")
      .select("id", { count: "exact", head: true })
      .in("commercial_zone_slug", zoneFilter)
      .eq("comune", "Padova");
    if (quartiereFilter) zoneCntQ = zoneCntQ.eq("quartiere", quartiereFilter);
    const { count: zoneResolvedCount, error: zoneCntErr } = await zoneCntQ;
    if (zoneCntErr) {
      const missing = /relation .* does not exist/i.test(zoneCntErr.message ?? "");
      offmarketDiag.offmarket_disabled_reason = missing
        ? "view_not_deployed_fail_closed"
        : "query_error";
      sourceErrors.push({
        source: "early_offmarket_signal_candidates_by_zone_v",
        category: missing ? "view_missing" : "query_error",
      });
      console.error(`[civiko-one-signals-feed] ${debugId} off_market zone-count error: ${zoneCntErr.message}`);
    } else {
      offmarketDiag.off_market_zone_resolved_count = zoneResolvedCount ?? 0;
    }

    // 2) verified fetch — criterio canonico allineato ai runner
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let omQ: any = supabase
      .from("early_offmarket_signal_candidates_by_zone_v")
      .select("id, fingerprint, comune, signal_type, title, summary, source_url, source_name, confidence_score, quality, privacy_safe, needs_review, import_recommendation, status, quartiere, commercial_zone_slug, created_at, location_detail")
      .in("commercial_zone_slug", zoneFilter)
      .eq("comune", "Padova")
      .eq("privacy_safe", true)
      .eq("needs_review", false)
      .eq("import_recommendation", "importable")
      .gte("confidence_score", 0.7)
      .in("status", VERIFIED_STATUSES as unknown as string[])
      .ilike("source_url", "https://%")
      .gte("created_at", cutoff);
    if (quartiereFilter) omQ = omQ.eq("quartiere", quartiereFilter);
    const { data, error } = await omQ
      .order("confidence_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) {
      const missing = /relation .* does not exist/i.test(error.message ?? "");
      offmarketDiag.offmarket_disabled_reason = missing
        ? "view_not_deployed_fail_closed"
        : "query_error";
      sourceErrors.push({ source: "early_offmarket_signal_candidates_by_zone_v", category: missing ? "view_missing" : "query_error" });
      console.error(`[civiko-one-signals-feed] ${debugId} off_market query error: ${error.message}`);
    } else if (data) {
      sourcesUsed.push("early_offmarket_signal_candidates_by_zone_v");
      offmarketDiag.off_market_verified_count = data.length;
      for (const row of data as Record<string, unknown>[]) {
        if (isAuctionRecord(row)) { offmarketDiag.offmarket_auction_excluded++; continue; }
        const url = String(row.source_url || "");
        if (!url.startsWith("https://")) { offmarketDiag.offmarket_invalid_url_excluded++; continue; }
        const created = (row.created_at as string) || new Date().toISOString();
        bump(created);
        const stableOm = String(row.fingerprint || row.id);
        // NO PII: escludiamo summary/location_detail/payload dall'output.
        rawItems.push(buildItem(String(row.commercial_zone_slug || ""), {
          source_id: `om:${stableOm}`,
          signal_type: "off_market",
          title: String(row.title || "").slice(0, 240) || "Segnale off-market",
          zone_code: UNRESOLVED_OMI_CODE,
          zone_label: UNRESOLVED_OMI_LABEL,
          price_raw: null,
          price_optional: true,
          price_label_override: "Prezzo non applicabile",
          url,
          status: String(row.status || "active"),
          score: Math.min(100, Math.round((Number(row.confidence_score) || 0.7) * 100)),
          last_seen_at: created,
          first_seen_at: created,
          raw_ref: `early_offmarket_signal_candidates:${row.id}`,
          evidence_type: String(row.signal_type || "off_market"),
          label_pubblica: "Segnale off-market verificato",
          needs_review: false,
        }));
        itemQuartiereBySourceId.set(`om:${stableOm}`, typeof row.quartiere === "string" ? row.quartiere : null);
        offmarketDiag.off_market_emitted_count++;
      }
    }
  } else {
    offmarketDiag.offmarket_disabled_reason = "not_included_in_request";
  }

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

  // Slug commerciale e display_zone: normalizzati per-item, ma vincolati a zoneFilter.
  // Ogni item proviene da viste filtrate DB-side su zoneFilter (una o piu` zone assegnate),
  // quindi nessun item appartiene a una zona non autorizzata.
  for (const it of rawItems) {
    // Fail-closed: nessuna riattribuzione. Un item senza zona valida resta
    // senza slug e viene scartato dall'assert finale (mai Centro Storico).
    const itSlug = it.commercial_zone_slug && zoneFilter.includes(it.commercial_zone_slug)
      ? it.commercial_zone_slug
      : "";
    it.commercial_zone_slug = itSlug;
    it.display_zone = itSlug ? (slugToName.get(itSlug) || itSlug) : it.display_zone;
  }
  const distinctResolvedSlugs = new Set(rawItems.map((it) => it.commercial_zone_slug)).size;
  const fallbackAltreZone = 0;
  console.log(
    `[civiko-one-signals-feed] ${debugId} zone_resolution items=${rawItems.length} ` +
    `distinct_slugs=${distinctResolvedSlugs} altre_zone=${fallbackAltreZone} assigned=${assignedSlug} zone_filter=${zoneFilter.join(",")}`,
  );


  const preAssertCount = rawItems.length;
  const zoneAsserted = rawItems.filter((it) => zoneFilter.includes(it.commercial_zone_slug ?? ""));
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
    // Allineamento /quartieri ↔ /radar: contendibili contati SOLO dalla sorgente
    // canonica padova_contendibili_by_zone_v. Le righe multi-portale (raw_ref
    // padova_multi_portale:*) restano esposte come signal_type="contendibile"
    // per compat PWA, ma nel summary vanno nel bucket multi_portale.
    const rawRef = typeof it.raw_ref === "string" ? it.raw_ref : "";
    if (it.signal_type === "contendibile") {
      if (rawRef.startsWith("padova_multi_portale:")) summary.multi_portale++;
      else summary.contendibili++;
    }
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
        .in("commercial_zone_slug", zoneFilter)
        .eq("portal", p);
      const { count: withAg } = await supabase
        .from("padova_collect_v2_items_by_zone_v")
        .select("id", { count: "exact", head: true })
        .in("commercial_zone_slug", zoneFilter)
        .eq("portal", p)
        .not("agency", "is", null)
        .neq("agency", "")
        .not("agency", "ilike", "portal:%");
      const { data: lastRow } = await supabase
        .from("padova_collect_v2_items_by_zone_v")
        .select("created_at")
        .in("commercial_zone_slug", zoneFilter)
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

  // Admin owner verificato server-side: full-city sulle 8 zone ufficiali.
  // Ogni item conserva il proprio commercial_zone_slug ufficiale: nessuna
  // riattribuzione a Centro Storico (o a qualsiasi altra zona).
  const outItems = trimmed;
  const responseScope = isAdmin ? "admin_full_city" : "commercial_zone_isolated";
  const appliedZoneSlug = isAdmin ? null : assignedSlug;
  const zonesInScope = isAdmin ? [...assignedSlugs] : [...zoneFilter];

  return jsonResp({
    ok: true,
    schema_version: SCHEMA_VERSION,
    scope: responseScope,
    applied_zone_slug: appliedZoneSlug,
    zones_in_scope: zonesInScope,
    assigned_zone: appliedZoneSlug,
    assigned_zones: zonesInScope,
    scope_detail: {
      city,
      province,
      zone_mode: zoneMode,
      mode: responseScope,
      commercial_zone_slug: appliedZoneSlug,
      assigned_zones: zonesInScope,
    },
    generated_at: generatedAt,
    summary,
    items: outItems,
    data: {
      items: outItems,
      total: summary.total,
      summary,
      scope: responseScope,
      applied_zone_slug: appliedZoneSlug,
      zones_in_scope: zonesInScope,
      assigned_zone: appliedZoneSlug,
      assigned_zones: zonesInScope,
      scope_detail: {
        city,
        province,
        zone_mode: zoneMode,
        mode: responseScope,
        commercial_zone_slug: appliedZoneSlug,
        assigned_zones: zonesInScope,
      },
    },
    diagnostics: {
      tenant_id: workspaceId,
      workspace_id: workspaceId,
      scope: responseScope,
      is_admin: isAdmin,
      applied_zone_slug: appliedZoneSlug,
      zones_in_scope: zonesInScope,
      assigned_zone: appliedZoneSlug,
      count_by_zone: outItems.reduce<Record<string, number>>((acc, it) => {
        const s = it.commercial_zone_slug ?? "";
        if (s) acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {}),
      items_without_zone: outItems.filter((it) => !it.commercial_zone_slug).length,
      generated_at: generatedAt,
      requested_limit: limit,
      included: include,
      include_raw: includeRawArr,
      feed_build: "real-sources-v3",
      source_errors: sourceErrors,
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
      privati: {
        ...privatiDiag,
        private_opportunities_count: summary.privati,
      },
      offmarket: offmarketDiag,
      commercial_zone_scope: "db_side_zone_filter_only",
      pwa_legacy_admin_zone_compat: false,
      quartiere_filter: quartiereFilter ?? null,
      distinct_resolved_slugs: distinctResolvedSlugs,
      security_gate: "ok",
      debug_id: debugId,
    },
  });
});
