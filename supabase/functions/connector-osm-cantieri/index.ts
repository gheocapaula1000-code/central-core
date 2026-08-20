// ═══════════════════════════════════════════════════════════════
// connector-osm-cantieri — connettore OSM esteso (Padova + cintura)
// Sorgente: OpenStreetMap (Overpass API).
// 4 categorie reali: cantiere_edilizio, area_trasformazione,
// brownfield, demolizione. Genera titoli umani derivati dai tag reali
// e arricchisce con category + tags + external_ref.
// Solo admin autenticati possono triggerare la sync.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isJobSecretAuthorized } from "../_shared/http.ts";
import { writeSourceRegistryStatus } from "../_shared/sourceRegistryStatus.ts";
import { commercialZoneForQuartiere } from "../_shared/civikoCommercialZoneByQuartiere.ts";
import { OSM_LOCAL_SOURCE_NAME } from "../_shared/padovaUrbanLayers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
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

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);

  // Path A: trusted scheduler / pg_cron / GitHub Actions (x-job-secret).
  const jobSecretOk = isJobSecretAuthorized(req, JOB_SECRET);

  if (!jobSecretOk) {
    // Path B: admin Bearer JWT.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: { code: "unauthorized" } });

    const { data: isAdmin, error: roleErr } = await svc.rpc("has_role", {
      _user_id: userData.user.id, _role: "admin",
    });
    if (roleErr || !isAdmin) return json(403, { error: { code: "forbidden", message: "admin required" } });
  }

  if (!JOB_SECRET) return json(500, { error: { code: "misconfigured", message: "CENTRAL_CORE_JOB_SECRET not set" } });

  try {
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

  const failedComuni = Object.values(perComune).filter((n) => n < 0).length;

  if (all.length === 0) {
    const emptyErr = failedComuni === COMUNI.length ? "overpass_all_comuni_failed" : null;
    await writeSourceRegistryStatus(svc, "F5", {
      ok: !emptyErr,
      records: 0,
      error: emptyErr,
    });
    return json(200, {
      ok: true,
      records_processed: 0,
      data: { read: 0, normalized: 0, records_processed: 0, perComune, perCategory, note: emptyErr ?? "no elements" },
    });
  }

  const errors: string[] = [];

  // Also persist Padova OSM into sue_padova_permits + local_signals.
  // F5 previously only called ingest-opportunity, so both tables stayed empty.
  const padovaOsm = all.filter((r) => r.municipality === "Padova");
  if (padovaOsm.length > 0) {
    const fetchedAt = new Date().toISOString();
    const sueRows = padovaOsm.map((r) => ({
      area_name: r.microzone,
      address_public: r.address_text,
      practice_type: r.category,
      practice_date: null,
      status: "open_data_osm",
      source_url: r.source_url,
      source_name: r.source_name,
      external_id: r.external_ref,
      commercial_zone_slug: commercialZoneForQuartiere(r.microzone),
      fetched_at: fetchedAt,
      imported_at: fetchedAt,
      compliance_verified: false,
      raw_ref: r.raw_payload,
    }));
    for (let i = 0; i < sueRows.length; i += 200) {
      const { error } = await svc.from("sue_padova_permits").upsert(sueRows.slice(i, i + 200), {
        onConflict: "source_url,external_id",
      });
      if (error) errors.push(`sue_padova_permits:${error.message}`);
    }

    const { data: srcRow } = await svc.from("local_sources").select("id").eq("name", OSM_LOCAL_SOURCE_NAME).limit(1).maybeSingle();
    let sourceId = srcRow?.id ?? null;
    if (!sourceId) {
      const { data: created } = await svc.from("local_sources").insert({
        name: OSM_LOCAL_SOURCE_NAME,
        type: "osm_overpass",
        level: 2,
        url: OVERPASS_URL,
        source_owner: "OpenStreetMap",
        municipality: "Padova",
        is_active: true,
      }).select("id").maybeSingle();
      sourceId = created?.id ?? null;
    }
    const sigRows = padovaOsm.map((r) => ({
      title: r.title,
      summary: r.property_type,
      category: r.category,
      location_text: r.address_text,
      lat: r.latitude,
      lng: r.longitude,
      municipality: "Padova",
      neighborhood: r.microzone,
      commercial_zone_slug: commercialZoneForQuartiere(r.microzone),
      detected_at: fetchedAt,
      confidence: "medium",
      signal_tone: "neutral",
      commercial_use: "Punto da verificare",
      evidence_url: r.source_url,
      source_level: 2,
      is_active: true,
      use_in_report: true,
      external_ref: r.external_ref,
      source_id: sourceId,
    }));
    for (let i = 0; i < sigRows.length; i += 200) {
      const { error } = await svc.from("local_signals").upsert(sigRows.slice(i, i + 200), {
        onConflict: "external_ref",
      });
      if (error) errors.push(`local_signals:${error.message}`);
    }
  }

  // POST in batch a ingest-opportunity (limite payload ragionevole: chunk da 200)
  let normalized = 0;
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

  const ingestFailed = normalized === 0 && errors.length > 0;
  await writeSourceRegistryStatus(svc, "F5", {
    ok: !ingestFailed,
    records: normalized,
    error: ingestFailed ? errors.slice(0, 3).join(" | ").slice(0, 500) : null,
  });

  return json(200, {
    ok: true,
    records_processed: normalized,
    data: { read: all.length, normalized, records_processed: normalized, perComune, perCategory, errors: errors.slice(0, 10) },
  });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await writeSourceRegistryStatus(svc, "F5", { ok: false, records: 0, error: msg.slice(0, 500) });
    return json(500, { ok: false, records_processed: 0, error: { code: "osm_sync_failed", message: msg.slice(0, 200) } });
  }
});
