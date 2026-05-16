// ═══════════════════════════════════════════════════════════════
// connector-osm-cantieri — primo connettore reale del motore dati
// Sorgente: OpenStreetMap (Overpass API). Recupera edifici taggati
// building=construction nel territorio comunale di Padova e li
// inoltra a ingest-opportunity (con x-job-secret server-side).
// Solo admin autenticati possono triggerare la sync.
// Limiti/cautele:
//  - Overpass è fair-use: max 1 sync ogni ~5 min consigliato
//  - Cap MAX_ITEMS records per run (default 80)
//  - Nessun dato sensibile, solo geometrie pubbliche
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MAX_ITEMS = 80;

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildPayload(el: OverpassElement) {
  const tags = el.tags ?? {};
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  const suburb = tags["addr:suburb"] ?? tags["addr:neighbourhood"];
  const address = [street, number].filter(Boolean).join(" ") || null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const title = tags["name"]
    ? `Cantiere: ${tags["name"]}`
    : `Cantiere in costruzione (OSM ${el.type}/${el.id})`;

  return {
    source_name: "osm-overpass:padova-construction",
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    municipality: "Padova",
    microzone: suburb ?? null,
    title,
    address_text: address,
    property_type: tags["building:use"] ?? "cantiere",
    ask_price: null,
    surface_mq: null,
    fetched_at: new Date().toISOString(),
    raw_payload: { osm_id: el.id, osm_type: el.type, lat, lon, tags },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  // auth: admin only (verify_jwt=true al gateway + role check qui)
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: { code: "unauthorized" } });

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: isAdmin, error: roleErr } = await svc.rpc("has_role", {
    _user_id: userData.user.id,
    _role: "admin",
  });
  if (roleErr || !isAdmin) return json(403, { error: { code: "forbidden", message: "admin required" } });

  if (!JOB_SECRET) return json(500, { error: { code: "misconfigured", message: "CENTRAL_CORE_JOB_SECRET not set" } });

  // 1) fetch Overpass — area Comune di Padova
  const query = `
    [out:json][timeout:25];
    area["name"="Padova"]["boundary"="administrative"]["admin_level"="8"]->.a;
    (
      node["building"="construction"](area.a);
      way["building"="construction"](area.a);
      relation["building"="construction"](area.a);
    );
    out center ${MAX_ITEMS};
  `.trim();

  let elements: OverpassElement[] = [];
  try {
    const r = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!r.ok) return json(502, { error: { code: "overpass_http", message: `Overpass HTTP ${r.status}` } });
    const data = await r.json();
    elements = (data?.elements ?? []) as OverpassElement[];
  } catch (e) {
    return json(502, { error: { code: "overpass_fetch", message: e instanceof Error ? e.message : "fetch failed" } });
  }

  const read = elements.length;
  if (read === 0) {
    return json(200, { ok: true, data: { read: 0, normalized: 0, errors: [], note: "no elements" } });
  }

  // 2) forward in batch a ingest-opportunity (col job secret server-side)
  const items = elements.slice(0, MAX_ITEMS).map(buildPayload);
  let normalized = 0;
  const errors: string[] = [];

  const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-opportunity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "apikey": SERVICE_KEY,
      "x-job-secret": JOB_SECRET,
    },
    body: JSON.stringify(items),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(502, { error: { code: "ingest_failed", message: body?.error?.message ?? `HTTP ${res.status}` } });
  }
  const results = (body?.results ?? []) as Array<{ normalized_id?: string; error?: string }>;
  for (const r of results) {
    if (r.normalized_id) normalized++;
    if (r.error) errors.push(r.error);
  }

  // 3) log esecuzione su raw (riga sintetica) per "ultima sincronizzazione"
  await svc.from("raw_sources_ingest").insert({
    source_name: "osm-overpass:padova-construction#sync-log",
    source_url: null,
    fetched_at: new Date().toISOString(),
    municipality: "Padova",
    microzone: null,
    raw_payload: { kind: "sync_log", read, normalized, errors_count: errors.length },
    ingest_error: errors.length ? errors.slice(0, 5).join(" | ") : null,
  });

  return json(200, { ok: true, data: { read, normalized, errors: errors.slice(0, 10) } });
});
