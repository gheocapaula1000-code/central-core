// padova-apify-immobiliare-collect
// Pipeline a 2 actor per immobiliare.it:
//   Pass A (discovery): azzouzana/immobiliare-it-listing-page-scraper-by-search-url
//     - accetta un search URL per run → item list-view (URL scheda, prezzo, agency, foto…)
//     - NON contiene priceHistory/discount (solo il dettaglio li espone)
//   Pass B (enrichment): memo23/immobiliare-scraper (detail-by-URL)
//     - arricchisce solo gli URL NEW (mai visti in padova_collect_v2_items) + eventuali refresh_urls
//     - estrae previous_price_eur / ribasso_pct da raw.price.startPrice / raw.price.discount
//     - ribasso_date sempre null (immobiliare non espone dropDate lato actor)
//
// Modes:
//   - "discovery": solo Pass A (poi Pass B sui NEW)
//   - "refresh":   solo Pass B su refresh_urls[] (o start_urls[] legacy)
//   - "mixed":     Pass A da search_urls[] + Pass B su NEW ∪ refresh_urls[]
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken, startApifyRun, writeImmobiliareSourceRegistry } from "../_shared/apify.ts";
import {
  ACTOR_IMMO_DETAIL,
  ACTOR_IMMO_LISTVIEW,
  IMMOBILIARE_PADOVA_SEARCH_URLS,
} from "../_shared/apifyLaunch.ts";
import { isJobSecretAuthorized, jobAuthFailure, jobAuthHeaders } from "../_shared/jobAuth.ts";

const APIFY = "https://api.apify.com/v2";
const ACTOR_DETAIL = ACTOR_IMMO_DETAIL;
const ACTOR_DISCOVER = ACTOR_IMMO_LISTVIEW;

// Costi indicativi Apify pay-per-result (aggiornabili)
const COST_PER_DETAIL_USD = 0.005;
const COST_PER_LISTVIEW_USD = 0.002;

type Mode = "discovery" | "refresh" | "mixed";

interface Body {
  mode?: Mode;
  search_urls?: string[];     // Pass A input (mode discovery/mixed)
  refresh_urls?: string[];    // Pass B input (mode refresh/mixed)
  start_urls?: string[];      // legacy alias di refresh_urls
  desired_results?: number;   // hint azzouzana per search URL
  max_items?: number;         // cap per pass
  max_urls_from_db?: number;  // fallback refresh: URL già in staging
  wait_seconds?: number;
  dry_run?: boolean;
  async_start?: boolean;      // se true: avvia i run e ritorna; collect-pending completa
}


async function startRun(actor: string, input: Record<string, unknown>, token: string) {
  const r = await fetch(
    `${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}&waitForFinish=0`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`apify_start_${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { run_id: j.data.id as string, dataset_id: j.data.defaultDatasetId as string };
}

async function pollRun(runId: string, token: string, timeoutSec: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutSec * 1000) {
    const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const status = j?.data?.status;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) return { status, run: j.data };
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { status: "TIMEOUT_LOCAL", run: null };
}

async function fetchDataset(datasetId: string, token: string, limit: number) {
  const r = await fetch(
    `${APIFY}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=1&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`apify_dataset_${r.status}`);
  return (await r.json()) as any[];
}

function canonUrl(u: string): string {
  if (!u) return "";
  return u.replace(/\?.*$/, "").replace(/\/$/, "").replace(/^http:/, "https:");
}
function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function toFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// -------- mapping detail (memo23) --------
function mapDetail(raw: any, jobId: string, nowIso: string) {
  const e = raw?._enhanced ?? {};
  const g = raw?.geography ?? {};
  const p = raw?.price ?? {};
  const t = raw?.topology ?? {};
  const a = raw?.analytics ?? {};
  const url = canonUrl(raw?.shareUrl ?? e.sourceUrl ?? e.listingUrl ?? "");
  if (!url) return null;
  const lat = toFloat(e.latitude ?? g?.geolocation?.latitude);
  const lng = toFloat(e.longitude ?? g?.geolocation?.longitude);
  const priceRaw = toInt(p.raw ?? e.priceAmount);
  const previousPrice = toInt(p.startPrice);
  const ribassoPct = toFloat(p.discount);
  const ribassoEur = (previousPrice != null && priceRaw != null && previousPrice > priceRaw)
    ? (previousPrice - priceRaw)
    : null;
  const agency = ((e.agencyName ?? "") + "").trim() || null;
  const phones: string[] = Array.isArray(e.contactPhones) ? e.contactPhones : [];
  const listingId = String(raw?.realEstateAdId ?? raw?.id ?? url.match(/annunci\/(\d+)/)?.[1] ?? "");
  const roomsFallback = toInt(String(t?.rooms ?? "").match(/\d+/)?.[0]);
  const surfaceFallback = toInt(t?.surface?.size);

  return {
    job_id: jobId,
    portal: "immobiliare",
    listing_id: listingId || null,
    url,
    raw_address: e.address ?? g.street ?? null,
    citta: "Padova",
    cap: e.zipcode ?? g.zipcode ?? null,
    lat, lng,
    omi_zone: null,
    quartiere: g?.microzone?.name ?? e.microzone ?? a?.microzone ?? null,
    tipo_lead: agency ? "AGENZIA" : "PRIVATO",
    n_agenzie: agency ? 1 : 0,
    prezzo: priceRaw,
    prezzo_iniziale: previousPrice ?? priceRaw,
    previous_price_eur: previousPrice,
    ribasso_pct: ribassoPct,
    ribasso_eur: ribassoEur,
    ribasso_date: null, // memo23 non espone dropDate
    mq: toInt(e.surfaceSqm ?? e.commercialSurfaceSqm) ?? surfaceFallback,
    locali: toInt(e.rooms) ?? roomsFallback,
    bagni: toInt(e.bathrooms) ?? toInt(t?.bathrooms),
    agency,
    agency_phone: phones[0] ?? null,
    tipologia: e.propertyType ?? t?.typology?.name ?? null,
    piano: e.floor ?? t?.floor ?? null,
    stato: e.condition ?? a?.propertyStatus ?? null,
    anno_costruzione: toInt(e.yearBuilt),
    cluster_key: null,
    parse_status: "apify_immobiliare_detail",
    processed_at: nowIso,
    http_status: 200,
    log_reason: null,
    attempts: 0,
    raw_json: raw,
    updated_at: nowIso,
  };
}

// -------- mapping listview (azzouzana) --------
// Utilizzato SOLO se non ci sono NEW da arricchire (per non perdere gli item).
// Nella pipeline standard, tutti i NEW passano per Pass B che sovrascrive con detail.
function mapListview(raw: any, jobId: string, nowIso: string) {
  // Shape reale azzouzana (list-real-estate):
  //   directLink, id, title, price.value, typology.name,
  //   advertiser.agency.{displayName, phones[0].value},
  //   properties[0].{location.{latitude,longitude,address,microzone,city},
  //                  surface, rooms, bathrooms, floor.value, ga4Condition, typology.name}
  const url = canonUrl(raw?.directLink ?? (raw?.id ? `https://www.immobiliare.it/annunci/${raw.id}` : ""));
  if (!url) return null;
  const priceRaw = toInt(raw?.price?.value);
  const agencyObj = raw?.advertiser?.agency ?? {};
  const agency = ((agencyObj?.displayName ?? "") + "").trim() || null;
  const phone = agencyObj?.phones?.[0]?.value
    ?? raw?.advertiser?.supervisor?.phones?.[0]?.value
    ?? null;
  const listingId = String(raw?.id ?? url.match(/annunci\/(\d+)/)?.[1] ?? "");
  const p0 = (Array.isArray(raw?.properties) ? raw.properties.find((x: any) => x?.isMain) ?? raw.properties[0] : null) ?? {};
  const loc = p0?.location ?? {};
  const mq = toInt(String(p0?.surface ?? "").match(/\d+/)?.[0]);
  const locali = toInt(String(p0?.rooms ?? "").match(/\d+/)?.[0]);
  const bagni = toInt(String(p0?.bathrooms ?? "").match(/\d+/)?.[0]);

  return {
    job_id: jobId,
    portal: "immobiliare",
    listing_id: listingId || null,
    url,
    raw_address: loc?.address ?? null,
    citta: loc?.city ?? "Padova",
    cap: null, // list-view non espone cap
    lat: toFloat(loc?.latitude),
    lng: toFloat(loc?.longitude),
    omi_zone: null,
    quartiere: loc?.microzone ?? loc?.macrozone ?? null,
    tipo_lead: agency ? "AGENZIA" : "PRIVATO",
    n_agenzie: agency ? 1 : 0,
    prezzo: priceRaw,
    prezzo_iniziale: priceRaw,
    previous_price_eur: null,
    ribasso_pct: null,
    ribasso_eur: null,
    ribasso_date: null,
    mq,
    locali,
    bagni,
    agency,
    agency_phone: phone,
    tipologia: p0?.typology?.name ?? raw?.typology?.name ?? null,
    piano: p0?.floor?.value ?? null,
    stato: p0?.ga4Condition ?? null,
    anno_costruzione: null,
    cluster_key: null,
    parse_status: "apify_immobiliare_listview",
    processed_at: nowIso,
    http_status: 200,
    log_reason: null,
    attempts: 0,
    raw_json: raw,
    updated_at: nowIso,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    await writeImmobiliareSourceRegistry({ ok: false, error: auth.error });
    return new Response(JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    await writeImmobiliareSourceRegistry({ ok: false, error: "APIFY_API_TOKEN_missing" });
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const mode: Mode = body.mode ?? "refresh";
  const maxItems = body.max_items ?? 100;
  const desiredResults = body.desired_results ?? 40;
  const timeoutSec = body.wait_seconds ?? 240;

  // Normalizza refresh_urls con alias legacy start_urls
  const refreshUrls = [...(body.refresh_urls ?? []), ...(body.start_urls ?? [])]
    .map(canonUrl).filter(Boolean);

  const searchUrls = (body.search_urls ?? []).filter(Boolean);
  if ((mode === "discovery" || mode === "mixed") && searchUrls.length === 0) {
    searchUrls.push(...IMMOBILIARE_PADOVA_SEARCH_URLS);
  }

  const nowIso = new Date().toISOString();
  const jobId = `apify-immo-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

  const enrichment = {
    mode,
    discovery_runs: [] as Array<{ search_url: string; run_id: string; dataset_size: number; status: string }>,
    discovered_urls: 0,
    new_urls_enriched: 0,
    refresh_urls_enriched: refreshUrls.length,
    second_pass_ran: false,
    second_pass_run_id: null as string | null,
    second_pass_status: null as string | null,
    estimated_extra_cost_usd: 0,
  };

  // ============ ASYNC START MODE ============
  // Avvia i run Apify, registra la riga RUNNING in padova_apify_runs, ritorna.
  // Il polling+ingest (Pass A) e l'auto-trigger di Pass B avvengono in
  // padova-apify-collect-pending, che gira ogni 15 minuti.
  if (body.async_start) {
    try {
      const started: Array<{
        role: string; search_url?: string; run_id: string; dataset_id: string; webhook_attached?: boolean;
      }> = [];
      const skipped: Array<{ role: string; search_url?: string; reason: string }> = [];

      if (mode === "discovery" || mode === "mixed") {
        const portal = `immobiliare_collect_${mode}_discover`;
        const launches = await Promise.all(searchUrls.map(async (surl) => {
          const res = await startApifyRun(
            ACTOR_DISCOVER,
            { startUrl: surl, maxItems: desiredResults },
            { portal, estUsd: 0.20, costCapUsd: 0.20 },
          );
          return { surl, res };
        }));
        for (const { surl, res } of launches) {
          if (!res.started) {
            console.warn(`[apify] lancio saltato: ${res.reason} portal=${portal}`);
            skipped.push({ role: "discover", search_url: surl, reason: res.reason });
            continue;
          }
          started.push({
            role: "discover", search_url: surl, run_id: res.run_id,
            dataset_id: res.dataset_id, webhook_attached: res.webhook_attached,
          });
        }
        if (skipped.some((s) => s.reason === "APIFY_DAILY_CAP_REACHED" || s.reason === "monthly_cap_reached")) {
          const cap = skipped.find((s) =>
            s.reason === "APIFY_DAILY_CAP_REACHED" || s.reason === "monthly_cap_reached");
          await writeImmobiliareSourceRegistry({
            ok: false, error: cap?.reason ?? "APIFY_DAILY_CAP_REACHED",
          });
          return new Response(JSON.stringify({
            ok: false, skipped: true, reason: cap?.reason, started, skipped_runs: skipped,
          }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if ((mode === "refresh") && refreshUrls.length > 0) {
        const capB = Math.min(refreshUrls.length, maxItems);
        const portal = `immobiliare_collect_${mode}_enrich`;
        const res = await startApifyRun(
          ACTOR_DETAIL,
          {
            startUrls: refreshUrls.slice(0, capB).map((u) => ({ url: u })),
            maxItems: capB,
            includeAgencyDetails: false,
            proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
          },
          { portal, estUsd: 0.30, costCapUsd: 0.30 },
        );
        if (!res.started) {
          console.warn(`[apify] lancio saltato: ${res.reason} portal=${portal}`);
          await writeImmobiliareSourceRegistry({ ok: false, error: res.reason });
          return new Response(JSON.stringify({ ok: false, skipped: true, reason: res.reason, started }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        started.push({
          role: "enrich_refresh", run_id: res.run_id, dataset_id: res.dataset_id,
          webhook_attached: res.webhook_attached,
        });
      }

      if (started.length === 0) {
        const reason = skipped[0]?.reason ?? "no_apify_run_started";
        await writeImmobiliareSourceRegistry({ ok: false, error: reason, records: 0 });
        return new Response(JSON.stringify({
          ok: false, error: "no_apify_run_started", reason, async_start: true, mode, skipped,
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Immediate handoff: collect-pending will no-op while Apify is still
      // RUNNING, then the attached webhook + 15-min cron finish ingest.
      const runIds = started.map((s) => s.run_id);
      const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
      if (base && jobSecret) {
        fetch(`${base}/functions/v1/padova-apify-collect-pending`, {
          method: "POST",
          headers: jobAuthHeaders(jobSecret),
          body: JSON.stringify({ run_ids: runIds, stale_minutes: 0, max_runs: runIds.length }),
        }).catch((e) => console.warn("[apify] collect-pending handoff", String(e)));
      }

      await writeImmobiliareSourceRegistry({ ok: true, records: started.length });
      return new Response(JSON.stringify({
        ok: true, async_start: true, mode, job_id: jobId, started, skipped,
        note: "run avviati in async: webhook + collect-pending completeranno ingest",
      }, null, 2), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      await writeImmobiliareSourceRegistry({ ok: false, error: msg });
      return new Response(JSON.stringify({ ok: false, error: msg, async_start: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }


  try {

    // ============ PASS A: DISCOVERY ============
    let discoveryListview: any[] = [];
    if (mode === "discovery" || mode === "mixed") {
      if (searchUrls.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "search_urls_required_for_discovery" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      for (const surl of searchUrls) {
        const { run_id, dataset_id } = await startRun(ACTOR_DISCOVER, {
          startUrl: surl,
          maxItems: desiredResults,
        }, token);
        await sb.from("padova_apify_runs").insert({
          portal: `immobiliare_collect_${mode}_discover`,
          actor_id: ACTOR_DISCOVER, run_id, dataset_id,
          status: "RUNNING", cost_cap_usd: 0.20,
        });
        const { status } = await pollRun(run_id, token, timeoutSec);
        let items: any[] = [];
        if (status === "SUCCEEDED") items = await fetchDataset(dataset_id, token, desiredResults);
        await sb.from("padova_apify_runs").update({ status }).eq("run_id", run_id);
        enrichment.discovery_runs.push({ search_url: surl, run_id, dataset_size: items.length, status });
        discoveryListview.push(...items);
        enrichment.estimated_extra_cost_usd += items.length * COST_PER_LISTVIEW_USD;
      }
      enrichment.discovered_urls = discoveryListview.length;
    }

    // Set di URL candidati per Pass B
    const discoveredUrls = Array.from(new Set(
      discoveryListview
        .map((r) => canonUrl(r?.directLink ?? (r?.id ? "https://www.immobiliare.it/annunci/" + r.id : "")))
        .filter(Boolean),
    ));

    // Filtro NEW (non ancora in padova_collect_v2_items per portal='immobiliare')
    const newUrls: string[] = [];
    if (discoveredUrls.length > 0) {
      const existing = new Set<string>();
      for (let i = 0; i < discoveredUrls.length; i += 100) {
        const { data } = await sb
          .from("padova_collect_v2_items")
          .select("url")
          .eq("portal", "immobiliare")
          .in("url", discoveredUrls.slice(i, i + 100));
        for (const r of data ?? []) if (r?.url) existing.add(r.url);
      }
      for (const u of discoveredUrls) if (!existing.has(u)) newUrls.push(u);
    }

    // ============ PASS B: ENRICH (detail-by-URL su memo23) ============
    const passBUrls = Array.from(new Set([...newUrls, ...refreshUrls]));
    let detailItems: any[] = [];
    if ((mode === "refresh" || mode === "mixed" || mode === "discovery") && passBUrls.length > 0) {
      const capB = Math.min(passBUrls.length, maxItems);
      const { run_id: rid2, dataset_id: did2 } = await startRun(ACTOR_DETAIL, {
        startUrls: passBUrls.slice(0, capB).map((u) => ({ url: u })),
        maxItems: capB,
        includeAgencyDetails: false,
        proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      }, token);
      await sb.from("padova_apify_runs").insert({
        portal: `immobiliare_collect_${mode}_enrich`,
        actor_id: ACTOR_DETAIL, run_id: rid2, dataset_id: did2,
        status: "RUNNING", cost_cap_usd: 0.30,
      });
      const { status: st2 } = await pollRun(rid2, token, timeoutSec);
      if (st2 === "SUCCEEDED") detailItems = await fetchDataset(did2, token, capB);
      await sb.from("padova_apify_runs").update({ status: st2 }).eq("run_id", rid2);

      enrichment.second_pass_ran = true;
      enrichment.second_pass_run_id = rid2;
      enrichment.second_pass_status = st2;
      enrichment.new_urls_enriched = Math.min(newUrls.length, capB);
      enrichment.estimated_extra_cost_usd += capB * COST_PER_DETAIL_USD;
    }

    // ============ MERGE / MAP ============
    const detailByUrl = new Map<string, any>();
    for (const it of detailItems) {
      const m = mapDetail(it, jobId, nowIso);
      if (m) detailByUrl.set(m.url, m);
    }
    // Per discovery URL non arricchiti in Pass B (es. sopra cap), fallback listview
    const mapped: any[] = [];
    for (const u of discoveredUrls) {
      if (detailByUrl.has(u)) mapped.push(detailByUrl.get(u));
      else {
        const raw = discoveryListview.find((r) => canonUrl(r?.directLink ?? (r?.id ? "https://www.immobiliare.it/annunci/" + r.id : "")) === u);
        const mv = raw ? mapListview(raw, jobId, nowIso) : null;
        if (mv) mapped.push(mv);
      }
    }
    // refresh_urls: solo detail (se assente in dataset, salta)
    for (const u of refreshUrls) if (detailByUrl.has(u) && !discoveredUrls.includes(u)) mapped.push(detailByUrl.get(u));

    if (mapped.length === 0) {
      await writeImmobiliareSourceRegistry({ ok: false, error: "provider_returned_no_mappable_items" });
      return new Response(JSON.stringify({ ok: false, error: "provider_returned_no_mappable_items", job_id: jobId, enrichment }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (body.dry_run) {
      return new Response(JSON.stringify({
        ok: true, dry_run: true, job_id: jobId,
        enrichment, mapped: mapped.length,
        sample: mapped.slice(0, 3),
      }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ============ UPSERT su (portal='immobiliare', url) ============
    const urls = mapped.map((r) => r.url);
    const existing = new Map<string, number>();
    for (let i = 0; i < urls.length; i += 100) {
      const { data } = await sb
        .from("padova_collect_v2_items")
        .select("id,url").eq("portal", "immobiliare").in("url", urls.slice(i, i + 100));
      for (const r of data ?? []) if (r.url) existing.set(r.url, Number(r.id));
    }
    let created = 0, updated = 0, skipped_listview_existing = 0;
    const errors: string[] = [];
    const inserts: any[] = [];
    for (const row of mapped) {
      const eid = existing.get(row.url);
      const isListview = row.parse_status === "apify_immobiliare_listview";
      if (eid) {
        // In mode=discovery, MAI sovrascrivere una riga esistente con dati listview:
        // il listview serve solo a identificare i NEW (arricchiti in Pass B come detail).
        if (isListview) { skipped_listview_existing++; continue; }
        const { error } = await sb.from("padova_collect_v2_items").update(row).eq("id", eid);
        if (error) errors.push(`upd:${error.message}`); else updated++;
      } else inserts.push(row);
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const slice = inserts.slice(i, i + 200);
      const { error } = await sb.from("padova_collect_v2_items").insert(slice);
      if (error) errors.push(`ins:${error.message}`); else created += slice.length;
    }

    const ok = errors.length === 0 && created + updated + skipped_listview_existing > 0;
    await writeImmobiliareSourceRegistry({
      ok,
      records: created + updated,
      error: ok ? undefined : (errors[0] ?? "upsert_failed"),
    });
    return new Response(JSON.stringify({
      ok, job_id: jobId,
      mapped: mapped.length, created, updated, skipped_listview_existing, errors,
      enrichment,
    }, null, 2), { status: ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await writeImmobiliareSourceRegistry({ ok: false, error: msg });
    return new Response(JSON.stringify({ ok: false, error: msg, enrichment }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
