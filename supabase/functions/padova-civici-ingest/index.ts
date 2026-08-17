// padova-civici-ingest — Class A official street numbers for Padova.
// POST ?action=ingest          -> Open Data Veneto (CC BY 4.0)
// POST ?action=ingest&url=...  -> override URL (official host only)
// POST ?action=resolve_omi     -> classify omi_zone/microzona
// POST ?action=status          -> current counts
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET.
// Writes public.padova_civici (via+civico anchors for the matcher).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  constantTimeEqual,
  handleOptions,
  ok,
  fail,
  makeDebugId,
} from "../_shared/http.ts";
import {
  civicFingerprint,
  normalizeStreet,
  parseOfficialCiviciPayload,
  type Civico,
} from "../_shared/padovaCivici.ts";

const OFFICIAL_SOURCES = [
  {
    url: "https://dati.veneto.it/export/json/Numeri-Civici-del-Comune-di-Padova-2022.json",
    name: "Numeri Civici Comune di Padova",
    license: "Creative Commons Attribuzione 4.0 Internazionale (CC BY 4.0)",
    format: "veneto_flat_json" as const,
  },
];

const ALLOWED_HOSTS = new Set(["dati.veneto.it", "www.dati.veneto.it", "opendata.comune.padova.it"]);

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

function requireJobSecret(req: Request, debugId: string): Response | null {
  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!expected) return fail(req, 500, "CONFIG_ERROR", "job secret not configured", debugId);
  const incoming = req.headers.get("x-job-secret") ?? "";
  if (!incoming || !constantTimeEqual(incoming, expected)) {
    return fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-job-secret", debugId);
  }
  return null;
}

function hostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:") && ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function fetchAndParse(url: string, format: string) {
  const r = await fetch(url, { headers: { "User-Agent": "central-core-v3 padova-civici-ingest" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error(`json_parse_failed (got ${text.length} bytes)`); }
  return parseOfficialCiviciPayload(data, format);
}

async function actionIngest(supa: ReturnType<typeof svc>, urlOverride?: string) {
  const before = (await supa.from("padova_civici").select("*", { count: "exact", head: true })).count ?? 0;
  const sources = urlOverride
    ? [{ url: urlOverride, name: "override", license: "unknown", format: "auto" as const }]
    : OFFICIAL_SOURCES;
  if (urlOverride && !hostAllowed(urlOverride)) {
    return { ok: false, error: "url_host_not_allowed", records_processed: 0 };
  }
  let lastErr = "";
  let chosen: typeof sources[number] | null = null;
  let parsed: { records: Civico[]; raw_count: number } | null = null;
  for (const s of sources) {
    try {
      parsed = await fetchAndParse(s.url, s.format);
      chosen = s;
      break;
    } catch (e) {
      lastErr = `${s.url}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!chosen || !parsed) {
    return { ok: false, error: "fonte_civici_irraggiungibile", detail: lastErr, tried: sources.map((s) => s.url), records_processed: 0 };
  }

  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  let dupInBatch = 0;
  for (const c of parsed.records) {
    const norm = normalizeStreet(c.street_name);
    const fp = civicFingerprint(norm, c.civic_number, c.civic_suffix);
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

  let inserted = 0;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error, count } = await supa
      .from("padova_civici")
      .upsert(slice, { onConflict: "fingerprint", count: "exact", ignoreDuplicates: false });
    if (error) {
      return { ok: false, error: error.message, partial_inserted: inserted, source_url: chosen.url, records_processed: inserted };
    }
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
    records_processed: inserted,
    duplicates_in_batch: dupInBatch,
    table_count_before: before,
    table_count_after: after,
  };
}

async function actionResolveOmi(supa: ReturnType<typeof svc>) {
  const { error, data } = await supa.rpc("exec_resolve_padova_civici_omi" as never);
  if (!error) return { ok: true, via: "rpc", data, records_processed: 0 };
  let resolved = 0;
  let scanned = 0;
  for (let off = 0; off < 60000; off += 500) {
    const { data: pending, error: e2 } = await supa
      .from("padova_civici").select("id,lat,lng").is("omi_zone", null)
      .not("lat", "is", null).not("lng", "is", null).range(off, off + 499);
    if (e2 || !pending || pending.length === 0) break;
    scanned += pending.length;
    for (const r of pending) {
      const { data: zone } = await supa.rpc("omi_zone_by_point", { p_lat: r.lat, p_lng: r.lng });
      const z = Array.isArray(zone) && zone[0] ? zone[0] as { zona?: string; zona_descr?: string } : null;
      if (z?.zona) {
        await supa.from("padova_civici").update({ omi_zone: z.zona, microzona: z.zona_descr }).eq("id", r.id);
        resolved++;
      }
    }
  }
  return { ok: true, via: "loop", scanned, resolved, records_processed: resolved };
}

async function actionStatus(supa: ReturnType<typeof svc>) {
  const { count } = await supa.from("padova_civici").select("*", { count: "exact", head: true });
  const { count: withCoord } = await supa.from("padova_civici").select("*", { count: "exact", head: true })
    .not("lat", "is", null).not("lng", "is", null);
  const { count: withOmi } = await supa.from("padova_civici").select("*", { count: "exact", head: true })
    .not("omi_zone", "is", null);
  return {
    ok: true,
    total: count ?? 0,
    with_coordinates: withCoord ?? 0,
    with_omi_zone: withOmi ?? 0,
    records_processed: 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  const authErr = requireJobSecret(req, debugId);
  if (authErr) return authErr;
  if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  const override = url.searchParams.get("url") ?? undefined;
  const supa = svc();
  try {
    if (action === "ingest") return ok(req, await actionIngest(supa, override || undefined), [], debugId);
    if (action === "resolve_omi") return ok(req, await actionResolveOmi(supa), [], debugId);
    if (action === "status") return ok(req, await actionStatus(supa), [], debugId);
    return fail(req, 400, "UNKNOWN_ACTION", "unknown action", debugId);
  } catch (e) {
    return fail(req, 500, "INGEST_ERROR", String((e as Error).message ?? e).slice(0, 200), debugId);
  }
});
