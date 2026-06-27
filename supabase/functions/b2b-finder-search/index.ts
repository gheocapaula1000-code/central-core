// b2b-finder-search — Step 4: dry_run=true OR controlled save when dry_run=false.
// Overpass-only. Service role for DB writes. No AI, no Firecrawl, no Perplexity.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, handlePreflight, pickOrigin } from "../_shared/b2b/cors.ts";
import { authorizeB2BFinder } from "../_shared/b2b/auth.ts";
import { queryOverpass } from "../_shared/b2b/overpass.ts";
import { scoreAndNormalize, type NormalizedCompany } from "../_shared/b2b/normalize.ts";
import { resolveSearchScope, isPoiInScope, PD_COMUNI, PD_COMUNI_KEYS, bboxCenter, haversineKm, normalizeComune } from "../_shared/b2b/geo.ts";
import { detectProductKey, getProductProfile } from "../_shared/b2b/products.ts";


interface SearchInput {
  mode?: string;
  /** "clients" | "cerco_clienti" | "resellers" | "cerco_rivenditori" */
  search_mode?: string;
  intent?: string;
  product?: string;
  target_description?: string;
  sector?: string;
  area_text?: string;
  region?: string;
  province?: string;
  city?: string;
  limit?: number;
  search_depth?: "quick" | "deep";
  dry_run?: boolean;
}

type SearchMode = "clients" | "resellers";

function resolveSearchMode(input: SearchInput): SearchMode | "suppliers_rejected" {
  const raw = String(input.search_mode ?? input.intent ?? "").toLowerCase().trim();
  if (!raw) return "clients";
  if (raw === "resellers" || raw === "cerco_rivenditori" || raw === "rivenditori") return "resellers";
  if (raw === "suppliers" || raw === "cerco_fornitori" || raw === "fornitori" || raw === "produttori" || raw === "cerco_produttori") return "suppliers_rejected";
  return "clients";
}


const SAVE_MAX_LIMIT = 50;

function newDebugId(): string {
  return "b2bf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function envelope(
  ok: boolean,
  data: unknown,
  error: string | null,
  debug_id: string,
  warnings: string[] = [],
) {
  return { ok, data, warnings, debug_id, error };
}

function jsonResponse(
  req: Request,
  status: number,
  body: ReturnType<typeof envelope>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "X-Function": "b2b-finder-search",
      "X-Contract": "b2b-finder/v0.7",
    },
  });
}

function normalizeForHash(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeIdentityHash(c: NormalizedCompany, scopeKey: string, searchMode: SearchMode, productKey: string): Promise<string> {
  const name = normalizeForHash(c.name);
  const addr = normalizeForHash(c.address);
  const comune = normalizeForHash(c.city);
  const prov = normalizeForHash(c.province);
  const scope = normalizeForHash(scopeKey);
  let key: string;
  if (addr.length >= 4) {
    key = `v4|${name}|${addr}|${comune}|${prov}|scope:${scope}|sm:${searchMode}|pk:${productKey}`;
  } else {
    const lat = c.lat != null ? c.lat.toFixed(4) : "na";
    const lng = c.lng != null ? c.lng.toFixed(4) : "na";
    key = `v4|${name}|geo:${lat},${lng}|${comune}|${prov}|scope:${scope}|sm:${searchMode}|pk:${productKey}`;
  }
  return await sha256Hex(key);
}

Deno.serve(async (req: Request) => {
  const debug_id = newDebugId();
  try {
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    if (req.headers.get("origin") && !pickOrigin(req)) {
      return jsonResponse(req, 403, envelope(false, null, "Forbidden origin", debug_id));
    }

    if (req.method !== "POST") {
      return jsonResponse(req, 405, envelope(false, null, "Method not allowed", debug_id));
    }

    const auth = authorizeB2BFinder(req);
    if (!auth.ok) {
      console.warn(`[b2b-finder-search] auth rejected debug_id=${debug_id} reason=${auth.reason}`);
      return jsonResponse(req, 401, envelope(false, null, "Unauthorized", debug_id));
    }

    let input: SearchInput;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return jsonResponse(req, 400, envelope(false, null, "Content-Type must be application/json", debug_id));
      }
      input = await req.json();
    } catch {
      return jsonResponse(req, 400, envelope(false, null, "Invalid JSON body", debug_id));
    }

    const warnings: string[] = [];
    const mode = input.mode ?? "buyers";
    if (mode !== "buyers") {
      return jsonResponse(req, 400, envelope(false, null, "v1 supports only mode='buyers'", debug_id));
    }
    const searchModeRaw = resolveSearchMode(input);
    if (searchModeRaw === "suppliers_rejected") {
      return jsonResponse(
        req,
        400,
        envelope(false, null, "search_mode='suppliers' non disponibile: modalità rimossa (rollback v0.7). Usa 'clients' o 'resellers'.", debug_id),
      );
    }
    const searchMode: SearchMode = searchModeRaw;


    // dry_run must be explicit boolean
    const isDryRun = input.dry_run !== false; // default true; only explicit false triggers save
    const isSave = input.dry_run === false;

    const province = (input.province ?? "PD").toUpperCase();
    const cityInputRaw = (input.city ?? "Padova").toString().trim();
    const cityKey = cityInputRaw
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/['`]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // clients/resellers: vincolati a province=PD e comuni PD noti
    if (province !== "PD") {
      return jsonResponse(req, 400, envelope(false, null, "v1 supports only province='PD'", debug_id));
    }
    if (!PD_COMUNI[cityKey]) {
      return jsonResponse(
        req,
        400,
        envelope(
          false,
          null,
          `Comune non supportato in v1. Supportati: ${PD_COMUNI_KEYS.map((k) => PD_COMUNI[k].label).join(", ")}`,
          debug_id,
        ),
      );
    }
    const region = input.region ?? "Veneto";
    const scope = resolveSearchScope({
      city: cityInputRaw,
      province,
      region,
      zone: input.area_text ?? null,
    });
    const city = scope.comune;





    const envMax = Math.max(
      1,
      parseInt(Deno.env.get("B2B_FINDER_MAX_RESULTS_PER_JOB") ?? "100", 10) || 100,
    );
    const requested = Math.max(1, Math.floor(input.limit ?? 50));
    const hardCap = isSave ? Math.min(envMax, SAVE_MAX_LIMIT) : envMax;
    const applied = Math.min(requested, hardCap);
    if (applied < requested) {
      warnings.push(
        isSave
          ? `limit clamped from ${requested} to ${applied} (save mode max ${SAVE_MAX_LIMIT})`
          : `limit clamped from ${requested} to ${applied}`,
      );
    }

    if (input.search_depth && input.search_depth !== "quick") {
      warnings.push(`search_depth forced to 'quick'`);
    }

    console.log(
      `[b2b-finder-search] start debug_id=${debug_id} dry_run=${isDryRun} city=${city} requested=${requested} applied=${applied}`,
    );

    // ── Save-mode bootstrap: service-role client + job row ─────────────────
    let supabase: ReturnType<typeof createClient> | null = null;
    let jobId: string | null = null;

    if (isSave) {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!SUPABASE_URL || !SERVICE_KEY) {
        console.error(`[b2b-finder-search] missing env debug_id=${debug_id}`);
        return jsonResponse(req, 500, envelope(false, null, "Server misconfigured", debug_id, warnings));
      }
      supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const productProfile = getProductProfile(input.product);
      const jobInsert = {
        vertical: productProfile.vertical,
        mode: "buyers",
        product: input.product ?? productProfile.product_name,
        zone: { region, province, city, area_text: input.area_text ?? null },
        filters: {
          target_description: input.target_description ?? null,
          sector: input.sector ?? null,
          search_depth: input.search_depth ?? "quick",
          search_mode: searchMode,

          limit_requested: requested,
          applied_limit: applied,
        },
        status: "running",
        counts: {},
        debug_id,
      };
      const { data: jobRow, error: jobErr } = await supabase
        .from("b2b_search_jobs")
        .insert(jobInsert)
        .select("id")
        .single();
      if (jobErr || !jobRow) {
        console.error(`[b2b-finder-search] job insert failed debug_id=${debug_id} err=${jobErr?.message}`);
        return jsonResponse(req, 500, envelope(false, null, "Failed to create job", debug_id, warnings));
      }
      jobId = jobRow.id as string;
    }

    // Helper to fail the job (only in save mode) and return error envelope.
    const failJob = async (status: number, msg: string, extraWarn?: string) => {
      const ws = extraWarn ? [...warnings, extraWarn] : warnings;
      if (supabase && jobId) {
        await supabase
          .from("b2b_search_jobs")
          .update({ status: "failed", error_message: msg, finished_at: new Date().toISOString() })
          .eq("id", jobId);
      }
      return jsonResponse(req, status, envelope(false, jobId ? { job_id: jobId } : null, msg, debug_id, ws));
    };

    // ── Overpass ──────────────────────────────────────────────────────────
    console.log(
      `[b2b-finder-search] scope debug_id=${debug_id} comune=${scope.comune} bbox=${JSON.stringify(scope.bbox)} search_mode=${searchMode} geocode="${scope.geocode_query}"`,
    );
    let pois;
    try {
      pois = await queryOverpass(scope.bbox, 25000, searchMode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "overpass error";
      console.error(`[b2b-finder-search] overpass failed debug_id=${debug_id} err=${msg}`);
      return await failJob(502, "Overpass temporaneamente non disponibile", `overpass_cause=${msg}`);
    }

    const rawCount = pois.length;
    let filteredOutOfZone = 0;
    const inScope = pois.filter((p) => {
      const v = isPoiInScope(p, scope);
      if (!v.ok) filteredOutOfZone++;
      return v.ok;
    });

    let normalized: NormalizedCompany[];
    try {
      normalized = inScope
        .map((p) => scoreAndNormalize(p, { city, province, region, search_mode: searchMode }))
        .filter((x): x is NormalizedCompany => !!x)
        // Defensive: forziamo il comune al canonical scope.comune.
        .map((x) =>
          normalizeComune(x.city) === normalizeComune(scope.comune)
            ? { ...x, city: scope.comune }
            : x
        )
        .sort((a, b) => b.score - a.score);

    } catch (e) {
      const msg = e instanceof Error ? e.message : "normalize error";
      console.error(`[b2b-finder-search] normalize failed debug_id=${debug_id} err=${msg}`);
      return await failJob(500, "Normalization failed");
    }

    const total = normalized.length;
    const results = normalized.slice(0, applied);

    if (total === 0) {
      warnings.push("no_results_for_city");
    }
    console.log(
      `[b2b-finder-search] overpass ok debug_id=${debug_id} raw=${rawCount} out_of_zone=${filteredOutOfZone} normalized=${total}`,
    );

    // ── Diagnostica geografica per item ─────────────────────────────────
    const requestedCity = cityInputRaw;
    const resolvedScopeKey = cityKey; // chiave canonica normalizzata
    const center = bboxCenter(scope.bbox);
    const decorate = <T extends NormalizedCompany>(r: T) => {
      const resultCity = r.city ?? scope.comune;
      const sameComune =
        normalizeComune(resultCity) === normalizeComune(scope.comune);
      const inBbox =
        r.lat != null && r.lng != null
          ? r.lat >= scope.bbox[0] &&
            r.lat <= scope.bbox[2] &&
            r.lng >= scope.bbox[1] &&
            r.lng <= scope.bbox[3]
          : null;
      const distance_km =
        r.lat != null && r.lng != null
          ? Number(haversineKm(center, { lat: r.lat, lng: r.lng }).toFixed(3))
          : null;
      let geo_match_reason = "scope_fallback";
      if (sameComune && inBbox === true) geo_match_reason = "city_and_bbox_match";
      else if (sameComune) geo_match_reason = "city_match_no_coords";
      else if (inBbox === true) geo_match_reason = "bbox_match_only";
      else if (inBbox === false) geo_match_reason = "out_of_bbox";
      const in_scope = sameComune && inBbox !== false;
      const base: Record<string, unknown> = {
        ...r,
        requested_city: requestedCity,
        resolved_scope_key: resolvedScopeKey,
        result_city: resultCity,
        in_scope,
        geo_match_reason,
        distance_from_scope_center_km: distance_km,
      };

      return base as T & Record<string, unknown>;
    };
    const decoratedResults = results.map(decorate);
    const matchedRequested = decoratedResults.filter((r) => r.in_scope).length;

    // ── dry-run path: unchanged contract ──────────────────────────────────
    if (!isSave) {
      console.log(`[b2b-finder-search] dry_run ok debug_id=${debug_id} total=${total} sample=${results.length}`);
      return jsonResponse(
        req,
        200,
        envelope(
          true,
          {
            dry_run: true,
            provider: "overpass",
            search_mode: searchMode,
            city,
            province,
            requested_city: requestedCity,
            resolved_scope_key: resolvedScopeKey,
            requested_limit: requested,
            applied_limit: applied,
            total_found: total,
            sample_count: results.length,
            raw_count: rawCount,
            filtered_out_of_zone_count: filteredOutOfZone,
            in_scope_count: matchedRequested,
            geographic_scope: scope.geographic_scope,
            resolved_quarter: scope.quarter,
            geocode_query: scope.geocode_query,
            results: decoratedResults,
          },
          null,
          debug_id,
          warnings,
        ),
      );
    }


    // ── SAVE path ─────────────────────────────────────────────────────────
    let savedCount = 0;
    let high = 0, medium = 0, low = 0;
    const savedResults: Array<NormalizedCompany & { company_id: string }> = [];

    try {
      const productKey = detectProductKey(input.product);
      for (const r of results) {
        const identity_hash = await computeIdentityHash(r, resolvedScopeKey, searchMode, productKey);
        const confidence = Math.max(0, Math.min(1, r.score / 100));

        // Try to find existing
        const { data: existingRows, error: selErr } = await supabase!
          .from("b2b_companies")
          .select("id,status,source_count,notes,priority,score,fit_reason,metadata")
          .eq("identity_hash", identity_hash)
          .limit(1);
        if (selErr) throw new Error(`select company: ${selErr.message}`);

        let companyId: string;
        const existing = existingRows && existingRows.length ? existingRows[0] : null;

        if (!existing) {
          const ins = {
            identity_hash,
            name: r.name,
            category: r.category,
            address: r.address,
            comune: r.city,
            provincia: r.province,
            regione: r.region,
            country: "IT",
            lat: r.lat,
            lng: r.lng,
            phone: r.phone,
            email: r.email,
            website: r.website,
            source_count: 1,
            last_seen_at: new Date().toISOString(),
            status: "new",
            priority: r.priority,
            score: r.score,
            fit_reason: r.fit_reason,
            metadata: {
              source_ref: r.source_ref,
              osm_category: r.category,
              search_mode: searchMode,
              buyer_type_hint: r.buyer_type_hint,
              product_key: productKey,
              product_name: input.product ?? null,
              supplier_scope: supplierScope,
              supplier_region: supplierScope ? (supplierScope === "italy" ? "Italia" : "Veneto") : null,
            },
          };
          const { data: newRow, error: insErr } = await supabase!
            .from("b2b_companies")
            .insert(ins)
            .select("id")
            .single();
          if (insErr || !newRow) throw new Error(`insert company: ${insErr?.message}`);
          companyId = newRow.id as string;
        } else {
          companyId = existing.id as string;
          // Only patch contact fields that are currently missing on existing row.
          const existingMeta = ((existing.metadata ?? {}) as Record<string, unknown>);
          const mergedMeta = { ...existingMeta, search_mode: existingMeta.search_mode ?? searchMode, buyer_type_hint: existingMeta.buyer_type_hint ?? r.buyer_type_hint, product_key: existingMeta.product_key ?? productKey, product_name: existingMeta.product_name ?? (input.product ?? null) };
          const prevSourceCount = Number(existing.source_count ?? 0);
          const patch: Record<string, unknown> = {
            last_seen_at: new Date().toISOString(),
            source_count: prevSourceCount + 1,
            priority: r.priority,
            score: r.score,
            fit_reason: r.fit_reason,
            metadata: mergedMeta,
          };
          // Preserve status, notes — never overwrite.
          // Fill contacts only if missing — fetch full row contact fields
          const { data: cur } = await supabase!
            .from("b2b_companies")
            .select("phone,email,website,address,lat,lng")
            .eq("id", companyId)
            .single();
          if (cur) {
            if (!cur.phone && r.phone) patch.phone = r.phone;
            if (!cur.email && r.email) patch.email = r.email;
            if (!cur.website && r.website) patch.website = r.website;
            if (!cur.address && r.address) patch.address = r.address;
            if (cur.lat == null && r.lat != null) patch.lat = r.lat;
            if (cur.lng == null && r.lng != null) patch.lng = r.lng;
          }
          const { error: updErr } = await supabase!
            .from("b2b_companies")
            .update(patch)
            .eq("id", companyId);
          if (updErr) throw new Error(`update company: ${updErr.message}`);
        }

        const { error: srcErr } = await supabase!.from("b2b_company_sources").insert({
          company_id: companyId,
          job_id: jobId,
          source: "overpass",
          source_ref: r.source_ref,
          source_url: null,
          source_title: r.name,
          payload: {
            name: r.name,
            category: r.category,
            address: r.address,
            city: r.city,
            province: r.province,
            phone: r.phone,
            email: r.email,
            website: r.website,
            lat: r.lat,
            lng: r.lng,
            priority: r.priority,
            score: r.score,
          },
          extracted_summary: r.fit_reason,
          confidence,
        });
        if (srcErr) throw new Error(`insert source: ${srcErr.message}`);

        savedCount++;
        if (r.priority === "high") high++;
        else if (r.priority === "medium") medium++;
        else low++;
        savedResults.push({ ...r, company_id: companyId });
      }

      // Ledger
      const { error: ledErr } = await supabase!.from("b2b_usage_ledger").insert({
        provider: "overpass",
        action: "search",
        units: results.length,
        cost_eur: 0,
        job_id: jobId,
        metadata: { city, province, limit_requested: requested, applied_limit: applied, search_mode: searchMode },
      });
      if (ledErr) {
        warnings.push(`ledger_insert_failed:${ledErr.message}`);
      }

      // Finalize job
      const counts = {
        total_found: total,
        sample_count: results.length,
        saved_count: savedCount,
        high_priority: high,
        medium_priority: medium,
        low_priority: low,
      };
      await supabase!
        .from("b2b_search_jobs")
        .update({ status: "done", counts, finished_at: new Date().toISOString() })
        .eq("id", jobId!);

      console.log(`[b2b-finder-search] save ok debug_id=${debug_id} job=${jobId} saved=${savedCount}`);

      return jsonResponse(
        req,
        200,
        envelope(
          true,
          {
            dry_run: false,
            provider: "overpass",
            search_mode: searchMode,
            job_id: jobId,
            city,
            province,
            requested_city: requestedCity,
            resolved_scope_key: resolvedScopeKey,
            requested_limit: requested,
            applied_limit: applied,
            total_found: total,
            sample_count: results.length,
            saved_count: savedCount,
            in_scope_count: matchedRequested,
            results: savedResults.map((r) => ({ ...decorate(r), company_id: r.company_id })),
          },
          null,
          debug_id,
          warnings,
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "save error";
      console.error(`[b2b-finder-search] save failed debug_id=${debug_id} err=${msg}`);
      return await failJob(500, "Save failed", `save_cause=${msg}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    console.error(`[b2b-finder-search] unhandled debug_id=${debug_id} err=${msg}`);
    try {
      return jsonResponse(req, 500, envelope(false, null, "Internal error", debug_id));
    } catch {
      return new Response(
        JSON.stringify({ ok: false, data: null, warnings: [], debug_id, error: "Internal error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }
});
