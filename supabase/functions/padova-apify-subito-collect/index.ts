// padova-apify-subito-collect
// Collect subito.it listings Padova via actor Apify `emastra/subito-it-immobili`.
// Scrive in `padova_collect_v2_items` (portal='subito') e in `padova_subito_staging`
// (shape flattenata per process_padova_subito_staging / private-leads).
//
// Modes:
//   - default sync: start + wait + ingest
//   - { async_start: true }: start, registra RUNNING in padova_apify_runs, ritorna 202
//   - { dry_run: true, max_items }: start + wait, ritorna sample senza scrivere
//   - { ingest_run_id }: (per collect-pending) legge dataset di run già SUCCEEDED
//
// Auth: CENTRAL_CORE_JOB_SECRET via x-job-secret / x-internal-secret / Bearer.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getApifyToken,
  handoffCollectPending,
  startApifyRun,
  writeSubitoSourceRegistry,
} from "../_shared/apify.ts";
import { ACTOR_SUBITO } from "../_shared/apifyLaunch.ts";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import { expireStaleScrapeJobs } from "../_shared/scrapeJobWatchdog.ts";
import {
  buildSubitoActorInput,
  clampSubitoMaxItems,
  estimateSubitoCostUsd,
  flattenSubitoForStaging,
  mapSubito,
  normalizeSubitoStartUrls,
} from "../_shared/subitoMapper.ts";

const APIFY = "https://api.apify.com/v2";

interface Body {
  search_urls?: unknown;
  max_items?: number;
  wait_seconds?: number;
  dry_run?: boolean;
  async_start?: boolean;
  ingest_run_id?: string;
}

async function pollRun(runId: string, token: string, timeoutSec: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutSec * 1000) {
    const r = await fetch(`${APIFY}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    const status = j?.data?.status;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      return { status, run: j.data, dataset_id: j.data.defaultDatasetId as string };
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { status: "TIMEOUT_LOCAL", run: null, dataset_id: null };
}

async function fetchDataset(datasetId: string, token: string, limit: number) {
  const r = await fetch(
    `${APIFY}/datasets/${datasetId}/items?clean=1&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`apify_dataset_${r.status}`);
  return (await r.json()) as any[];
}

async function insertSubitoStaging(sb: ReturnType<typeof createClient>, items: any[]) {
  const rows = items.map((it) => ({ raw_json: flattenSubitoForStaging(it) }));
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const { error } = await sb.from("padova_subito_staging").insert(slice);
    if (error) errors.push(`staging:${error.message}`);
  }
  return errors;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    await writeSubitoSourceRegistry({ ok: false, error: auth.error });
    return new Response(
      JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const token = getApifyToken();
  if (!token) {
    await writeSubitoSourceRegistry({ ok: false, error: "APIFY_API_TOKEN_missing" });
    return new Response(
      JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty */ }

  const maxItems = clampSubitoMaxItems(body.max_items);
  const timeoutSec = body.wait_seconds ?? 240;
  const searchUrls = normalizeSubitoStartUrls(body.search_urls);
  const estCostUsd = estimateSubitoCostUsd(maxItems);

  try {
    let run_id: string;
    let dataset_id: string;
    let webhook_attached = false;

    if (body.ingest_run_id) {
      const r = await fetch(`${APIFY}/actor-runs/${body.ingest_run_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (!r.ok || !j?.data?.defaultDatasetId) {
        throw new Error(`apify_run_lookup_${r.status}`);
      }
      run_id = body.ingest_run_id;
      dataset_id = j.data.defaultDatasetId;
    } else {
      // Release skip-locks held by jobs stuck in RUNNING past the watchdog timeout
      // before the 6h dedup check, otherwise a hung run blocks every later collect.
      await expireStaleScrapeJobs(sb);

      const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const { data: inflight, error: inflightErr } = await sb
        .from("padova_apify_runs")
        .select("run_id, started_at")
        .eq("portal", "subito_collect")
        .eq("status", "RUNNING")
        .gte("started_at", sixHoursAgo)
        .limit(1);
      if (inflightErr) {
        await writeSubitoSourceRegistry({ ok: false, error: "APIFY_DEDUP_CHECK_FAILED" });
        return new Response(
          JSON.stringify({ ok: false, code: "APIFY_DEDUP_CHECK_FAILED" }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (inflight && inflight.length > 0) {
        await writeSubitoSourceRegistry({
          ok: false, error: "subito_run_already_running",
        });
        return new Response(
          JSON.stringify({
            ok: false, skipped: true,
            skipped_reason: "subito_run_already_running",
            existing_run_id: inflight[0].run_id,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const launched = await startApifyRun(
        ACTOR_SUBITO,
        buildSubitoActorInput(searchUrls, maxItems),
        { portal: "subito_collect", estUsd: estCostUsd, costCapUsd: estCostUsd },
      );
      if (!launched.started) {
        console.warn(`[apify] lancio saltato: ${launched.reason} portal=subito_collect`);
        await writeSubitoSourceRegistry({ ok: false, error: launched.reason });
        return new Response(
          JSON.stringify({ ok: false, skipped: true, reason: launched.reason }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      run_id = launched.run_id;
      dataset_id = launched.dataset_id;
      webhook_attached = launched.webhook_attached;

      if (body.async_start) {
        handoffCollectPending([run_id]);
        await writeSubitoSourceRegistry({ ok: true, records: 1 });
        return new Response(
          JSON.stringify({
            ok: true, async_start: true, run_id, dataset_id, webhook_attached,
            started: [{ run_id, dataset_id, webhook_attached }],
            search_urls: searchUrls.length,
            note: "run avviato in async: webhook + collect-pending completeranno ingest",
          }, null, 2),
          { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { status } = await pollRun(run_id, token, timeoutSec);
      if (status !== "SUCCEEDED") {
        await writeSubitoSourceRegistry({ ok: false, error: `run_status_${status}` });
        return new Response(
          JSON.stringify({
            ok: false, run_id, dataset_id, status,
            note: "run non terminato, alza wait_seconds o pesca via ingest_run_id",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const items = await fetchDataset(dataset_id, token, maxItems);
    if (items.length === 0) {
      await writeSubitoSourceRegistry({ ok: false, error: "provider_returned_zero_items" });
      return new Response(JSON.stringify({ ok: false, error: "provider_returned_zero_items", run_id, dataset_id }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const nowIso = new Date().toISOString();
    const jobId = `apify-subito-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const mapped = items.map((it) => mapSubito(it, jobId, nowIso)).filter(Boolean) as any[];
    const droppedOutOfScope = items.length - mapped.length;

    const byUrl = new Map<string, any>();
    for (const r of mapped) byUrl.set(r.url, r);
    const deduped = Array.from(byUrl.values());

    if (body.dry_run) {
      const rawKeys = items[0] ? Object.keys(items[0]).sort() : [];
      const geoKeys = items[0]?.geo ? Object.keys(items[0].geo) : null;
      const advKeys = items[0]?.advertiser ? Object.keys(items[0].advertiser) : null;
      const featsSample = items[0]?.features
        ? (Array.isArray(items[0].features)
          ? items[0].features.slice(0, 8)
          : Object.keys(items[0].features).slice(0, 20))
        : null;

      return new Response(
        JSON.stringify({
          ok: true, dry_run: true, run_id, dataset_id,
          dataset_size: items.length,
          mapped_total: mapped.length,
          padova_kept: mapped.length,
          dropped_out_of_scope: droppedOutOfScope,
          deduped: deduped.length,
          schema_probe: {
            raw_top_level_keys: rawKeys,
            geo_keys: geoKeys,
            advertiser_keys: advKeys,
            features_sample: featsSample,
          },
          sample_mapped: deduped.slice(0, 3),
          sample_raw: items.slice(0, 2),
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const urls = deduped.map((r) => r.url);
    const existing = new Map<string, number>();
    for (let i = 0; i < urls.length; i += 100) {
      const { data } = await sb
        .from("padova_collect_v2_items")
        .select("id,url").eq("portal", "subito")
        .in("url", urls.slice(i, i + 100));
      for (const r of data ?? []) if (r.url) existing.set(r.url, Number(r.id));
    }

    let created = 0, updated = 0;
    const errors: string[] = [];
    const inserts: any[] = [];
    for (const row of deduped) {
      const eid = existing.get(row.url);
      if (eid) {
        const { error } = await sb.from("padova_collect_v2_items").update(row).eq("id", eid);
        if (error) errors.push(`upd:${error.message}`); else updated++;
      } else {
        inserts.push(row);
      }
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const slice = inserts.slice(i, i + 200);
      const { error } = await sb.from("padova_collect_v2_items").insert(slice);
      if (error) errors.push(`ins:${error.message}`); else created += slice.length;
    }

    if (deduped.length > 0) {
      errors.push(...await insertSubitoStaging(sb, deduped.map((r) => r.raw_json)));
    }

    await sb.from("padova_apify_runs").update({
      status: "SUCCEEDED",
      imported: created + updated,
      items_count: items.length,
      finished_at: nowIso,
    }).eq("run_id", run_id);

    const ok = errors.length === 0 && deduped.length > 0 && created + updated > 0;
    await writeSubitoSourceRegistry({
      ok,
      records: created + updated,
      error: ok ? undefined : (errors[0] ?? "upsert_failed"),
    });
    return new Response(
      JSON.stringify({
        ok, run_id, dataset_id, job_id: jobId,
        dataset_size: items.length,
        mapped_total: mapped.length,
        padova_kept: mapped.length,
        dropped_out_of_scope: droppedOutOfScope,
        deduped: deduped.length,
        created, updated, errors,
      }, null, 2),
      { status: ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await writeSubitoSourceRegistry({ ok: false, error: msg });
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
