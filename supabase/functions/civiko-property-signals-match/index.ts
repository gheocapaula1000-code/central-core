// civiko-property-signals-match
// STEP 5 — Matcher segnali ↔ padova_listings.
//
// - verify_jwt=false (invocato da pg_cron o admin operator)
// - Protetto da x-job-secret (constant-time)
// - Legge solo civiko_signals_classified (usable_for_scoring=true)
// - Legge padova_listings (expired_at IS NULL)
// - Match cascata: geo_radius_300m → commercial_zone → quartiere_canon → municipality
// - UPSERT su property_signal_matches (property_id, signal_id)
// - Se rebuild=true: TRUNCATE all'inizio.

import { createClient } from "npm:@supabase/supabase-js@2";
import { constantTimeEqual, corsHeaders, fail, ok, makeDebugId } from "../_shared/http.ts";

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────
function requireJobSecret(req: Request, debugId: string): Response | null {
  const incoming = req.headers.get("x-job-secret") ?? "";
  const expected =
    Deno.env.get("CENTRAL_CORE_JOB_SECRET") ??
    Deno.env.get("AI_CORE_SECRET") ??
    "";
  if (!expected) {
    console.error("[civiko-property-signals-match] no job secret configured");
    return fail(req, 500, "CONFIG_ERROR", "job secret not configured", debugId);
  }
  if (!incoming) return fail(req, 401, "JOB_SECRET_REQUIRED", "Missing x-job-secret", debugId);
  if (!constantTimeEqual(incoming, expected)) {
    return fail(req, 401, "JOB_SECRET_REJECTED", "Invalid x-job-secret", debugId);
  }
  return null;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface Signal {
  signal_id: string;
  signal_type: string;
  sensitivity_level: string | null;
  allowed_commercial_phrase: string | null;
  visible_to_owner: boolean | null;
  usable_for_scoring: boolean | null;
  payload: Record<string, unknown> | null;
  // extracted
  lat: number | null;
  lng: number | null;
  municipality: string | null;
  quartiere: string | null;
  commercial_zone_slug: string | null;
}

interface Listing {
  id: number;
  property_id: string; // md5('padova_listings:'||id)
  lat: number | null;
  lng: number | null;
  quartiere: string | null;
  commercial_zone_slug: string | null;
}

type MatchReason = "geo_radius_300m" | "commercial_zone" | "quartiere_canon" | "municipality";

interface MatchRow {
  property_id: string;
  signal_id: string;
  distance_meters: number | null;
  relevance_score: number;
  match_reason: MatchReason;
  recommended_use: string | null;
  visible_in_owner_report: boolean;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}
function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}
function normQ(s: string | null): string | null {
  if (!s) return null;
  return s.trim().toLowerCase();
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// md5 via Deno crypto (SubtleCrypto non supporta md5 → uso implementazione std)
import { crypto as stdCrypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
async function md5Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await stdCrypto.subtle.digest("MD5", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────
const MUNI_ELIGIBLE_TYPES = new Set([
  "territorial",
  "urbanistica",
  "mobilita",
  "servizi",
  "accessibilita",
  "territorio",
  "estate_turnover",
]);

function fConfidence(sensitivity: string | null): number {
  switch ((sensitivity ?? "").toLowerCase()) {
    case "alto":
      return 1.0;
    case "medio":
      return 0.7;
    case "basso":
      return 0.4;
    default:
      return 0.4;
  }
}
function fGeo(reason: MatchReason): number {
  return reason === "geo_radius_300m"
    ? 1.0
    : reason === "commercial_zone"
    ? 0.7
    : reason === "quartiere_canon"
    ? 0.5
    : 0.2;
}
function fSensitivity(sensitivity: string | null): number {
  switch ((sensitivity ?? "").toLowerCase()) {
    case "alto":
      return 1.0;
    case "medio":
      return 0.6;
    case "basso":
      return 0.3;
    default:
      return 0.3;
  }
}
function relevance(sig: Signal, reason: MatchReason): number {
  return (
    0.4 * fConfidence(sig.sensitivity_level) +
    0.4 * fGeo(reason) +
    0.2 * fSensitivity(sig.sensitivity_level)
  );
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
Deno.serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "POST required", debugId);

  const authErr = requireJobSecret(req, debugId);
  if (authErr) return authErr;

  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    body = txt ? JSON.parse(txt) : {};
  } catch {
    return fail(req, 400, "INVALID_JSON", "invalid JSON body", debugId);
  }

  const dry_run = Boolean(body.dry_run ?? false);
  const rebuild = Boolean(body.rebuild ?? false);
  const radius_meters = Math.max(
    50,
    Math.min(1500, Number(body.radius_meters ?? 300) || 300),
  );
  const min_relevance = Math.max(0, Math.min(1, Number(body.min_relevance ?? 0.35) || 0.35));
  const max_per_property = Math.max(1, Math.min(200, Number(body.max_per_property ?? 20) || 20));
  const properties_limit = body.properties_limit != null
    ? Math.max(1, Math.min(50000, Number(body.properties_limit) || 100))
    : null;

  const startedAt = Date.now();
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  console.log(`[match] start dry_run=${dry_run} rebuild=${rebuild} radius=${radius_meters} min_rel=${min_relevance} max_per_prop=${max_per_property} properties_limit=${properties_limit ?? "null"} debug=${debugId}`);

  // ── TRUNCATE se rebuild
  if (rebuild && !dry_run) {
    const { error: delErr } = await supa
      .from("property_signal_matches")
      .delete()
      .gte("id", 0);
    if (delErr) {
      console.error("[match] rebuild delete failed:", delErr.message);
      return fail(req, 500, "REBUILD_FAILED", delErr.message, debugId);
    }
    console.log("[match] rebuild: property_signal_matches wiped");
  }

  // ── Load signals
  const signalsRaw: Array<Record<string, unknown>> = [];
  {
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa
        .from("civiko_signals_classified")
        .select("signal_id, signal_type, sensitivity_level, allowed_commercial_phrase, visible_to_owner, usable_for_scoring, payload")
        .eq("usable_for_scoring", true)
        .range(from, from + pageSize - 1);
      if (error) return fail(req, 500, "SIGNALS_FETCH_FAILED", error.message, debugId);
      if (!data || data.length === 0) break;
      signalsRaw.push(...(data as Array<Record<string, unknown>>));
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }
  const signals: Signal[] = signalsRaw.map((r) => {
    const p = (r.payload as Record<string, unknown> | null) ?? {};
    return {
      signal_id: String(r.signal_id),
      signal_type: String(r.signal_type ?? ""),
      sensitivity_level: (r.sensitivity_level as string | null) ?? null,
      allowed_commercial_phrase: (r.allowed_commercial_phrase as string | null) ?? null,
      visible_to_owner: (r.visible_to_owner as boolean | null) ?? null,
      usable_for_scoring: (r.usable_for_scoring as boolean | null) ?? null,
      payload: p,
      lat: toNum(p.lat),
      lng: toNum(p.lng),
      municipality: toStr(p.municipality),
      quartiere: toStr(p.quartiere),
      commercial_zone_slug: toStr(p.commercial_zone_slug),
    };
  });
  console.log(`[match] loaded ${signals.length} signals`);

  // ── Load active listings
  const listingsRaw: Array<Record<string, unknown>> = [];
  {
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const remaining = properties_limit != null ? properties_limit - listingsRaw.length : pageSize;
      if (properties_limit != null && remaining <= 0) break;
      const size = Math.min(pageSize, remaining);
      const { data, error } = await supa
        .from("padova_listings")
        .select("id, lat, lng, quartiere, commercial_zone_slug")
        .is("expired_at", null)
        .order("id", { ascending: true })
        .range(from, from + size - 1);
      if (error) return fail(req, 500, "LISTINGS_FETCH_FAILED", error.message, debugId);
      if (!data || data.length === 0) break;
      listingsRaw.push(...(data as Array<Record<string, unknown>>));
      if (data.length < size) break;
      from += size;
    }
  }

  // Build listings + property_id opachi
  const listings: Listing[] = [];
  for (const r of listingsRaw) {
    const id = Number(r.id);
    const pid = await md5Hex(`padova_listings:${id}`);
    listings.push({
      id,
      property_id: pid,
      lat: toNum(r.lat),
      lng: toNum(r.lng),
      quartiere: toStr(r.quartiere),
      commercial_zone_slug: toStr(r.commercial_zone_slug),
    });
  }
  console.log(`[match] loaded ${listings.length} listings`);

  // ── Compute matches
  // Struttura: per property_id, mappa signal_id → MatchRow (best per relevance).
  const perProperty = new Map<string, Map<string, MatchRow>>();

  const bump = (
    listing: Listing,
    sig: Signal,
    reason: MatchReason,
    distance: number | null,
  ) => {
    const score = relevance(sig, reason);
    if (score < min_relevance) return;
    let m = perProperty.get(listing.property_id);
    if (!m) {
      m = new Map();
      perProperty.set(listing.property_id, m);
    }
    const existing = m.get(sig.signal_id);
    if (existing && existing.relevance_score >= score) return;
    m.set(sig.signal_id, {
      property_id: listing.property_id,
      signal_id: sig.signal_id,
      distance_meters: distance,
      relevance_score: Number(score.toFixed(4)),
      match_reason: reason,
      recommended_use: sig.allowed_commercial_phrase,
      visible_in_owner_report: Boolean(sig.visible_to_owner),
    });
  };

  // Indici veloci
  const byZone = new Map<string, Listing[]>();
  const byQuartiere = new Map<string, Listing[]>();
  const listingsWithGeo: Listing[] = [];
  for (const l of listings) {
    if (l.commercial_zone_slug) {
      const arr = byZone.get(l.commercial_zone_slug) ?? [];
      arr.push(l);
      byZone.set(l.commercial_zone_slug, arr);
    }
    const q = normQ(l.quartiere);
    if (q) {
      const arr = byQuartiere.get(q) ?? [];
      arr.push(l);
      byQuartiere.set(q, arr);
    }
    if (l.lat != null && l.lng != null) listingsWithGeo.push(l);
  }

  // Cascata: per ogni signal, determina i listings candidati e classifica.
  // NB: la spec dice "primo che matcha vince" a livello di coppia (property,signal).
  // Applichiamo la cascata su ogni signal così che ogni coppia sia scritta con
  // il metodo più forte disponibile.
  for (const sig of signals) {
    // 1) geo_radius
    if (sig.lat != null && sig.lng != null) {
      for (const l of listingsWithGeo) {
        const d = haversineMeters(sig.lat, sig.lng, l.lat!, l.lng!);
        if (d <= radius_meters) {
          bump(l, sig, "geo_radius_300m", Math.round(d * 100) / 100);
        }
      }
    }
    // 2) commercial_zone
    if (sig.commercial_zone_slug) {
      const arr = byZone.get(sig.commercial_zone_slug);
      if (arr) {
        for (const l of arr) {
          // Skip se già matchato via geo per questa coppia con score più alto (bump lo gestisce)
          bump(l, sig, "commercial_zone", null);
        }
      }
    }
    // 3) quartiere_canon
    if (sig.quartiere) {
      const arr = byQuartiere.get(normQ(sig.quartiere)!);
      if (arr) {
        for (const l of arr) {
          bump(l, sig, "quartiere_canon", null);
        }
      }
    }
    // 4) municipality (solo tipi eleggibili + comune=Padova)
    if (
      MUNI_ELIGIBLE_TYPES.has(sig.signal_type) &&
      (sig.municipality ?? "").toLowerCase() === "padova"
    ) {
      for (const l of listings) {
        bump(l, sig, "municipality", null);
      }
    }
  }

  // ── Cap top-K per property + accumulate
  const finalRows: MatchRow[] = [];
  const byReason: Record<MatchReason, number> = {
    geo_radius_300m: 0,
    commercial_zone: 0,
    quartiere_canon: 0,
    municipality: 0,
  };
  let maxMatchesPerProperty = 0;
  for (const [, m] of perProperty) {
    const arr = Array.from(m.values()).sort((a, b) => b.relevance_score - a.relevance_score);
    const kept = arr.slice(0, max_per_property);
    if (kept.length > maxMatchesPerProperty) maxMatchesPerProperty = kept.length;
    for (const r of kept) {
      finalRows.push(r);
      byReason[r.match_reason]++;
    }
  }
  const propertiesWithMatches = perProperty.size;
  const propertiesWithoutMatches = listings.length - propertiesWithMatches;
  const avgMatches = propertiesWithMatches > 0
    ? Number((finalRows.length / propertiesWithMatches).toFixed(2))
    : 0;

  // ── Sample: 5 più rilevanti
  const sample = [...finalRows]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 5);

  // ── UPSERT
  let matchesWritten = 0;
  if (!dry_run && finalRows.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < finalRows.length; i += batchSize) {
      const chunk = finalRows.slice(i, i + batchSize);
      const { error } = await supa
        .from("property_signal_matches")
        .upsert(chunk, { onConflict: "property_id,signal_id" });
      if (error) {
        console.error(`[match] upsert batch ${i} failed:`, error.message);
        return fail(req, 500, "UPSERT_FAILED", error.message, debugId);
      }
      matchesWritten += chunk.length;
    }
    console.log(`[match] wrote ${matchesWritten} matches`);

    // ── DELETE conservativa (solo se non rebuild)
    if (!rebuild) {
      const propertyIds = Array.from(perProperty.keys());
      const validSignalIds = new Set(finalRows.map((r) => r.signal_id));
      // Cancella coppie in cui il signal_id non è più tra i validi *per quei property_id*.
      // NB: query pesante → limitiamo a properties toccate in questo run.
      const delBatch = 500;
      let deleted = 0;
      for (let i = 0; i < propertyIds.length; i += delBatch) {
        const pidChunk = propertyIds.slice(i, i + delBatch);
        // Carica esistenti per queste properties
        const { data: existing, error: exErr } = await supa
          .from("property_signal_matches")
          .select("id, property_id, signal_id")
          .in("property_id", pidChunk);
        if (exErr) {
          console.warn("[match] delete-load failed:", exErr.message);
          continue;
        }
        const stale = (existing ?? [])
          .filter((r) => !validSignalIds.has(String((r as Record<string, unknown>).signal_id)))
          .map((r) => (r as Record<string, unknown>).id as number);
        if (stale.length === 0) continue;
        // cap 5000/tx
        for (let j = 0; j < stale.length; j += 5000) {
          const idsChunk = stale.slice(j, j + 5000);
          const { error: dErr } = await supa
            .from("property_signal_matches")
            .delete()
            .in("id", idsChunk);
          if (dErr) {
            console.warn("[match] delete failed:", dErr.message);
            break;
          }
          deleted += idsChunk.length;
        }
      }
      console.log(`[match] deleted ${deleted} stale matches`);
    }
  }

  const duration_ms = Date.now() - startedAt;
  console.log(`[match] done in ${duration_ms}ms — written=${matchesWritten} candidates=${finalRows.length}`);

  return ok(
    req,
    {
      ok: true,
      dry_run,
      rebuild,
      duration_ms,
      radius_meters,
      min_relevance,
      listings_processed: listings.length,
      signals_considered: signals.length,
      matches_written: dry_run ? 0 : matchesWritten,
      matches_candidates: finalRows.length,
      matches_by_reason: byReason,
      properties_with_matches: propertiesWithMatches,
      properties_without_matches: propertiesWithoutMatches,
      avg_matches_per_property: avgMatches,
      max_matches_per_property: maxMatchesPerProperty,
      sample_matches: sample,
    },
    [],
    debugId,
  );
});
