// civiko-sue-padova-collect (F18)
// Official Comune di Padova / open-data building-permit + OSM construction.
// Empty is allowed when sources are up but return 0 Padova rows.
// Fail-closed when no official source can be read. Never invents permits.

import { createClient } from "npm:@supabase/supabase-js@2";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import { writeSourceRegistryStatus } from "../_shared/sourceRegistryStatus.ts";
import {
  CKAN_CATALOGS,
  CKAN_QUERIES,
  COLLECTOR_WALL_MS,
  FETCH_TIMEOUT_MS,
  OSM_OVERPASS_URL,
  SUE_SOURCE_PAGES,
  collectorTimedOut,
  fetchWithTimeout,
  isPadovaEdiliziaText,
  mapCsvToPermit,
  mapOsmToPermit,
  osmPadovaConstructionQuery,
  parseCsvRows,
  selectPadovaEdiliziaPackages,
  type CkanPackage,
  type OsmElement,
  type SuePermitRow,
} from "../_shared/padovaUrbanLayers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseCkanPackages(text: string): CkanPackage[] {
  try {
    const data = JSON.parse(text);
    const results = data?.result?.results;
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    return json(auth.status, { ok: false, error: auth.error });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const started = Date.now();
  const fetchedAt = new Date().toISOString();
  const permits: SuePermitRow[] = [];
  const errors: string[] = [];
  let sourcesRead = 0;

  try {
    for (const base of CKAN_CATALOGS) {
      if (collectorTimedOut(started, Date.now())) break;
      for (const q of CKAN_QUERIES) {
        if (collectorTimedOut(started, Date.now())) break;
        const url = `${base.replace(/\/$/, "")}/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=10`;
        const r = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
        if (!r.ok) {
          errors.push(`ckan:${base}:${r.error}`);
          continue;
        }
        sourcesRead++;
        const pkgs = selectPadovaEdiliziaPackages(parseCkanPackages(r.text));
        for (const ds of pkgs) {
          for (const res of ds.resources ?? []) {
            const fmt = String(res.format ?? "").toUpperCase();
            const resUrl = String(res.url ?? "");
            if (!resUrl.startsWith("https://")) continue;
            if (!/CSV|JSON|GEOJSON|TXT/.test(fmt)) continue;
            if (collectorTimedOut(started, Date.now(), COLLECTOR_WALL_MS - 10_000)) break;
            const file = await fetchWithTimeout(resUrl, FETCH_TIMEOUT_MS);
            if (!file.ok) {
              errors.push(`resource:${resUrl.slice(0, 80)}:${file.error}`);
              continue;
            }
            sourcesRead++;
            const sourceName = String(ds.title ?? ds.name ?? "ckan");
            if (fmt === "JSON" || fmt === "GEOJSON") {
              try {
                const parsed = JSON.parse(file.text);
                const arr = Array.isArray(parsed) ? parsed : (parsed?.features ?? parsed?.records ?? []);
                if (Array.isArray(arr)) {
                  for (const item of arr) {
                    const props = (item?.properties ?? item) as Record<string, unknown>;
                    const flat: Record<string, string> = {};
                    for (const [k, v] of Object.entries(props ?? {})) {
                      if (v != null && typeof v !== "object") flat[k.toLowerCase()] = String(v);
                    }
                    const mapped = mapCsvToPermit(flat, resUrl, sourceName, fetchedAt, true);
                    if (mapped) permits.push(mapped);
                  }
                }
              } catch {
                errors.push(`json_parse:${resUrl.slice(0, 80)}`);
              }
            } else {
              for (const row of parseCsvRows(file.text)) {
                const mapped = mapCsvToPermit(row, resUrl, sourceName, fetchedAt, true);
                if (mapped) permits.push(mapped);
              }
            }
          }
        }
      }
    }

    for (const page of SUE_SOURCE_PAGES) {
      if (collectorTimedOut(started, Date.now())) break;
      const r = await fetchWithTimeout(page, FETCH_TIMEOUT_MS);
      if (!r.ok) {
        errors.push(`comune:${r.error}`);
        continue;
      }
      sourcesRead++;
      if (!isPadovaEdiliziaText(r.text) && !/sue|edilizia|permesso di costruire/i.test(r.text)) {
        errors.push(`comune_page_unreadable:${page}`);
      }
      // Official SUE pages are procedural, not a permit list. Do not invent rows.
    }

    if (!collectorTimedOut(started, Date.now())) {
      const osm = await fetchWithTimeout(OSM_OVERPASS_URL, 25_000, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(osmPadovaConstructionQuery())}`,
      });
      if (!osm.ok) {
        errors.push(`osm:${osm.error}`);
      } else {
        sourcesRead++;
        try {
          const data = JSON.parse(osm.text);
          const els = Array.isArray(data?.elements) ? data.elements as OsmElement[] : [];
          for (const el of els) permits.push(mapOsmToPermit(el, fetchedAt));
        } catch {
          errors.push("osm_parse");
        }
      }
    }

    const allSourcesDown = sourcesRead === 0;
    if (allSourcesDown) {
      await writeSourceRegistryStatus(sb, "F18", {
        ok: false, records: 0, error: errors[0] ?? "official_sources_unreadable",
      });
      return json(502, {
        ok: false,
        error: "official_sources_unreadable",
        records_processed: 0,
        errors: errors.slice(0, 8),
      });
    }

    const seen = new Set<string>();
    const unique = permits.filter((p) => {
      const k = `${p.source_url}|${p.external_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    let written = 0;
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200).map((p) => ({
        area_name: p.area_name,
        address_public: p.address_public,
        practice_type: p.practice_type,
        practice_date: p.practice_date,
        status: p.status,
        source_url: p.source_url,
        source_name: p.source_name,
        external_id: p.external_id,
        commercial_zone_slug: p.commercial_zone_slug,
        fetched_at: p.fetched_at,
        imported_at: p.fetched_at,
        compliance_verified: p.compliance_verified,
        raw_ref: p.raw_ref,
      }));
      const { error } = await sb.from("sue_padova_permits").upsert(chunk, {
        onConflict: "source_url,external_id",
      });
      if (error) {
        errors.push(`upsert:${error.message}`);
        break;
      }
      written += chunk.length;
    }

    if (unique.length > 0 && written === 0) {
      await writeSourceRegistryStatus(sb, "F18", {
        ok: false, records: 0, error: errors.find((e) => e.startsWith("upsert:")) ?? "upsert_failed",
      });
      return json(502, {
        ok: false,
        error: "upsert_failed",
        records_processed: 0,
        sources_read: sourcesRead,
        errors: errors.slice(0, 8),
      });
    }

    await writeSourceRegistryStatus(sb, "F18", {
      ok: true,
      records: written,
      error: null,
    });

    return json(200, {
      ok: true,
      records_processed: written,
      sources_read: sourcesRead,
      empty: written === 0,
      duration_ms: Date.now() - started,
      errors: errors.slice(0, 8),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeSourceRegistryStatus(sb, "F18", { ok: false, records: 0, error: msg.slice(0, 500) });
    return json(500, { ok: false, error: msg.slice(0, 200), records_processed: 0 });
  }
});
