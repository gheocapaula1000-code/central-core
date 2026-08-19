// padova-apify-multi-status
// Per ciascuna run recente (idealista/casa/subito) controlla lo stato Apify,
// se SUCCEEDED scarica dataset, ABORTA se cost > cost_cap_usd, e:
//   - idealista: parse + insert in padova_idealista_staging
//   - casa/subito: insert raw_json grezzo in padova_casa_test / padova_subito_test
// Ritorna un report human-readable.
// Auth: x-job-secret / x-internal-secret / Bearer job secret.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import { STALE_LOCK_MS } from "../_shared/padovaPortalLaunch.ts";

const APIFY = "https://api.apify.com/v2";

async function getRun(runId: string, token: string) {
  try {
    const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json();
    return j?.data ?? null;
  } catch {
    return null;
  }
}

async function abortRun(runId: string, token: string) {
  await fetch(`${APIFY}/actor-runs/${runId}/abort?token=${encodeURIComponent(token)}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function fetchDataset(datasetId: string, token: string, limit = 5000): Promise<Record<string, unknown>[]> {
  try {
    const r = await fetch(
      `${APIFY}/datasets/${datasetId}/items?clean=true&limit=${limit}&token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(45_000) },
    );
    if (!r.ok) { await r.body?.cancel(); return []; }
    const j = await r.json();
    return Array.isArray(j) ? j as Record<string, unknown>[] : [];
  } catch {
    return [];
  }
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else return undefined;
  }
  return cur;
}

function parseIdealista(it: Record<string, unknown>) {
  const contact = (it.contactInfo ?? {}) as Record<string, unknown>;
  const more = (it.moreCharacteristics ?? {}) as Record<string, unknown>;
  const ubi = (it.ubication ?? {}) as Record<string, unknown>;
  const pid = it.propertyId ?? it.adid;
  const urlFinal = (it.originalUrl as string) ?? (it.detailWebLink as string) ?? (it.link as string) ?? (pid ? `https://www.idealista.it/immobile/${pid}/` : null);
  const professional = contact.professional;
  return {
    url: urlFinal,
    agency: (contact.commercialName as string) ?? null,
    tipo_lead: professional === false ? "PRIVATO" : (professional === true ? "AGENZIA" : null),
    mq: num(more.constructedArea),
    locali: num(more.roomNumber),
    bagni: num(more.bathNumber),
    prezzo: num(it.price),
    lat: typeof ubi.latitude === "number" ? ubi.latitude : (ubi.latitude != null ? Number(ubi.latitude) : null),
    lng: typeof ubi.longitude === "number" ? ubi.longitude : (ubi.longitude != null ? Number(ubi.longitude) : null),
    indirizzo: (ubi.title as string) ?? null,
    raw_json: it,
  };
}

function looksClean(s: string | null): boolean {
  if (!s) return false;
  if (s.length > 80) return false;
  if (/trova\s+agenzia|navbar|menu/i.test(s)) return false;
  if (/[\[\]\{\}#|]/.test(s)) return false;
  return /[A-Za-z]/.test(s) && s.trim().length >= 2;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || !isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    return new Response(JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Considera ultime 6h
  const { data: runs } = await sb
    .from("padova_apify_runs")
    .select("*")
    .gte("started_at", new Date(Date.now() - 6 * 3600_000).toISOString())
    .order("started_at", { ascending: false });

  const out: Record<string, unknown>[] = [];

  for (const r of (runs ?? []) as Array<Record<string, unknown>>) {
    const portal = r.portal as string;
    const runId = r.run_id as string;
    const datasetId = r.dataset_id as string | null;
    const costCap = Number(r.cost_cap_usd ?? 0);
    const dbStatus = r.status as string;

    if (runId === "ERROR") {
      out.push({ portal, status: "FAILED_TO_START", error: r.error });
      continue;
    }

    const run = await getRun(runId, token);
    if (!run) {
      const startedMs = r.started_at ? Date.parse(String(r.started_at)) : NaN;
      const stale = Number.isFinite(startedMs) && (Date.now() - startedMs) >= STALE_LOCK_MS;
      if (stale && (dbStatus === "RUNNING" || dbStatus === "READY")) {
        await sb.from("padova_apify_runs").update({
          status: "STALE_LOCK",
          error: "apify_run_unreadable_stale_lock",
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
        out.push({ portal, run_id: runId, status: "STALE_LOCK" });
        continue;
      }
      out.push({ portal, run_id: runId, status: "unknown" });
      continue;
    }
    const cost = Number(run.usageTotalUsd ?? 0);
    const status = run.status as string;

    // Aborta se sopra cap e ancora in corso
    if (cost > costCap && (status === "RUNNING" || status === "READY")) {
      await abortRun(runId, token);
      await sb.from("padova_apify_runs").update({
        status: "ABORTED_COST_CAP", cost_usd: cost, error: `cost ${cost} > cap ${costCap}`,
        finished_at: new Date().toISOString(),
      }).eq("id", r.id);
      out.push({ portal, run_id: runId, status: "ABORTED_COST_CAP", cost_usd: cost, cost_cap_usd: costCap });
      continue;
    }

    const isFinalWithData = status === "SUCCEEDED" || status === "TIMED-OUT";
    if (!isFinalWithData) {
      // Persist status + real cost anche per READY/RUNNING (mai lanciare Actor)
      await sb.from("padova_apify_runs").update({ status, cost_usd: cost }).eq("id", r.id);
      out.push({ portal, run_id: runId, status, cost_usd: cost });
      continue;
    }

    let newlyImportedSubitoFull = 0;

    const isCollectV2Run = [
      "idealista_collect", "immobiliare_collect", "immobiliare_collect_mixed_discover",
      "immobiliare_autoenrich", "immobiliare_agency_backfill", "subito_collect",
    ].some((tag) => portal.includes(tag));

    if (isCollectV2Run) {
      // Queste run sono di competenza di padova-apify-collect-pending: qui
      // persistiamo solo status/costo/dataset size, senza toccare imported né
      // finished_at. Così collect-pending può ancora scaricare e promuovere il
      // dataset anche se questo status poller arriva prima.
      let itemCount: number | null = null;
      if (datasetId) itemCount = (await fetchDataset(datasetId, token, 1)).length;
      await sb.from("padova_apify_runs").update({
        status,
        cost_usd: cost,
        ...(itemCount !== null ? { items_count: itemCount } : {}),
      }).eq("id", r.id);
      out.push({ portal, run_id: runId, status, cost_usd: cost, delegated_to: "padova-apify-collect-pending" });
      continue;
    }

    // SUCCEEDED — importa solo se non già importato
    if ((r.imported as number) > 0) {
      // già processata; ma persisti comunque cost_usd/status reali
      await sb.from("padova_apify_runs").update({ status, cost_usd: cost }).eq("id", r.id);
    } else if (datasetId) {
      const bigPortals = portal === "idealista" || portal === "casa_full" || portal === "subito_full";
      const items = await fetchDataset(datasetId, token, bigPortals ? 5000 : 50);

      if (portal === "idealista") {
        const rows = items.map(parseIdealista);
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          await sb.from("padova_idealista_staging").insert(chunk);
        }
        await sb.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported: rows.length,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
      } else if (portal === "casa") {
        const rows = items.slice(0, 10).map((it) => ({ raw_json: it }));
        if (rows.length) await sb.from("padova_casa_test").insert(rows);
        await sb.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported: rows.length,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
      } else if (portal === "subito") {
        const rows = items.slice(0, 10).map((it) => ({ raw_json: it }));
        if (rows.length) await sb.from("padova_subito_test").insert(rows);
        await sb.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported: rows.length,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
      } else if (portal === "casa_full") {
        const rows = items.map((it) => ({ raw_json: it }));
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          await sb.from("padova_casa_staging").insert(chunk);
        }
        await sb.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported: rows.length,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
      } else if (portal === "subito2") {
        const rows = items.slice(0, 10).map((it) => ({ raw_json: it }));
        if (rows.length) await sb.from("padova_subito_test2").insert(rows);
        await sb.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported: rows.length,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
      } else if (portal === "subito_full") {
        const rows = items.map((it) => ({ raw_json: it }));
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          await sb.from("padova_subito_staging").insert(chunk);
        }
        await sb.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported: rows.length,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
        newlyImportedSubitoFull = rows.length;
      } else {
        // Portale sconosciuto: persisti almeno status + cost per evitare NULL cronici
        await sb.from("padova_apify_runs").update({ status, cost_usd: cost }).eq("id", r.id);
      }
    } else {
      // dataset assente ma run finale: aggiorna status/cost
      await sb.from("padova_apify_runs").update({ status, cost_usd: cost }).eq("id", r.id);
    }

    // Downstream classificazione Subito: idempotente per run_id
    if (portal === "subito_full" && newlyImportedSubitoFull > 0) {
      try {
        const { data: prev } = await sb
          .from("private_leads_run_status")
          .select("id, status, notes")
          .eq("source", "subito")
          .in("status", ["classified", "classified_with_errors"])
          .order("id", { ascending: false })
          .limit(50);
        const already = ((prev ?? []) as Array<{ notes: Record<string, unknown> | null }>).some(
          (row) => row.notes && (row.notes as Record<string, unknown>)["source_run_id"] === runId,
        );
        if (!already) {
          const base = Deno.env.get("SUPABASE_URL") ?? "";
          const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
          const clsRes = await fetch(`${base}/functions/v1/civiko-private-leads-classify`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-job-secret": jobSecret,
              "apikey": anon,
              "Authorization": `Bearer ${anon}`,
            },
            body: JSON.stringify({ since_hours: 12, source_run_id: runId }),
            signal: AbortSignal.timeout(90_000),
          });
          if (!clsRes.ok) {
            // Non perdere il dataset: logga l'errore ma non svuotare imported;
            // il retry avverrà al prossimo polling perché source_run_id non
            // risulterà in private_leads_run_status.
            console.error(
              `[multi-status] classify HTTP ${clsRes.status} for subito_full run ${runId}`,
            );
          }
          await clsRes.body?.cancel();
        }
      } catch (e) {
        console.error(
          `[multi-status] classify invocation failed for subito_full run ${runId}: ${(e as Error).message}`,
        );
      }
    }

    // Sommario per portale
    if (portal === "idealista") {
      const { data: stg } = await sb
        .from("padova_idealista_staging")
        .select("agency, tipo_lead, mq, locali, prezzo, lat, lng, url, indirizzo")
        .gte("fetched_at", new Date(Date.now() - 6 * 3600_000).toISOString());
      const arr = (stg ?? []) as Array<Record<string, unknown>>;
      out.push({
        portal,
        run_id: runId,
        status,
        cost_usd: cost,
        cost_cap_usd: costCap,
        items_count: arr.length,
        agency_pulita: arr.filter((x) => looksClean(x.agency as string)).length,
        privato: arr.filter((x) => x.tipo_lead === "PRIVATO").length,
        agenzia: arr.filter((x) => x.tipo_lead === "AGENZIA").length,
        con_mq_locali_prezzo: arr.filter((x) => x.mq != null && x.locali != null && x.prezzo != null).length,
        con_lat_lng: arr.filter((x) => x.lat != null && x.lng != null).length,
        esempi: arr.slice(0, 3).map((x) => ({
          url: x.url, agency: x.agency, tipo: x.tipo_lead, mq: x.mq, locali: x.locali,
          prezzo: x.prezzo, indirizzo: x.indirizzo, lat: x.lat, lng: x.lng,
        })),
      });
    } else if (portal === "casa") {
      const { data: stg } = await sb
        .from("padova_casa_test")
        .select("raw_json")
        .order("id", { ascending: false })
        .limit(5);
      const arr = (stg ?? []) as Array<{ raw_json: unknown }>;
      out.push({
        portal, run_id: runId, status, cost_usd: cost, cost_cap_usd: costCap,
        items_received: arr.length, target: 5,
        raw_samples: arr.map((x) => x.raw_json),
      });
    } else if (portal === "subito") {
      const { data: stg } = await sb
        .from("padova_subito_test")
        .select("raw_json")
        .order("id", { ascending: false })
        .limit(5);
      const arr = (stg ?? []) as Array<{ raw_json: unknown }>;
      out.push({
        portal, run_id: runId, status, cost_usd: cost, cost_cap_usd: costCap,
        items_received: arr.length, target: 5,
        raw_samples: arr.map((x) => x.raw_json),
      });
    } else if (portal === "casa_full") {
      const { count } = await sb
        .from("padova_casa_staging")
        .select("*", { count: "exact", head: true });
      const { data: stg } = await sb
        .from("padova_casa_staging")
        .select("raw_json")
        .order("id", { ascending: false })
        .limit(3);
      const arr = (stg ?? []) as Array<{ raw_json: Record<string, unknown> }>;
      const summarize = (j: Record<string, unknown>) => {
        const feat = (j.features ?? {}) as Record<string, unknown>;
        const loc = (j.location ?? {}) as Record<string, unknown>;
        const coords = (loc.coordinates ?? {}) as Record<string, unknown>;
        const title = (j.title ?? {}) as Record<string, unknown>;
        return {
          publisherName: j.publisherName, publisherPhone: j.publisherPhone,
          price: j.price, mq: feat.squareMeters, rooms: feat.rooms, bathrooms: feat.bathrooms,
          lat: coords.lat, lon: coords.lon, city: loc.city,
          propertyType: j.propertyType, title: title.main, url: j.url,
        };
      };
      // Count quality across full staging
      const { data: all } = await sb.from("padova_casa_staging").select("raw_json");
      const allArr = (all ?? []) as Array<{ raw_json: Record<string, unknown> }>;
      const withName = allArr.filter((x) => !!x.raw_json?.publisherName).length;
      const withPhone = allArr.filter((x) => !!x.raw_json?.publisherPhone).length;
      const withMq = allArr.filter((x) => !!((x.raw_json?.features as Record<string,unknown>)?.squareMeters)).length;
      const withPrice = allArr.filter((x) => x.raw_json?.price != null).length;
      const withCoord = allArr.filter((x) => {
        const c = (x.raw_json?.location as Record<string,unknown>)?.coordinates as Record<string,unknown>;
        return c?.lat != null && c?.lon != null;
      }).length;
      out.push({
        portal, run_id: runId, status, cost_usd: cost, cost_cap_usd: costCap,
        items_found_apify: run.stats?.inputBodyLen ? undefined : (run as Record<string, unknown>).itemCount,
        items_in_staging: count ?? allArr.length,
        with_publisherName: withName, with_publisherPhone: withPhone,
        with_mq: withMq, with_price: withPrice, with_lat_lon: withCoord,
        esempi: arr.map((x) => summarize(x.raw_json)),
      });
    } else if (portal === "subito2") {
      const { data: stg } = await sb
        .from("padova_subito_test2")
        .select("raw_json")
        .order("id", { ascending: false })
        .limit(5);
      const arr = (stg ?? []) as Array<{ raw_json: unknown }>;
      out.push({
        portal, run_id: runId, status, cost_usd: cost, cost_cap_usd: costCap,
        items_received: arr.length, target: 5,
        raw_samples: arr.map((x) => x.raw_json),
      });
    } else if (portal === "subito_full") {
      const { data: all } = await sb.from("padova_subito_staging").select("raw_json");
      const allArr = (all ?? []) as Array<{ raw_json: Record<string, unknown> }>;
      const totalItems = allArr.length;
      const padovaCity = allArr.filter((x) => {
        const t = (x.raw_json?.geo_town_value as string) ?? "";
        return t.toLowerCase().startsWith("padova");
      });
      const isAgency = (j: Record<string, unknown>) => j.advertiser_company === true || String(j.advertiser_company) === "true";
      const hasPhone = (j: Record<string, unknown>) => {
        const p = j.phone_number;
        return p != null && String(p) !== "0" && String(p).trim() !== "";
      };
      const agenzia = padovaCity.filter((x) => isAgency(x.raw_json)).length;
      const privato = padovaCity.filter((x) => !isAgency(x.raw_json)).length;
      const withTel = padovaCity.filter((x) => hasPhone(x.raw_json)).length;
      const complete = padovaCity.filter((x) => {
        const j = x.raw_json;
        return j.features_size_values != null && j.features_room_values != null &&
               j.features_price_values != null && j.geo_map_latitude != null && j.geo_map_longitude != null;
      }).length;
      const summarize = (j: Record<string, unknown>) => ({
        url: j.urls_default, advertiser_name: j.advertiser_name,
        agenzia: isAgency(j), phone: j.phone_number,
        mq: j.features_size_values, locali: j.features_room_values, bagni: j.features_bathrooms_values,
        prezzo: j.features_price_values, lat: j.geo_map_latitude, lng: j.geo_map_longitude,
        address: j.geo_map_address, town: j.geo_town_value,
      });
      const privCity = padovaCity.filter((x) => !isAgency(x.raw_json));
      const privWithTel = privCity.filter((x) => hasPhone(x.raw_json));
      const esempi: Record<string, unknown>[] = [];
      if (privWithTel[0]) esempi.push(summarize(privWithTel[0].raw_json));
      for (const x of padovaCity) {
        if (esempi.length >= 3) break;
        const s = summarize(x.raw_json);
        if (!esempi.some((e) => e.url === s.url)) esempi.push(s);
      }
      out.push({
        portal, run_id: runId, status, cost_usd: cost, cost_cap_usd: costCap,
        items_total: totalItems, items_padova_city: padovaCity.length,
        privato, agenzia, with_phone: withTel, with_mq_locali_prezzo_latlng: complete,
        esempi,
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, dbStatus_marker: true, runs: out }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
