// padova-civici-ingest
// POST ?action=ingest  -> scarica numeri civici Padova da open data ufficiale e li normalizza
// GET  ?action=status  -> conta record presenti
// Nessun mock. Se la fonte ufficiale non risponde, ritorna errore esplicito.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const DEFAULT_URLS = [
  // Endpoint configurabile via env PADOVA_CIVICI_URL. Default: WFS geoserver Comune di Padova.
  "https://geoserver.padovanet.it/geoserver/CTC/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=CTC:NUMERI_CIVICI&outputFormat=application/json&srsName=EPSG:4326",
];

const LICENSE = "CC-BY 4.0 — Comune di Padova Open Data";
const SOURCE_NAME = "comune_padova_open_data_civici";

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "X-Core-Function": "padova-civici-ingest" },
  });
}

function normalizeStreet(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha1(s: string): Promise<string> {
  const b = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-1", b);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

interface Civico {
  street_name: string;
  civic_number: string;
  civic_suffix: string | null;
  cap: string | null;
  lat: number | null;
  lng: number | null;
  source_url: string;
  raw: Record<string, unknown>;
}

function extractFromFeature(f: any, sourceUrl: string): Civico | null {
  const p = f?.properties ?? {};
  const street =
    p.VIA ?? p.via ?? p.NOMEVIA ?? p.nome_via ?? p.DENOM_VIA ?? p.denominazione ?? p.toponimo ?? p.STRADA ?? null;
  const num =
    p.CIVICO ?? p.civico ?? p.NUM_CIV ?? p.NUMERO ?? p.numero ?? p.N_CIVICO ?? null;
  if (!street || num === null || num === undefined) return null;

  const suffix = p.ESPONENTE ?? p.esponente ?? p.SUBALTERNO ?? null;
  const cap = p.CAP ?? p.cap ?? null;

  let lat: number | null = null;
  let lng: number | null = null;
  const g = f.geometry;
  if (g?.type === "Point" && Array.isArray(g.coordinates)) {
    lng = Number(g.coordinates[0]);
    lat = Number(g.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { lat = null; lng = null; }
  }

  return {
    street_name: String(street).trim(),
    civic_number: String(num).trim(),
    civic_suffix: suffix ? String(suffix).trim() : null,
    cap: cap ? String(cap).trim() : null,
    lat, lng,
    source_url: sourceUrl,
    raw: p,
  };
}

async function actionIngest(supa: ReturnType<typeof svc>, urlOverride?: string) {
  const urls = urlOverride
    ? [urlOverride]
    : [Deno.env.get("PADOVA_CIVICI_URL") || "", ...DEFAULT_URLS].filter(Boolean);

  let lastErr = "";
  let chosenUrl = "";
  let geojson: any = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "central-core-v3 padova-civici-ingest" } });
      if (!r.ok) { lastErr = `HTTP ${r.status} from ${u}`; continue; }
      geojson = await r.json();
      chosenUrl = u;
      break;
    } catch (e) {
      lastErr = `${e instanceof Error ? e.message : String(e)} from ${u}`;
    }
  }
  if (!geojson) return { ok: false, error: "fonte_civici_irraggiungibile", detail: lastErr, tried: urls };

  const features: any[] = Array.isArray(geojson.features) ? geojson.features : [];
  if (features.length === 0) return { ok: false, error: "fonte_civici_vuota", url: chosenUrl };

  const rows: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const f of features) {
    const c = extractFromFeature(f, chosenUrl);
    if (!c) { skipped++; continue; }
    const fp = await sha1(`padova|${normalizeStreet(c.street_name)}|${c.civic_number}|${c.civic_suffix ?? ""}`);
    rows.push({
      street_name: c.street_name,
      street_name_normalized: normalizeStreet(c.street_name),
      civic_number: c.civic_number,
      civic_suffix: c.civic_suffix,
      cap: c.cap,
      lat: c.lat,
      lng: c.lng,
      source_name: SOURCE_NAME,
      source_url: chosenUrl,
      license: LICENSE,
      quality: c.lat && c.lng ? "verificato" : "parziale",
      raw: c.raw,
      fingerprint: fp,
    });
  }

  // Inserimento batch
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error, count } = await supa
      .from("padova_civici")
      .upsert(slice, { onConflict: "fingerprint", count: "exact", ignoreDuplicates: false });
    if (error) return { ok: false, error: error.message, partial_inserted: inserted };
    inserted += count ?? slice.length;
  }

  // Backfill OMI zone via point-in-polygon (best-effort, solo dove lat/lng presenti e ancora vuoto)
  let omi_resolved = 0;
  try {
    const { data: pending } = await supa
      .from("padova_civici")
      .select("id,lat,lng")
      .is("omi_zone", null)
      .not("lat", "is", null)
      .not("lng", "is", null)
      .limit(2000);
    for (const r of pending ?? []) {
      const { data: zone } = await supa.rpc("omi_zone_by_point", { p_lat: r.lat, p_lng: r.lng });
      const z = Array.isArray(zone) && zone[0] ? zone[0] : null;
      if (z?.zona) {
        await supa.from("padova_civici").update({ omi_zone: z.zona, microzona: z.zona_descr }).eq("id", r.id);
        omi_resolved++;
      }
    }
  } catch (e) {
    // Non bloccare l'ingest principale
  }

  return {
    ok: true,
    source_url: chosenUrl,
    features_total: features.length,
    inserted_or_upserted: inserted,
    skipped_no_street_or_civic: skipped,
    omi_resolved,
    license: LICENSE,
  };
}

async function actionStatus(supa: ReturnType<typeof svc>) {
  const { count } = await supa.from("padova_civici").select("*", { count: "exact", head: true });
  const { count: withCoord } = await supa
    .from("padova_civici").select("*", { count: "exact", head: true })
    .not("lat", "is", null).not("lng", "is", null);
  const { count: withOmi } = await supa
    .from("padova_civici").select("*", { count: "exact", head: true })
    .not("omi_zone", "is", null);
  return { ok: true, total: count ?? 0, with_coordinates: withCoord ?? 0, with_omi_zone: withOmi ?? 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  const override = url.searchParams.get("url") ?? undefined;
  const supa = svc();
  try {
    if (action === "ingest") return ok(await actionIngest(supa, override || undefined));
    if (action === "status") return ok(await actionStatus(supa));
    return ok({ error: "unknown action" }, 400);
  } catch (e) {
    return ok({ error: String((e as Error).message ?? e) }, 500);
  }
});
