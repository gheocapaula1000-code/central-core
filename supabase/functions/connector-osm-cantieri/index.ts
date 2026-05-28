// ═══════════════════════════════════════════════════════════════
// connector-osm-cantieri — connettore OSM esteso (Padova + cintura)
// Sorgente: OpenStreetMap (Overpass API).
// 4 categorie reali: cantiere_edilizio, area_trasformazione,
// brownfield, demolizione. Genera titoli umani derivati dai tag reali
// e arricchisce con category + tags + external_ref.
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
const MAX_PER_QUERY = 80;

const COMUNI = [
  "Padova", "Albignasego", "Cadoneghe", "Rubano", "Selvazzano Dentro",
  "Ponte San Nicolò", "Noventa Padovana", "Vigodarzere", "Limena", "Abano Terme",
  "Saonara",
];

type Category = "cantiere_edilizio" | "area_trasformazione" | "brownfield" | "demolizione";

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
    tags["addr:suburb"], tags["addr:neighbourhood"],
    tags["addr:quarter"], tags["addr:city_district"],
  ];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v && v.length >= 2 && v.length <= 80) return v;
  }
  return null;
}

// Deriva la sotto-tipologia edificio da tag reali, senza inventare.
function buildingFamily(tags: Record<string, string>): { kind: string; label: string; tag?: string } {
  const b = (tags["building"] ?? "").toLowerCase();
  const cstr = (tags["construction"] ?? "").toLowerCase();
  const use = (tags["building:use"] ?? "").toLowerCase();
  const candidate = [use, cstr !== "yes" ? cstr : "", b !== "construction" && b !== "yes" ? b : ""]
    .find((x) => x && x.length > 0) ?? "";

  if (/apartment|residential|house|dormitory|terrace|detached|semidetached/.test(candidate)) {
    return { kind: "residenziale", label: "residenziale", tag: "residenziale" };
  }
  if (/commercial|retail|shop|supermarket|mall/.test(candidate)) {
    return { kind: "commerciale", label: "commerciale", tag: "commerciale" };
  }
  if (/office/.test(candidate)) return { kind: "direzionale", label: "direzionale", tag: "direzionale" };
  if (/industrial|warehouse|factory|manufacture/.test(candidate)) {
    return { kind: "produttivo", label: "produttivo", tag: "produttivo" };
  }
  if (/school|kindergarten|university|college|hospital|clinic|public/.test(candidate)) {
    return { kind: "servizi_pubblici", label: "servizi pubblici", tag: "servizi-pubblici" };
  }
  if (/hotel|hostel|guest_house/.test(candidate)) {
    return { kind: "ricettivo", label: "ricettivo", tag: "ricettivo" };
  }
  return { kind: "generico", label: "edilizio" };
}

function humanStreet(tags: Record<string, string>): string | null {
  const street = (tags["addr:street"] ?? "").trim();
  if (!street) return null;
  const num = (tags["addr:housenumber"] ?? "").trim();
  return num ? `${street} ${num}` : street;
}

function buildRecord(el: OverpassElement, comune: string, category: Category) {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const microzone = resolveMicrozone(tags);
  const street = humanStreet(tags);
  const name = (tags["name"] ?? "").trim();
  const fam = buildingFamily(tags);

  // Titolo umano, derivato da dati reali, mai con ID OSM dentro.
  let title: string;
  let property_type: string;
  const tagsArr: string[] = [category];

  switch (category) {
    case "cantiere_edilizio": {
      property_type = `cantiere ${fam.label}`;
      if (name) title = `${name} · cantiere a ${comune}`;
      else if (street) title = `Cantiere ${fam.label} in ${street}, ${comune}`;
      else title = `Cantiere ${fam.label} a ${comune}`;
      if (fam.tag) tagsArr.push(fam.tag);
      break;
    }
    case "area_trasformazione": {
      property_type = "area in trasformazione";
      title = street ? `Area in trasformazione in ${street}, ${comune}` : `Area in trasformazione a ${comune}`;
      tagsArr.push("trasformazione-urbana");
      break;
    }
    case "brownfield": {
      property_type = "area dismessa";
      title = street ? `Area dismessa in ${street}, ${comune}` : `Area dismessa in riconversione a ${comune}`;
      tagsArr.push("riconversione", "ex-industriale");
      break;
    }
    case "demolizione": {
      property_type = "demolizione / riconversione";
      title = street ? `Demolizione in ${street}, ${comune}` : `Demolizione / riconversione a ${comune}`;
      tagsArr.push("demolizione");
      break;
    }
  }
  if (street) tagsArr.push("con-indirizzo");
  if (microzone) tagsArr.push("con-microzona");

  return {
    source_name: "osm-overpass:padova-territory",
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    municipality: comune,
    microzone,
    title: title.slice(0, 160),
    address_text: street,
    property_type,
    ask_price: null,
    surface_mq: null,
    latitude: lat,
    longitude: lon,
    fetched_at: new Date().toISOString(),
    category,
    tags: tagsArr,
    external_ref: `osm:${el.type}/${el.id}`,
    raw_payload: { osm_id: el.id, osm_type: el.type, lat, lon, tags, comune, category },
  };
}

async function overpass(q: string): Promise<OverpassElement[]> {
  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "civiko-core/1.0" },
    body: `data=${encodeURIComponent(q)}`,
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return (data?.elements ?? []) as OverpassElement[];
}

async function fetchComune(comune: string): Promise<Array<ReturnType<typeof buildRecord>>> {
  const areaPrelude = `area["name"="${comune}"]["boundary"="administrative"]["admin_level"="8"]->.a;`;
  const queries: Array<{ cat: Category; body: string }> = [
    {
      cat: "cantiere_edilizio",
      body: `(node["building"="construction"](area.a); way["building"="construction"](area.a); relation["building"="construction"](area.a););`,
    },
    {
      cat: "area_trasformazione",
      body: `(way["landuse"="construction"](area.a); relation["landuse"="construction"](area.a););`,
    },
    {
      cat: "brownfield",
      body: `(way["landuse"="brownfield"](area.a); relation["landuse"="brownfield"](area.a););`,
    },
    {
      cat: "demolizione",
      body: `(way["building"="demolition"](area.a); way["demolished:building"](area.a););`,
    },
  ];

  const out: Array<ReturnType<typeof buildRecord>> = [];
  for (const { cat, body } of queries) {
    const q = `[out:json][timeout:30]; ${areaPrelude} ${body} out center ${MAX_PER_QUERY};`;
    try {
      const els = await overpass(q);
      for (const e of els) out.push(buildRecord(e, comune, cat));
    } catch (_) { /* skip query */ }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  // Path A: trusted scheduler job-secret (constant-time-ish compare).
  const providedJobSecret = req.headers.get("x-job-secret") ?? "";
  const jobSecretOk =
    !!JOB_SECRET && providedJobSecret.length === JOB_SECRET.length && providedJobSecret === JOB_SECRET;

  if (!jobSecretOk) {
    // Path B: admin Bearer JWT.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: { code: "unauthorized" } });

    const svc = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: isAdmin, error: roleErr } = await svc.rpc("has_role", {
      _user_id: userData.user.id, _role: "admin",
    });
    if (roleErr || !isAdmin) return json(403, { error: { code: "forbidden", message: "admin required" } });
  }

  if (!JOB_SECRET) return json(500, { error: { code: "misconfigured", message: "CENTRAL_CORE_JOB_SECRET not set" } });

  const perComune: Record<string, number> = {};
  const perCategory: Record<string, number> = {};
  const all: Array<ReturnType<typeof buildRecord>> = [];

  for (const c of COMUNI) {
    try {
      const recs = await fetchComune(c);
      perComune[c] = recs.length;
      for (const r of recs) {
        all.push(r);
        perCategory[r.category] = (perCategory[r.category] ?? 0) + 1;
      }
    } catch {
      perComune[c] = -1;
    }
  }

  if (all.length === 0) {
    return json(200, { ok: true, data: { read: 0, normalized: 0, perComune, perCategory, note: "no elements" } });
  }

  // POST in batch a ingest-opportunity (limite payload ragionevole: chunk da 200)
  let normalized = 0;
  const errors: string[] = [];
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-opportunity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "apikey": SERVICE_KEY,
        "x-job-secret": JOB_SECRET,
      },
      body: JSON.stringify(chunk),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      errors.push(`ingest chunk ${i}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
      continue;
    }
    const results = (body?.results ?? []) as Array<{ normalized_id?: string; error?: string }>;
    for (const r of results) {
      if (r.normalized_id) normalized++;
      if (r.error) errors.push(r.error);
    }
  }

  await svc.from("raw_sources_ingest").insert({
    source_name: "osm-overpass:padova-territory#sync-log",
    source_url: null,
    fetched_at: new Date().toISOString(),
    municipality: "Padova",
    microzone: null,
    raw_payload: { kind: "sync_log", read: all.length, normalized, perComune, perCategory, errors_count: errors.length },
    ingest_error: errors.length ? errors.slice(0, 5).join(" | ") : null,
  });

  return json(200, { ok: true, data: { read: all.length, normalized, perComune, perCategory, errors: errors.slice(0, 10) } });
});
