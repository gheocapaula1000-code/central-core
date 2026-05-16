// territory-records
// Endpoint protetto per PWA Civiko: record reali normalizzati per il pilota
// (Padova + cintura). Aggiunge area_label derivata da coordinate, freshness_label
// e priority_label. Niente raw_payload, niente campi tecnici, niente null rumorosi.
//
// Accesso: utente autenticato con ruolo 'admin' o 'moderator'.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUPPORTED_CITIES = new Set(["padova"]);
const MAX_RECORDS = 60;

// Centroide Padova centro storico (Prato della Valle / Cavour)
const PD_LAT = 45.4064;
const PD_LON = 11.8768;

type CleanRecord = {
  title: string;
  municipality: string | null;
  microzone: string | null;
  area_label: string;
  source_name: string;
  last_seen_at: string;
  freshness_days: number;
  freshness_label: string;
  priority_score: number;
  priority_label: string;
  reason_short: string;
  has_geo: boolean;
  latitude: number | null;
  longitude: number | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

// Settore cardinale derivato da coordinate reali rispetto al centro Padova.
// Niente nomi di microzone inventati: solo orientamento geometrico oggettivo.
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
  const angle = (Math.atan2(dLat, dLon) * 180) / Math.PI; // E=0, N=+90
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

function reasonShort(score: number, source: string, hasGeo: boolean, hasMicrozone: boolean): string {
  const bits: string[] = [];
  bits.push(`priorità ${priorityLabel(score)}`);
  if (source.includes("osm-overpass")) bits.push("cantiere rilevato");
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

  // Include Padova città + comuni di prima cintura serviti dal connettore.
  const CINTURA = [
    "Padova", "Albignasego", "Cadoneghe", "Rubano", "Selvazzano Dentro",
    "Ponte San Nicolò", "Noventa Padovana", "Vigodarzere", "Limena", "Abano Terme",
    "Saonara",
  ];

  const { data, error } = await admin
    .from("normalized_opportunities")
    .select(
      "title,municipality,microzone,source_name,last_seen_at,freshness_days,priority_score,scoring_reason,latitude,longitude",
    )
    .in("municipality", CINTURA)
    .gt("priority_score", 0)
    .not("title", "is", null)
    .order("priority_score", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(MAX_RECORDS);

  if (error) {
    console.log("territory-records query error", error.message);
    return json({ error: "query_failed", message: error.message }, 500);
  }

  const records: CleanRecord[] = (data ?? []).map((r: any) => {
    const lat = r.latitude == null ? null : Number(r.latitude);
    const lon = r.longitude == null ? null : Number(r.longitude);
    const hasGeo = lat != null && lon != null;
    const freshness = Number(r.freshness_days ?? 0);
    const score = Number(r.priority_score ?? 0);
    return {
      title: r.title,
      municipality: r.municipality,
      microzone: r.microzone,
      area_label: deriveAreaLabel(lat, lon, r.municipality, r.microzone),
      source_name: r.source_name,
      last_seen_at: r.last_seen_at,
      freshness_days: freshness,
      freshness_label: freshnessLabel(freshness),
      priority_score: score,
      priority_label: priorityLabel(score),
      reason_short: reasonShort(score, r.source_name ?? "", hasGeo, r.microzone != null),
      has_geo: hasGeo,
      latitude: lat,
      longitude: lon,
    };
  });

  console.log(`territory-records city=${cityRaw} served=${records.length}`);
  return json({ city: cityRaw, count: records.length, records });
});
