// padova-apify-multi-status
// Per ciascuna run recente (idealista/casa/subito) controlla lo stato Apify,
// se SUCCEEDED scarica dataset, ABORTA se cost > cost_cap_usd, e:
//   - idealista: parse + insert in padova_idealista_staging
//   - casa/subito: insert raw_json grezzo in padova_casa_test / padova_subito_test
// Ritorna un report human-readable.
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";

async function getRun(runId: string, token: string) {
  const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return null; }
  const j = await r.json();
  return j?.data ?? null;
}

async function abortRun(runId: string, token: string) {
  await fetch(`${APIFY}/actor-runs/${runId}/abort?token=${encodeURIComponent(token)}`, { method: "POST" })
    .catch(() => undefined);
}

async function fetchDataset(datasetId: string, token: string, limit = 5000): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${APIFY}/datasets/${datasetId}/items?clean=true&limit=${limit}&token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return []; }
  const j = await r.json();
  return Array.isArray(j) ? j as Record<string, unknown>[] : [];
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
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    if (!run) { out.push({ portal, run_id: runId, status: "unknown" }); continue; }
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

    if (status !== "SUCCEEDED") {
      await sb.from("padova_apify_runs").update({ status, cost_usd: cost }).eq("id", r.id);
      out.push({ portal, run_id: runId, status, cost_usd: cost });
      continue;
    }

    // SUCCEEDED — importa solo se non già importato
    if ((r.imported as number) > 0) {
      // già processata; ritorna sommario senza re-import
    } else if (datasetId) {
      const items = await fetchDataset(datasetId, token, portal === "idealista" ? 5000 : 50);

      if (portal === "idealista") {
        const rows = items.map(parseIdealista);
        // insert in batch da 500
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
    }
  }

  return new Response(JSON.stringify({ ok: true, dbStatus_marker: true, runs: out }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
