// ═══════════════════════════════════════════════════════════════
// connector-osm-cantieri — connettore OSM esteso (Padova + cintura)
// Sorgente: OpenStreetMap (Overpass API). Recupera cantieri/edifici
// in costruzione su Padova città e prima cintura, li invia a
// ingest-opportunity con x-job-secret (server-side).
// Solo admin autenticati possono triggerare la sync.
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
const MAX_PER_COMUNE = 60;

// Padova città + prima cintura supportata da OSM admin_level=8
const COMUNI = [
  "Padova", "Albignasego", "Cadoneghe", "Rubano", "Selvazzano Dentro",
  "Ponte San Nicolò", "Noventa Padovana", "Vigodarzere", "Limena", "Abano Terme",
  "Saonara",
];

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

function resolveMicrozone(tags: Record<string, string>): string | null {
  const candidates = [
    tags["addr:suburb"],
    tags["addr:neighbourhood"],
    tags["addr:quarter"],
    tags["addr:city_district"],
  ];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v && v.length >= 2 && v.length <= 80) return v;
  }
  return null;
}

function buildTitle(tags: Record<string, string>, comune: string): string {
  const name = (tags["name"] ?? "").trim();
  if (name) return `Cantiere: ${name}`.slice(0, 140);
  const street = (tags["addr:street"] ?? "").trim();
  if (street) {
    const num = (tags["addr:housenumber"] ?? "").trim();
    return `Cantiere in ${street}${num ? " " + num : ""}, ${comune}`.slice(0, 140);
  }
  const use = (tags["building:use"] ?? tags["construction"] ?? "").trim();
  if (use && use !== "yes") return `Cantiere ${use} a ${comune}`.slice(0, 140);
  return `Cantiere edilizio a ${comune}`;
}

function buildPayload(el: OverpassElement, comune: string) {
  const tags = el.tags ?? {};
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  const address = [street, number].filter(Boolean).join(" ") || null;
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const microzone = resolveMicrozone(tags);
  const construction = tags["construction"];
  const property_type =
    tags["building:use"] ??
    (construction && construction !== "yes" ? construction : null) ??
    (tags["landuse"] === "construction" ? "area edificabile" : "cantiere");

  return {
    source_name: "osm-overpass:padova-construction",
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    municipality: comune,
    microzone,
    title: buildTitle(tags, comune),
    address_text: address,
    property_type,
    ask_price: null,
    surface_mq: null,
    latitude: lat,
    longitude: lon,
    fetched_at: new Date().toISOString(),
    raw_payload: { osm_id: el.id, osm_type: el.type, lat, lon, tags, comune },
  };
}

async function fetchComune(comune: string): Promise<OverpassElement[]> {
  const q = `
    [out:json][timeout:30];
    area["name"="${comune}"]["boundary"="administrative"]["admin_level"="8"]->.a;
    (
      node["building"="construction"](area.a);
      way["building"="construction"](area.a);
      relation["building"="construction"](area.a);
      way["landuse"="construction"](area.a);
    );
    out center ${MAX_PER_COMUNE};
  `.trim();
  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "civiko-core/1.0" },
    body: `data=${encodeURIComponent(q)}`,
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return (data?.elements ?? []) as OverpassElement[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

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

  // 1) raccolta su tutti i comuni della cintura (sequenziale per fair-use)
  const perComune: Record<string, number> = {};
  const all: ReturnType<typeof buildPayload>[] = [];
  for (const c of COMUNI) {
    try {
      const els = await fetchComune(c);
      perComune[c] = els.length;
      for (const e of els) all.push(buildPayload(e, c));
    } catch {
      perComune[c] = -1;
    }
  }

  if (all.length === 0) {
    return json(200, { ok: true, data: { read: 0, normalized: 0, errors: [], perComune, note: "no elements" } });
  }

  // 2) inoltra a ingest-opportunity in batch
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
    body: JSON.stringify(all),
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

  // 3) log sintetico
  await svc.from("raw_sources_ingest").insert({
    source_name: "osm-overpass:padova-construction#sync-log",
    source_url: null,
    fetched_at: new Date().toISOString(),
    municipality: "Padova",
    microzone: null,
    raw_payload: { kind: "sync_log", read: all.length, normalized, perComune, errors_count: errors.length },
    ingest_error: errors.length ? errors.slice(0, 5).join(" | ") : null,
  });

  return json(200, { ok: true, data: { read: all.length, normalized, perComune, errors: errors.slice(0, 10) } });
});
