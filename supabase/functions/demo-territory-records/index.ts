// demo-territory-records
// Endpoint pubblico sicuro: selezione minima ma reale dei segnali territoriali
// del pilota (Padova + cintura). Nessun dato sensibile, niente raw_payload,
// niente null rumorosi. Arricchito con area_label/freshness_label/priority_label.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUPPORTED_CITIES = new Set(["padova"]);
const MAX_RECORDS = 12;

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

function sanitizeTitle(t: string): string {
  if (!t) return "Segnale territoriale";
  let s = t.replace(/\(OSM [a-z]+\/\d+\)/gi, "").replace(/\s+/g, " ").trim();
  if (s.length > 90) s = s.slice(0, 87) + "…";
  return s || "Segnale territoriale";
}

function freshnessLabel(d: number): string {
  if (d <= 7) return "ultimi 7 giorni";
  if (d <= 30) return "ultimo mese";
  if (d <= 90) return "ultimi 3 mesi";
  return "oltre 3 mesi";
}

function priorityLabel(s: number): string {
  if (s >= 80) return "alta";
  if (s >= 60) return "medio-alta";
  if (s >= 40) return "media";
  return "bassa";
}

function deriveAreaLabel(
  lat: number | null,
  lon: number | null,
  municipality: string | null,
  microzone: string | null,
): string {
  if (microzone) return microzone;
  const muni = municipality ?? "Padova";
  if (lat == null || lon == null) return muni;
  if (muni.toLowerCase() !== "padova") return muni;
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

function reasonShort(score: number, category: string | null, hasGeo: boolean, hasMicrozone: boolean): string {
  const bits: string[] = [`priorità ${priorityLabel(score)}`];
  const catLabel: Record<string, string> = {
    cantiere_edilizio: "cantiere attivo",
    area_trasformazione: "area in trasformazione",
    brownfield: "area dismessa",
    demolizione: "demolizione in corso",
    segnale_demografico: "ricambio generazionale",
  };
  if (category && catLabel[category]) bits.push(catLabel[category]);
  if (hasMicrozone) bits.push("microzona nota");
  else if (hasGeo) bits.push("geo verificata");
  return bits.join(" · ");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const cityRaw = (url.searchParams.get("city") || "").trim().toLowerCase();
  if (!cityRaw) return json({ error: "missing_city" }, 400);
  if (!SUPPORTED_CITIES.has(cityRaw)) {
    return json({ error: "city_not_supported", city: cityRaw, supported: [...SUPPORTED_CITIES] }, 400);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE);

  // Strategia "pochi ma buoni": preferisco record con geo, escludo titolo vuoto.
  // Diversifica anche per category per coprire più tipi di segnale.
  const { data, error } = await admin
    .from("normalized_opportunities")
    .select(
      "title,municipality,microzone,source_name,last_seen_at,freshness_days,priority_score,latitude,longitude,category,tags",
    )
    .in("municipality", CINTURA)
    .gt("priority_score", 0)
    .order("priority_score", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(MAX_RECORDS * 6);

  if (error) {
    console.log("demo-territory-records query error", error.message);
    return json({ error: "query_failed" }, 500);
  }

  const seenArea = new Map<string, number>();
  const seenCat = new Map<string, number>();
  const selected: any[] = [];
  for (const r of data ?? []) {
    const area = deriveAreaLabel(
      r.latitude == null ? null : Number(r.latitude),
      r.longitude == null ? null : Number(r.longitude),
      r.municipality,
      r.microzone,
    );
    const cat = r.category ?? "altro";
    if ((seenArea.get(area) ?? 0) >= 2) continue;
    if ((seenCat.get(cat) ?? 0) >= 5) continue;
    seenArea.set(area, (seenArea.get(area) ?? 0) + 1);
    seenCat.set(cat, (seenCat.get(cat) ?? 0) + 1);
    selected.push({ ...r, _area: area });
    if (selected.length >= MAX_RECORDS) break;
  }

  const records = selected.map((r: any) => {
    const lat = r.latitude == null ? null : Number(r.latitude);
    const lon = r.longitude == null ? null : Number(r.longitude);
    const hasGeo = lat != null && lon != null;
    const freshness = Number(r.freshness_days ?? 0);
    const score = Number(r.priority_score ?? 0);
    return {
      title: sanitizeTitle(r.title ?? ""),
      municipality: r.municipality ?? "Padova",
      microzone: r.microzone,
      area_label: r._area,
      category: r.category ?? null,
      tags: Array.isArray(r.tags) ? r.tags : [],
      source_name: r.source_name,
      last_seen_at: r.last_seen_at,
      freshness_days: freshness,
      freshness_label: freshnessLabel(freshness),
      priority_score: score,
      priority_label: priorityLabel(score),
      reason_short: reasonShort(score, r.category ?? null, hasGeo, r.microzone != null),
      has_geo: hasGeo,
    };
  });

  console.log(`demo-territory-records city=${cityRaw} served=${records.length}`);
  return json({ city: cityRaw, demo: true, count: records.length, records });
});
