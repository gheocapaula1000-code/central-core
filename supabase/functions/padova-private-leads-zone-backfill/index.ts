// padova-private-leads-zone-backfill
// Zonizza retroattivamente i privati già presenti in public.padova_listings
// senza chiamare Apify / Firecrawl / Perplexity / portali.
//
// Regole:
//  - solo POST + x-job-secret == CENTRAL_CORE_JOB_SECRET
//  - fonti whitelist: casa, idealista, immobiliare, subito
//  - assegna commercial_zone_slug SOLO se metodo forte (PIP / precomputed / alias)
//    con confidence >= 0.70 e codice OMI attivo in civiko_commercial_zones
//  - cap_hint (0.40) conserva method+confidence ma NON assegna slug
//  - Comune sconosciuto → promuovibile a "Padova" solo via PIP o precomputed
//  - Comune noto diverso da Padova → mai processato
//  - force=true azzera anche vecchie assegnazioni deboli (cap_hint)
//  - risposta = riepilogo aggregato, nessun dato personale nei log

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  resolvePadovaOmiBatch,
  UNRESOLVED_OMI_CODE,
} from "../_shared/padovaOmiResolver.ts";

type Json = Record<string, unknown>;

const ALLOWED_SOURCES = ["casa", "idealista", "immobiliare", "subito"] as const;
type Source = typeof ALLOWED_SOURCES[number];

const STRONG_METHODS = new Set(["point_in_polygon", "precomputed_omi", "alias"]);
const MIN_CONF = 0.70;

function reasonToMethod(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (r === "point_in_polygon") return "point_in_polygon";
  if (r === "precomputed_omi") return "precomputed_omi";
  if (r === "alias_match") return "alias";
  if (r.startsWith("cap_hint")) return "cap_hint";
  return "unresolved";
}

function safeStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function safeFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const raw = String(v).trim().replace(",", ".");
  if (!raw) return null;
  const n = parseFloat(raw);
  return isFinite(n) ? n : null;
}
function normalizeComune(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}
function extractCap(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\D/g, "");
  if (s.length === 5 && s.startsWith("351")) return s;
  const m = String(v).match(/\b(351\d{2})\b/);
  return m ? m[1] : null;
}

function pick<T = unknown>(obj: unknown, path: string): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur as T;
}

/** Costruisce l'input normalizzato per il resolver a partire dai campi del listing. */
function buildResolverInput(row: {
  fonte: string;
  lat: number | null; lng: number | null;
  indirizzo: string | null;
  raw_json: Json | null;
}): Record<string, unknown> {
  const raw: Json = (row.raw_json ?? {}) as Json;
  const fonte = String(row.fonte || "").toLowerCase();

  let lat: number | null = row.lat ?? null;
  let lng: number | null = row.lng ?? null;
  let indirizzo: string | null = row.indirizzo ?? null;
  let title: string | null = null;
  let description: string | null = null;
  let quartiere: string | null = null;
  let cap: string | null = null;
  let comune: string | null = null;

  if (fonte === "subito") {
    lat = lat ?? safeFloat(pick(raw, "geo_map_latitude"));
    lng = lng ?? safeFloat(pick(raw, "geo_map_longitude"));
    indirizzo = indirizzo ?? safeStr(pick(raw, "geo_map_address"));
    cap = extractCap(pick(raw, "geo_zip")) ?? extractCap(pick(raw, "geo_map_address"));
    comune = safeStr(pick(raw, "geo_town_value")) ?? safeStr(pick(raw, "geo_city_value"));
    title = safeStr(pick(raw, "subject")) ?? safeStr(pick(raw, "title"));
    description = safeStr(pick(raw, "body")) ?? safeStr(pick(raw, "description"));
  } else if (fonte === "casa" || fonte === "casa.it") {
    lat = lat ?? safeFloat(pick(raw, "location.coordinates.lat"))
              ?? safeFloat(pick(raw, "location.latitude"))
              ?? safeFloat(pick(raw, "latitude"));
    lng = lng ?? safeFloat(pick(raw, "location.coordinates.lon"))
              ?? safeFloat(pick(raw, "location.coordinates.lng"))
              ?? safeFloat(pick(raw, "location.longitude"))
              ?? safeFloat(pick(raw, "longitude"));
    indirizzo = indirizzo
      ?? safeStr(pick(raw, "location.address"))
      ?? safeStr(pick(raw, "address"));
    comune = safeStr(pick(raw, "location.city")) ?? safeStr(pick(raw, "city"));
    quartiere = safeStr(pick(raw, "location.microzone"))
      ?? safeStr(pick(raw, "location.district"))
      ?? safeStr(pick(raw, "microzone"))
      ?? safeStr(pick(raw, "district"));
    cap = extractCap(pick(raw, "location.zip"))
      ?? extractCap(pick(raw, "zip"))
      ?? extractCap(indirizzo);
    title = safeStr(pick(raw, "title")) ?? safeStr(pick(raw, "seo.title"));
    description = safeStr(pick(raw, "description")) ?? safeStr(pick(raw, "shortDescription"));
  } else if (fonte === "idealista" || fonte === "idealista.it") {
    lat = lat ?? safeFloat(pick(raw, "latitude"));
    lng = lng ?? safeFloat(pick(raw, "longitude"));
    indirizzo = indirizzo ?? safeStr(pick(raw, "address"));
    comune = safeStr(pick(raw, "municipality")) ?? safeStr(pick(raw, "city"));
    quartiere = safeStr(pick(raw, "district")) ?? safeStr(pick(raw, "neighborhood"));
    cap = extractCap(pick(raw, "postalCode")) ?? extractCap(indirizzo);
    title = safeStr(pick(raw, "suggestedTexts.title"))
      ?? safeStr(pick(raw, "title"))
      ?? safeStr(pick(raw, "suggestedTexts.subtitle"));
    description = safeStr(pick(raw, "description"))
      ?? safeStr(pick(raw, "suggestedTexts.description"));
  } else if (fonte === "immobiliare" || fonte === "immobiliare.it") {
    lat = lat ?? safeFloat(pick(raw, "geography.location.latitude"))
              ?? safeFloat(pick(raw, "properties.0.location.latitude"));
    lng = lng ?? safeFloat(pick(raw, "geography.location.longitude"))
              ?? safeFloat(pick(raw, "properties.0.location.longitude"));
    indirizzo = indirizzo
      ?? safeStr(pick(raw, "geography.address"))
      ?? safeStr(pick(raw, "properties.0.location.address"));
    comune = safeStr(pick(raw, "geography.city"))
      ?? safeStr(pick(raw, "properties.0.location.city"));
    quartiere = safeStr(pick(raw, "geography.microzone"))
      ?? safeStr(pick(raw, "properties.0.location.microzone"));
    cap = extractCap(pick(raw, "geography.zip"))
      ?? extractCap(pick(raw, "properties.0.location.zip"))
      ?? extractCap(indirizzo);
    title = safeStr(pick(raw, "title.short"))
      ?? safeStr(pick(raw, "title"))
      ?? safeStr(pick(raw, "seo.title"));
    description = safeStr(pick(raw, "description")) ?? safeStr(pick(raw, "shortDescription"));
  }

  return {
    lat, lng,
    indirizzo, address: indirizzo,
    title, description,
    quartiere, zona: quartiere,
    cap, zip: cap,
    _comune_hint: comune,
    payload: raw,
  };
}

function mapOmiToZone(
  omi: string,
  zones: Array<{ slug: string; nome: string; omi_codes: string[] | null }>,
): { slug: string; nome: string } | null {
  const code = omi.trim().toUpperCase();
  for (const z of zones) {
    const codes = (z.omi_codes ?? []).map((c) => String(c).trim().toUpperCase());
    if (codes.includes(code)) return { slug: z.slug, nome: z.nome };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---- Body validation ----
  let body: Json = {};
  try { body = await req.json() as Json; } catch { body = {}; }

  let maxRows = 800;
  if (body.max_rows !== undefined) {
    const v = Number(body.max_rows);
    if (!Number.isInteger(v) || v < 1 || v > 1000) {
      return new Response(JSON.stringify({ ok: false, error: "invalid_max_rows" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    maxRows = v;
  }
  const force = body.force === true;
  const includeUnknown = body.include_unknown_comune !== false;

  let sources: Source[] = [...ALLOWED_SOURCES];
  if (Array.isArray(body.sources)) {
    const dedup = Array.from(new Set(body.sources.map((s) => String(s).toLowerCase().trim())));
    for (const s of dedup) {
      if (!ALLOWED_SOURCES.includes(s as Source)) {
        return new Response(JSON.stringify({ ok: false, error: `invalid_source:${s}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    sources = dedup as Source[];
    if (sources.length === 0) sources = [...ALLOWED_SOURCES];
  } else if (body.sources !== undefined) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_sources" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ---- Load active commercial zones once ----
  const { data: zData, error: zErr } = await sb
    .from("civiko_commercial_zones")
    .select("slug, nome, omi_codes, attiva")
    .eq("attiva", true);
  if (zErr) {
    return new Response(JSON.stringify({ ok: false, error: `zones_load:${zErr.message}` }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const zones = ((zData ?? []) as Array<Record<string, unknown>>).map((z) => ({
    slug: String(z.slug ?? ""),
    nome: String(z.nome ?? ""),
    omi_codes: Array.isArray(z.omi_codes) ? (z.omi_codes as string[]) : null,
  }));

  // ---- Select candidate rows from padova_listings ----
  // Include: comune='Padova' OR (include_unknown && comune IS NULL/'')
  // Exclude: any known non-Padova comune (never touched).
  // force=false: only zone_resolved_at IS NULL.
  const TIPI = ["PRIVATO", "privato", "privato_stanco", "PRIVATO_STANCO"];

  // Two-step select for safety: fetch superset then filter server-side by comune.
  let q = sb.from("padova_listings" as any)
    .select("id, fonte, url, tipo_lead, comune, lat, lng, indirizzo, raw_json, zone_resolved_at, zone_match_method, commercial_zone_slug")
    .in("fonte", sources as unknown as string[])
    .in("tipo_lead", TIPI)
    .limit(maxRows);
  if (!force) q = q.is("zone_resolved_at", null);

  const { data: rowsRaw, error: selErr } = await q;
  if (selErr) {
    return new Response(JSON.stringify({ ok: false, error: `select:${selErr.message}` }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  type Row = {
    id: number | string;
    fonte: string;
    url: string;
    tipo_lead: string;
    comune: string | null;
    lat: number | null;
    lng: number | null;
    indirizzo: string | null;
    raw_json: Json | null;
    zone_resolved_at: string | null;
    zone_match_method: string | null;
    commercial_zone_slug: string | null;
  };

  const all = ((rowsRaw ?? []) as unknown as Row[]);
  let skipped_known_province = 0;
  const rows: Row[] = [];
  for (const r of all) {
    const norm = normalizeComune(r.comune);
    const known = norm !== "";
    if (known && norm !== "padova") { skipped_known_province++; continue; }
    if (!known && !includeUnknown) continue;
    rows.push(r);
  }

  const selected = rows.length;
  const stats = {
    selected,
    processed: 0,
    padova_confirmed: 0,
    unknown_promoted_by_pip: 0,
    point_in_polygon: 0,
    precomputed_omi: 0,
    alias: 0,
    cap_hint_not_assigned: 0,
    unresolved: 0,
    commercial_zone_assigned: 0,
    cleared_weak_assignments: 0,
    skipped_known_province,
    errors: [] as string[],
  };

  if (selected === 0) {
    return new Response(JSON.stringify({ ok: true, ...stats }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---- Resolve in batch ----
  const inputs = rows.map((r) => buildResolverInput({
    fonte: r.fonte, lat: r.lat, lng: r.lng, indirizzo: r.indirizzo, raw_json: r.raw_json,
  }));

  const resolutions = await resolvePadovaOmiBatch(
    inputs,
    sb as unknown as {
      rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    },
    (rr) => ({
      lat: (rr as Record<string, unknown>).lat as number | null,
      lng: (rr as Record<string, unknown>).lng as number | null,
    }),
  );

  const nowIso = new Date().toISOString();
  const updates: Array<{ id: unknown; patch: Record<string, unknown> }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const res = resolutions[i];
    const method = reasonToMethod(res?.omi_zone_reason);
    const confidence = typeof res?.omi_zone_confidence === "number" ? res.omi_zone_confidence : null;
    const validCode = res?.omi_zone_code && res.omi_zone_code !== UNRESOLVED_OMI_CODE ? res.omi_zone_code : null;

    const normComune = normalizeComune(r.comune);
    const isPadovaKnown = normComune === "padova";
    const isUnknown = normComune === "";

    // Rule 4: unknown comune promoted only via PIP or precomputed.
    const canPromote = isUnknown && !!validCode &&
      (method === "point_in_polygon" || method === "precomputed_omi");
    const treatAsPadova = isPadovaKnown || canPromote;

    if (!treatAsPadova) {
      // Unknown comune not promotable → do NOT assign zone, but still count.
      stats.processed++;
      // We touch zone_resolved_at only if we ran resolver meaningfully.
      // Rule says: alias/CAP alone cannot promote unknown → keep comune NULL,
      // no zone. Do NOT mark resolved_at so a future PIP-capable pass can retry.
      continue;
    }

    // Method counters (only for records we treat as Padova).
    if (method === "point_in_polygon") stats.point_in_polygon++;
    else if (method === "precomputed_omi") stats.precomputed_omi++;
    else if (method === "alias") stats.alias++;
    else if (method === "cap_hint") stats.cap_hint_not_assigned++;
    else stats.unresolved++;

    if (canPromote) stats.unknown_promoted_by_pip++;
    if (isPadovaKnown) stats.padova_confirmed++;

    // Determine zone assignment.
    let assign: Record<string, unknown>;
    const strongOk = validCode && STRONG_METHODS.has(method) &&
      confidence !== null && confidence >= MIN_CONF;
    const zoneHit = strongOk && validCode ? mapOmiToZone(validCode, zones) : null;

    if (strongOk && zoneHit) {
      stats.commercial_zone_assigned++;
      assign = {
        comune: "Padova",
        omi_zone: validCode,
        commercial_zone_slug: zoneHit.slug,
        quartiere: zoneHit.nome,
        zone_match_method: method,
        zone_match_confidence: confidence,
        zone_resolved_at: nowIso,
      };
    } else if (method === "cap_hint") {
      // Weak signal: keep method+confidence but no slug/quartiere/omi_zone.
      assign = {
        comune: isPadovaKnown ? "Padova" : r.comune,
        omi_zone: null,
        commercial_zone_slug: null,
        quartiere: null,
        zone_match_method: "cap_hint",
        zone_match_confidence: confidence,
        zone_resolved_at: nowIso,
      };
      if (r.commercial_zone_slug) stats.cleared_weak_assignments++;
    } else {
      // Unresolved / below-threshold / no zone mapping.
      assign = {
        comune: isPadovaKnown ? "Padova" : r.comune,
        omi_zone: null,
        commercial_zone_slug: null,
        quartiere: null,
        zone_match_method: "unresolved",
        zone_match_confidence: null,
        zone_resolved_at: nowIso,
      };
      if (r.commercial_zone_slug) stats.cleared_weak_assignments++;
    }

    stats.processed++;
    updates.push({ id: r.id, patch: assign });
  }

  // ---- Idempotent batched updates (per-id UPDATE to avoid disturbing other fields) ----
  const CONC = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < updates.length) {
      const idx = cursor++;
      const u = updates[idx];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (sb.from("padova_listings") as any)
        .update(u.patch)
        .eq("id", u.id);
      if (error) stats.errors.push(`update:${error.code ?? "?"}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, updates.length) }, () => worker()));

  return new Response(JSON.stringify({ ok: true, ...stats }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
