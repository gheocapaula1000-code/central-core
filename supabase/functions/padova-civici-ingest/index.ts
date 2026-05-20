// padova-civici-ingest
// POST ?action=ingest          -> ingestione reale civici Padova da dati.veneto.it (CC BY 4.0)
// POST ?action=ingest&url=...  -> override URL (deve essere fonte ufficiale)
// POST ?action=resolve_omi     -> classifica omi_zone/microzona via point-in-polygon (in batch)
// GET  ?action=status          -> stato corrente

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

// Fonte ufficiale verificata (Open Data Veneto, Comune di Padova, CC BY 4.0)
const OFFICIAL_SOURCES = [
  {
    url: "https://dati.veneto.it/export/json/Numeri-Civici-del-Comune-di-Padova-2022.json",
    name: "Numeri Civici Comune di Padova",
    license: "Creative Commons Attribuzione 4.0 Internazionale (CC BY 4.0)",
    format: "veneto_flat_json" as const,
  },
];

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
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

function cleanIntLike(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  // Esempi: "1.00000000" -> "1", "12A" -> "12A"
  const m = s.match(/^(-?\d+)\.0+$/);
  return m ? m[1] : s;
}

function cleanFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

interface Civico {
  street_name: string;
  civic_number: string;
  civic_suffix: string | null;
  cap: string | null;
  lat: number | null;
  lng: number | null;
  raw: Record<string, unknown>;
}

function parseVenetoFlat(records: any[]): Civico[] {
  const out: Civico[] = [];
  for (const r of records) {
    const street = String(r["Nome Via"] ?? r.NOME_VIA ?? "").trim();
    const civic = cleanIntLike(r["Civico"] ?? r.CIVICO);
    if (!street || !civic) continue;
    const esp = cleanIntLike(r["Esponente"] ?? r.ESPONENTE);
    const suffix = esp && esp !== "-" ? esp : null;
    const lat = cleanFloat(r["Latitudine"] ?? r.LAT);
    const lng = cleanFloat(r["Longitudine"] ?? r.LNG);
    out.push({
      street_name: street,
      civic_number: civic,
      civic_suffix: suffix,
      cap: null, // dataset Padova non espone CAP
      lat, lng,
      raw: { codice_via: cleanIntLike(r["Codice Via"]) },
    });
  }
  return out;
}

function parseGeoJSON(geojson: any): Civico[] {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out: Civico[] = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const street = String(p.VIA ?? p.NOMEVIA ?? p["Nome Via"] ?? "").trim();
    const civic = cleanIntLike(p.CIVICO ?? p.NUMERO ?? p["Civico"]);
    if (!street || !civic) continue;
    let lat: number | null = null, lng: number | null = null;
    if (f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates)) {
      lng = cleanFloat(f.geometry.coordinates[0]);
      lat = cleanFloat(f.geometry.coordinates[1]);
    }
    out.push({
      street_name: street,
      civic_number: civic,
      civic_suffix: cleanIntLike(p.ESPONENTE ?? p["Esponente"]) || null,
      cap: p.CAP ? String(p.CAP).trim() : null,
      lat, lng,
      raw: p,
    });
  }
  return out;
}

async function fetchAndParse(url: string, format: string) {
  const r = await fetch(url, { headers: { "User-Agent": "central-core-v3 padova-civici-ingest" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); }
  catch { throw new Error(`json_parse_failed (got ${text.length} bytes, first: ${text.slice(0, 80)})`); }
  if (format === "veneto_flat_json" && Array.isArray(data)) return { records: parseVenetoFlat(data), raw_count: data.length };
  if (Array.isArray(data?.features)) return { records: parseGeoJSON(data), raw_count: data.features.length };
  if (Array.isArray(data)) return { records: parseVenetoFlat(data), raw_count: data.length };
  throw new Error("unknown_payload_shape");
}

async function actionIngest(supa: ReturnType<typeof svc>, urlOverride?: string) {
  const before = (await supa.from("padova_civici").select("*", { count: "exact", head: true })).count ?? 0;
  const sources = urlOverride
    ? [{ url: urlOverride, name: "override", license: "unknown", format: "auto" as const }]
    : OFFICIAL_SOURCES;
  let lastErr = "";
  let chosen: typeof OFFICIAL_SOURCES[number] | null = null;
  let parsed: { records: Civico[]; raw_count: number } | null = null;
  for (const s of sources) {
    try {
      parsed = await fetchAndParse(s.url, s.format);
      chosen = s as any;
      break;
    } catch (e) {
      lastErr = `${s.url}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!chosen || !parsed) return { ok: false, error: "fonte_civici_irraggiungibile", detail: lastErr, tried: sources.map((s) => s.url) };

  // Build rows + dedup by fingerprint
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  let skipped = 0, dupInBatch = 0;
  for (const c of parsed.records) {
    const norm = normalizeStreet(c.street_name);
    const fp = `padova|${norm}|${c.civic_number}|${c.civic_suffix ?? ""}`;
    if (seen.has(fp)) { dupInBatch++; continue; }
    seen.add(fp);
    rows.push({
      street_name: c.street_name,
      street_name_normalized: norm,
      civic_number: c.civic_number,
      civic_suffix: c.civic_suffix,
      cap: c.cap,
      lat: c.lat,
      lng: c.lng,
      source_name: chosen.name,
      source_url: chosen.url,
      license: chosen.license,
      quality: c.lat && c.lng ? "reale" : "parziale",
      raw: c.raw,
      fingerprint: fp,
    });
  }
  if (parsed.records.length === 0) skipped = parsed.raw_count;

  // Bulk upsert
  let inserted = 0;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error, count } = await supa
      .from("padova_civici")
      .upsert(slice, { onConflict: "fingerprint", count: "exact", ignoreDuplicates: false });
    if (error) return { ok: false, error: error.message, partial_inserted: inserted, source_url: chosen.url };
    inserted += count ?? slice.length;
  }

  const after = (await supa.from("padova_civici").select("*", { count: "exact", head: true })).count ?? 0;

  return {
    ok: true,
    source_url: chosen.url,
    source_name: chosen.name,
    license: chosen.license,
    records_read: parsed.raw_count,
    records_valid: rows.length,
    records_upserted: inserted,
    duplicates_in_batch: dupInBatch,
    records_skipped: skipped,
    skip_reasons: parsed.raw_count > 0 && rows.length < parsed.raw_count
      ? ["missing_street_or_civic_or_duplicate"] : [],
    table_count_before: before,
    table_count_after: after,
  };
}

async function actionResolveOmi(supa: ReturnType<typeof svc>) {
  // Risolvi via SQL set-based per evitare 56k roundtrip
  const { error, data } = await supa.rpc("exec_resolve_padova_civici_omi" as any).select();
  if (!error) return { ok: true, via: "rpc", data };
  // Fallback: loop in pagine
  let resolved = 0, scanned = 0;
  for (let off = 0; off < 60000; off += 500) {
    const { data: pending, error: e2 } = await supa
      .from("padova_civici").select("id,lat,lng").is("omi_zone", null)
      .not("lat", "is", null).not("lng", "is", null).range(off, off + 499);
    if (e2 || !pending || pending.length === 0) break;
    scanned += pending.length;
    for (const r of pending) {
      const { data: zone } = await supa.rpc("omi_zone_by_point", { p_lat: r.lat, p_lng: r.lng });
      const z = Array.isArray(zone) && zone[0] ? zone[0] : null;
      if (z?.zona) {
        await supa.from("padova_civici").update({ omi_zone: z.zona, microzona: z.zona_descr }).eq("id", r.id);
        resolved++;
      }
    }
  }
  return { ok: true, via: "loop", scanned, resolved };
}

async function actionStatus(supa: ReturnType<typeof svc>) {
  const { count } = await supa.from("padova_civici").select("*", { count: "exact", head: true });
  const { count: withCoord } = await supa.from("padova_civici").select("*", { count: "exact", head: true })
    .not("lat", "is", null).not("lng", "is", null);
  const { count: withOmi } = await supa.from("padova_civici").select("*", { count: "exact", head: true })
    .not("omi_zone", "is", null);
  const { data: sample } = await supa.from("padova_civici")
    .select("street_name,civic_number,lat,lng,source_url,license,omi_zone,microzona").limit(5);
  return { ok: true, total: count ?? 0, with_coordinates: withCoord ?? 0, with_omi_zone: withOmi ?? 0, sample };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  const override = url.searchParams.get("url") ?? undefined;
  const supa = svc();
  try {
    if (action === "ingest") return ok(await actionIngest(supa, override || undefined));
    if (action === "resolve_omi") return ok(await actionResolveOmi(supa));
    if (action === "status") return ok(await actionStatus(supa));
    return ok({ error: "unknown action" }, 400);
  } catch (e) {
    return ok({ error: String((e as Error).message ?? e) }, 500);
  }
});
