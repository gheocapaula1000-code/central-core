// zone-completeness
// Admin endpoint: classifica di completezza territoriale per zona
// (Padova città per settori + comuni cintura).
// GET  -> ritorna la classifica salvata, ordinata per completeness_score DESC
// POST -> ricalcola la classifica dai dati reali in normalized_opportunities
// Accesso: utente autenticato con ruolo 'admin' o 'moderator'.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const PD_LAT = 45.4064;
const PD_LON = 11.8768;

const CINTURA = [
  "Padova", "Albignasego", "Cadoneghe", "Rubano", "Selvazzano Dentro",
  "Ponte San Nicolò", "Noventa Padovana", "Vigodarzere", "Limena", "Abano Terme",
  "Saonara",
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function deriveAreaLabel(
  lat: number | null,
  lon: number | null,
  municipality: string | null,
): string {
  const muni = municipality ?? "Padova";
  if (muni.toLowerCase() !== "padova") return muni;
  if (lat == null || lon == null) return "Padova";
  const dLat = lat - PD_LAT;
  const dLon = lon - PD_LON;
  const r = Math.sqrt(dLat * dLat + dLon * dLon);
  if (r < 0.012) return "Padova · Centro";
  const angle = (Math.atan2(dLat, dLon) * 180) / Math.PI;
  let dir = "Ovest";
  if (angle >= -22.5 && angle < 22.5) dir = "Est";
  else if (angle >= 22.5 && angle < 67.5) dir = "Nord-Est";
  else if (angle >= 67.5 && angle < 112.5) dir = "Nord";
  else if (angle >= 112.5 && angle < 157.5) dir = "Nord-Ovest";
  else if (angle >= -67.5 && angle < -22.5) dir = "Sud-Est";
  else if (angle >= -112.5 && angle < -67.5) dir = "Sud";
  else if (angle >= -157.5 && angle < -112.5) dir = "Sud-Ovest";
  return `Padova · settore ${dir}`;
}

function readinessFromScore(s: number): string {
  if (s >= 70) return "pronta";
  if (s >= 45) return "quasi pronta";
  return "debole";
}

function reasonShort(
  total: number,
  cats: number,
  geoRatio: number,
  freshDays: number,
  readiness: string,
): string {
  if (readiness === "pronta") {
    return `molti segnali (${total}), ${cats} categorie, geo ${(geoRatio * 100).toFixed(0)}%`;
  }
  if (readiness === "quasi pronta") {
    return `copertura discreta (${total} record, ${cats} cat.), freschezza media ${Math.round(freshDays)}gg`;
  }
  return `pochi dati (${total} record, ${cats} cat.) — non ancora pronta per proposta commerciale`;
}

type Row = {
  municipality: string | null;
  latitude: number | null;
  longitude: number | null;
  category: string | null;
  freshness_days: number | null;
  completeness_score: number | null;
  priority_score: number | null;
};

function computeZones(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const lat = r.latitude == null ? null : Number(r.latitude);
    const lon = r.longitude == null ? null : Number(r.longitude);
    const key = deriveAreaLabel(lat, lon, r.municipality);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const [label, items] of groups.entries()) {
    const total = items.length;
    const cats = new Map<string, number>();
    let geoCount = 0;
    let freshSum = 0;
    let freshN = 0;
    let qualOk = 0;
    for (const it of items) {
      const c = it.category ?? "altro";
      cats.set(c, (cats.get(c) ?? 0) + 1);
      const lat = it.latitude == null ? null : Number(it.latitude);
      const lon = it.longitude == null ? null : Number(it.longitude);
      if (lat != null && lon != null) geoCount++;
      const fd = it.freshness_days;
      if (fd != null) { freshSum += Number(fd); freshN++; }
      if ((it.completeness_score ?? 0) >= 50 && (it.priority_score ?? 0) >= 40) qualOk++;
    }
    const geoRatio = total > 0 ? geoCount / total : 0;
    const avgFresh = freshN > 0 ? freshSum / freshN : 365;
    // freshness score 0..1 (≤7gg=1, ≤30=0.8, ≤90=0.5, ≤180=0.25, oltre=0.1)
    const freshnessScore =
      avgFresh <= 7 ? 1 : avgFresh <= 30 ? 0.8 : avgFresh <= 90 ? 0.5 : avgFresh <= 180 ? 0.25 : 0.1;
    const minQualityRatio = total > 0 ? qualOk / total : 0;
    const catCount = cats.size;

    // Formula completeness_score (0..100), pesi espliciti:
    //  volume      30%  (saturazione a 25 record)
    //  varietà     20%  (saturazione a 4 categorie)
    //  geo         20%  (geo_coverage_ratio)
    //  freshness   15%  (freshness_score)
    //  qualità min 15%  (min_quality_ratio)
    const volume = Math.min(1, total / 25);
    const variety = Math.min(1, catCount / 4);
    const score =
      volume * 30 +
      variety * 20 +
      geoRatio * 20 +
      freshnessScore * 15 +
      minQualityRatio * 15;
    const completeness = Math.round(score * 10) / 10;
    const readiness = readinessFromScore(completeness);

    const topCats = [...cats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

    out.push({
      zone_key: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      zone_label: label,
      total_records: total,
      categories_count: catCount,
      geo_coverage_ratio: Math.round(geoRatio * 1000) / 1000,
      freshness_score: Math.round(freshnessScore * 1000) / 1000,
      avg_freshness_days: Math.round(avgFresh * 10) / 10,
      min_quality_ratio: Math.round(minQualityRatio * 1000) / 1000,
      completeness_score: completeness,
      readiness_label: readiness,
      top_categories: topCats,
      reason_short: reasonShort(total, catCount, geoRatio, avgFresh, readiness),
    });
  }
  out.sort((a, b) => (b.completeness_score as number) - (a.completeness_score as number));
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "moderator"])
    .limit(1)
    .maybeSingle();
  if (!roleRow) return json({ error: "forbidden" }, 403);

  if (req.method === "POST") {
    // Ricalcola classifica
    const { data: rows, error } = await admin
      .from("normalized_opportunities")
      .select("municipality,latitude,longitude,category,freshness_days,completeness_score,priority_score")
      .in("municipality", CINTURA)
      .gt("priority_score", 0)
      .limit(5000);
    if (error) return json({ error: "query_failed", message: error.message }, 500);

    const zones = computeZones((rows ?? []) as Row[]);
    const computed_at = new Date().toISOString();

    // Upsert
    const payload = zones.map((z) => ({ ...z, computed_at }));
    if (payload.length > 0) {
      const { error: upErr } = await admin
        .from("zone_completeness")
        .upsert(payload, { onConflict: "zone_key" });
      if (upErr) return json({ error: "upsert_failed", message: upErr.message }, 500);
    }
    console.log(`zone-completeness recomputed zones=${zones.length}`);
    return json({ ok: true, computed_at, count: zones.length, zones });
  }

  // GET: leggi la fotografia salvata con filtri opzionali
  const url = new URL(req.url);
  const minStr = url.searchParams.get("min_completeness");
  const minScore = minStr != null ? Number(minStr) : null;
  const readinessFilter = url.searchParams.get("readiness"); // pronta|quasi pronta|debole
  let q = admin.from("zone_completeness").select("*").order("completeness_score", { ascending: false });
  if (minScore != null && Number.isFinite(minScore)) q = q.gte("completeness_score", minScore);
  if (readinessFilter) q = q.eq("readiness_label", readinessFilter);
  const { data, error } = await q;
  if (error) return json({ error: "query_failed", message: error.message }, 500);
  return json({ count: data?.length ?? 0, filters: { min_completeness: minScore, readiness: readinessFilter }, zones: data ?? [] });
});
