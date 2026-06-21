// padova-agencies-pipeline
// Central Core — orchestrates the full agencies pipeline for Padova:
//   ?action=launch&mode=soft|full  → checks monthly budget, opens a pipeline_runs row,
//                                    starts Apify actors for idealista/casa, plus
//                                    refreshes immobiliare detail URLs from db.
//   ?action=finalize               → polls pending padova_apify_runs (≤6h),
//                                    imports to staging, runs promoter into
//                                    padova_listings, marks expired (full only),
//                                    triggers contendibili recompute, closes
//                                    the pipeline_runs row(s).
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY = "https://api.apify.com/v2";
const CAP_USD = Number(Deno.env.get("AGENCY_PIPELINE_MONTHLY_CAP_USD") ?? "215"); // ≈ 200 EUR

type Mode = "soft" | "full";

interface SourceCost {
  soft: number; // est USD per soft run
  full: number; // est USD per full run
  max_urls_soft: number;
  max_urls_full: number;
}
const COSTS: Record<string, SourceCost> = {
  idealista:    { soft: 0.40, full: 2.00, max_urls_soft: 80,  max_urls_full: 600 },
  casa:         { soft: 0.30, full: 1.50, max_urls_soft: 200, max_urls_full: 1200 },
  immobiliare:  { soft: 0.40, full: 2.00, max_urls_soft: 80,  max_urls_full: 600 },
};

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

async function startActor(actor: string, input: Record<string, unknown>, token: string) {
  const r = await fetch(`${APIFY}/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const txt = await r.text();
  if (!r.ok) return { ok: false, error: `apify_${r.status}: ${txt.slice(0, 300)}` };
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(txt); } catch { /* */ }
  const d = (j as { data?: { id?: string; defaultDatasetId?: string; status?: string } }).data ?? {};
  return { ok: true, run_id: d.id, dataset_id: d.defaultDatasetId, status: d.status };
}

async function getApifyRun(runId: string, token: string) {
  const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  if (!r.ok) { await r.body?.cancel(); return null; }
  const j = await r.json();
  return j?.data ?? null;
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

function parseIdealista(it: Record<string, unknown>) {
  const contact = (it.contactInfo ?? {}) as Record<string, unknown>;
  const more = (it.moreCharacteristics ?? {}) as Record<string, unknown>;
  const ubi = (it.ubication ?? {}) as Record<string, unknown>;
  const pid = it.propertyId ?? it.adid;
  const url = (it.originalUrl as string) ?? (it.detailWebLink as string)
    ?? (pid ? `https://www.idealista.it/immobile/${pid}/` : null);
  const professional = contact.professional;
  return {
    url,
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

async function pickUrlsFromDb(sb: ReturnType<typeof createClient>, fonte: string, cap: number): Promise<string[]> {
  // Take fresh-ish URLs (not expired) sorted by last_seen_at asc → oldest first
  const out: string[] = [];
  const pageSize = 1000;
  for (let from = 0; from < cap && out.length < cap; from += pageSize) {
    const to = Math.min(from + pageSize - 1, cap - 1);
    const { data } = await sb
      .from("padova_listings")
      .select("url, last_seen_at")
      .eq("fonte", fonte)
      .is("expired_at", null)
      .not("url", "is", null)
      .order("last_seen_at", { ascending: true })
      .range(from, to);
    const page = (data ?? []).map((r: { url: string }) => r.url).filter(Boolean);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
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

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "launch";
  const mode = (url.searchParams.get("mode") ?? "soft") as Mode;
  const trigger = url.searchParams.get("trigger") ?? "cron";

  const client = sb();

  // ============================================================
  // ACTION = LAUNCH
  // ============================================================
  if (action === "launch") {
    // 1) Budget check
    const { data: budget } = await client.rpc("agency_pipeline_budget_check", { p_cap_usd: CAP_USD });
    const b = (budget ?? {}) as { ok?: boolean; spent_usd?: number; cap_usd?: number; remaining_usd?: number };
    if (!b.ok) {
      const { data: skip } = await client.from("pipeline_runs").insert({
        pipeline_name: "padova-agencies", mode, trigger_source: trigger,
        status: "skipped_budget", finished_at: new Date().toISOString(),
        monthly_spent_usd_at_start: b.spent_usd, monthly_cap_usd: b.cap_usd,
        warnings: ["monthly_cap_reached"],
      }).select("id").single();
      return new Response(JSON.stringify({
        ok: false, error: "monthly_cap_reached", budget: b, pipeline_run_id: (skip as { id: number } | null)?.id,
      }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2) Open pipeline_runs row
    const sources: string[] = [];
    const { data: runRow } = await client.from("pipeline_runs").insert({
      pipeline_name: "padova-agencies", mode, trigger_source: trigger,
      status: "running",
      monthly_spent_usd_at_start: b.spent_usd, monthly_cap_usd: b.cap_usd,
    }).select("id").single();
    const runDbId = (runRow as { id: number } | null)?.id ?? null;

    const apifyRunIds: string[] = [];
    const launched: Record<string, unknown>[] = [];
    const warnings: string[] = [];

    // 3) IDEALISTA (refresh from existing URLs in padova_listings + padova_collect_v2_items)
    {
      const cap = mode === "full" ? COSTS.idealista.max_urls_full : COSTS.idealista.max_urls_soft;
      let urls = await pickUrlsFromDb(client, "idealista", cap);
      if (urls.length < cap) {
        // Top up from collect_v2_items legacy pool
        const need = cap - urls.length;
        const { data } = await client
          .from("padova_collect_v2_items")
          .select("url")
          .ilike("url", "%idealista.it%")
          .ilike("url", "%/immobile/%")
          .order("url", { ascending: true })
          .range(0, Math.min(need, 1000) - 1);
        const extra = (data ?? []).map((r: { url: string }) => r.url).filter((u: string) => u && !urls.includes(u));
        urls = urls.concat(extra.slice(0, need));
      }
      if (urls.length > 0) {
        const costCap = mode === "full" ? COSTS.idealista.full : COSTS.idealista.soft;
        const r = await startActor("dz_omar/idealista-scraper-api", {
          Property_urls: urls.map((u) => ({ url: u })),
          desiredResults: urls.length,
        }, token);
        if (r.ok && r.run_id) {
          sources.push("idealista");
          apifyRunIds.push(r.run_id);
          await client.from("padova_apify_runs").insert({
            portal: "idealista", actor_id: "dz_omar/idealista-scraper-api",
            run_id: r.run_id, dataset_id: r.dataset_id ?? null,
            status: r.status ?? "RUNNING", cost_cap_usd: costCap,
          });
          launched.push({ source: "idealista", urls: urls.length, run_id: r.run_id, dataset_id: r.dataset_id, cost_cap_usd: costCap });
        } else {
          warnings.push(`idealista_launch_failed:${r.error ?? "unknown"}`);
        }
      } else {
        warnings.push("idealista_no_urls");
      }
    }

    // 4) CASA.IT (search-by-location actor — discovers new annunci)
    {
      const maxR = mode === "full" ? COSTS.casa.max_urls_full : COSTS.casa.max_urls_soft;
      const costCap = mode === "full" ? COSTS.casa.full : COSTS.casa.soft;
      const r = await startActor("solidcode/casa-property-search-scraper", {
        searchLocation: "Padova",
        propertyType: "all",
        maxResultsPerUrl: maxR,
        maxResults: maxR,
        ignoreUrlFailures: true,
        language: "it",
      }, token);
      if (r.ok && r.run_id) {
        sources.push("casa");
        apifyRunIds.push(r.run_id);
        await client.from("padova_apify_runs").insert({
          portal: "casa_full", actor_id: "solidcode/casa-property-search-scraper",
          run_id: r.run_id, dataset_id: r.dataset_id ?? null,
          status: r.status ?? "RUNNING", cost_cap_usd: costCap,
        });
        launched.push({ source: "casa", max_results: maxR, run_id: r.run_id, dataset_id: r.dataset_id, cost_cap_usd: costCap });
      } else {
        warnings.push(`casa_launch_failed:${r.error ?? "unknown"}`);
      }
    }

    // 5) IMMOBILIARE (detail-by-url — refresh known URLs only; discovery requires separate search actor)
    {
      const cap = mode === "full" ? COSTS.immobiliare.max_urls_full : COSTS.immobiliare.max_urls_soft;
      const urls = await pickUrlsFromDb(client, "immobiliare", cap);
      if (urls.length > 0) {
        const costCap = mode === "full" ? COSTS.immobiliare.full : COSTS.immobiliare.soft;
        const r = await startActor("memo23~immobiliare-scraper", {
          startUrls: urls,
          maxItems: urls.length,
          includeAgencyDetails: false,
          proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
        }, token);
        if (r.ok && r.run_id) {
          sources.push("immobiliare");
          apifyRunIds.push(r.run_id);
          await client.from("padova_apify_runs").insert({
            portal: "immobiliare", actor_id: "memo23~immobiliare-scraper",
            run_id: r.run_id, dataset_id: r.dataset_id ?? null,
            status: r.status ?? "RUNNING", cost_cap_usd: costCap,
          });
          launched.push({ source: "immobiliare", urls: urls.length, run_id: r.run_id, dataset_id: r.dataset_id, cost_cap_usd: costCap });
        } else {
          warnings.push(`immobiliare_launch_failed:${r.error ?? "unknown"}`);
        }
      } else {
        warnings.push("immobiliare_no_urls");
      }
    }

    if (runDbId != null) {
      await client.from("pipeline_runs").update({
        apify_run_ids: apifyRunIds, sources, warnings, updated_at: new Date().toISOString(),
      }).eq("id", runDbId);
    }

    return new Response(JSON.stringify({
      ok: true, action, mode, pipeline_run_id: runDbId, budget: b,
      launched, warnings,
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ============================================================
  // ACTION = FINALIZE
  // ============================================================
  if (action === "finalize") {
    const sinceIso = new Date(Date.now() - 6 * 3600_000).toISOString();
    const startedAt = new Date();

    // 1) Process pending Apify runs (last 6h, agency portals only)
    const { data: runs } = await client
      .from("padova_apify_runs")
      .select("*")
      .in("portal", ["idealista", "casa_full", "immobiliare"])
      .gte("started_at", sinceIso)
      .order("started_at", { ascending: false });

    const processed: Record<string, unknown>[] = [];
    let totalCost = 0;

    for (const r of (runs ?? []) as Array<Record<string, unknown>>) {
      const portal = r.portal as string;
      const runId = r.run_id as string;
      const datasetId = r.dataset_id as string | null;
      const costCap = Number(r.cost_cap_usd ?? 0);
      if (runId === "ERROR") { processed.push({ portal, run_id: runId, skipped: true }); continue; }

      const run = await getApifyRun(runId, token);
      if (!run) { processed.push({ portal, run_id: runId, status: "unknown" }); continue; }
      const cost = Number(run.usageTotalUsd ?? 0);
      const status = run.status as string;

      // Abort if over cap
      if (cost > costCap && (status === "RUNNING" || status === "READY")) {
        await fetch(`${APIFY}/actor-runs/${runId}/abort?token=${encodeURIComponent(token)}`, { method: "POST" })
          .catch(() => undefined);
        await client.from("padova_apify_runs").update({
          status: "ABORTED_COST_CAP", cost_usd: cost,
          error: `cost ${cost} > cap ${costCap}`,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
        processed.push({ portal, run_id: runId, status: "ABORTED_COST_CAP", cost_usd: cost });
        continue;
      }

      const isFinal = status === "SUCCEEDED" || status === "TIMED-OUT" || status === "FAILED";
      if (!isFinal) {
        await client.from("padova_apify_runs").update({ status, cost_usd: cost }).eq("id", r.id);
        processed.push({ portal, run_id: runId, status, cost_usd: cost });
        continue;
      }

      // Already imported?
      if ((r.imported as number) > 0) {
        totalCost += cost;
        processed.push({ portal, run_id: runId, status, cost_usd: cost, already_imported: r.imported });
        continue;
      }

      if (datasetId) {
        const items = await fetchDataset(datasetId, token, 5000);
        let imported = 0;

        if (portal === "idealista") {
          const rows = items.map(parseIdealista).filter((x) => !!x.url);
          for (let i = 0; i < rows.length; i += 500) {
            await client.from("padova_idealista_staging").insert(rows.slice(i, i + 500));
          }
          imported = rows.length;
        } else if (portal === "casa_full") {
          const rows = items.map((it) => ({ raw_json: it }));
          for (let i = 0; i < rows.length; i += 500) {
            await client.from("padova_casa_staging").insert(rows.slice(i, i + 500));
          }
          imported = rows.length;
        } else if (portal === "immobiliare") {
          // Insert staging rows mirroring padova-immobiliare-detail-import logic
          const mapped: Record<string, unknown>[] = [];
          for (const it of items) {
            const itrec = it as Record<string, unknown>;
            const advertiser = (itrec.advertiser ?? {}) as Record<string, unknown>;
            const agencyObj = (advertiser.agency ?? {}) as Record<string, unknown>;
            const props = (itrec.properties as Record<string, unknown>[]) ?? [];
            const main = (props[0] ?? {}) as Record<string, unknown>;
            const loc = (main.location ?? {}) as Record<string, unknown>;
            const price = (itrec.price ?? main.price ?? {}) as Record<string, unknown>;
            const mf = (main.mainFeatures ?? []) as Array<{ type?: string; label?: string; compactLabel?: string }>;
            const find = (t: string) => mf.find((f) => f.type === t);
            const agency = (agencyObj.displayName as string) ?? (agencyObj.name as string) ?? null;
            mapped.push({
              run_id: runId,
              url: (itrec.input_url as string) ?? (itrec.url as string) ?? null,
              agency,
              tipo_lead: agency ? "AGENZIA" : "PRIVATO",
              mq: num(find("surface")?.label ?? main.surface),
              locali: num(find("rooms")?.compactLabel ?? find("rooms")?.label ?? main.rooms),
              bagni: num(find("bathrooms")?.compactLabel ?? find("bathrooms")?.label ?? main.bathrooms),
              prezzo: num(price.value),
              lat: num(loc.latitude),
              lng: num(loc.longitude),
              indirizzo: [loc.address, loc.microzone, loc.city].filter(Boolean).join(", ") || null,
              raw_json: itrec,
            });
          }
          await client.from("padova_immobiliare_detail_staging").delete().eq("run_id", runId);
          for (let i = 0; i < mapped.length; i += 500) {
            await client.from("padova_immobiliare_detail_staging").insert(mapped.slice(i, i + 500));
          }
          imported = mapped.length;
        }

        await client.from("padova_apify_runs").update({
          status, cost_usd: cost, items_count: items.length, imported,
          finished_at: new Date().toISOString(),
        }).eq("id", r.id);
        totalCost += cost;
        processed.push({ portal, run_id: runId, status, cost_usd: cost, items: items.length, imported });
      }
    }

    // 2) Run promoter (staging → padova_listings)
    const { data: promoRes } = await client.rpc("promote_padova_agencies_listings", {
      p_since: sinceIso,
    });

    // Immobiliare: promote via existing UPDATE pattern (no insert needed for refresh)
    // Update padova_listings.last_seen_at and prezzo/mq/etc from immobiliare staging for runs in scope.
    const { data: immRunIds } = await client
      .from("padova_apify_runs")
      .select("run_id")
      .eq("portal", "immobiliare")
      .gte("started_at", sinceIso);
    let immUpdated = 0;
    for (const r of (immRunIds ?? []) as Array<{ run_id: string }>) {
      const { data: rows } = await client
        .from("padova_immobiliare_detail_staging")
        .select("url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo")
        .eq("run_id", r.run_id);
      for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
        if (!row.url) continue;
        const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString(), expired_at: null };
        for (const k of ["agency", "tipo_lead", "mq", "locali", "bagni", "prezzo", "lat", "lng", "indirizzo"]) {
          if (row[k] != null) patch[k] = row[k];
        }
        const { data: upd } = await client.from("padova_listings")
          .update(patch)
          .eq("fonte", "immobiliare")
          .eq("url", row.url as string)
          .select("id");
        immUpdated += (upd ?? []).length;
      }
    }

    // 3) Mark expired (only for full-mode runs in last 24h)
    let expiredInfo: unknown = null;
    const { data: lastFull } = await client.from("pipeline_runs")
      .select("started_at, mode")
      .eq("pipeline_name", "padova-agencies")
      .eq("mode", "full")
      .gte("started_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastFull && (lastFull as { started_at: string }).started_at) {
      const { data: exp } = await client.rpc("expire_padova_agency_listings", {
        p_seen_since: (lastFull as { started_at: string }).started_at,
      });
      expiredInfo = exp;
    }

    // 4) Trigger contendibili recompute (RPC chain already in place)
    const { data: contendRes } = await client.rpc("recompute_padova_listings_contendibili");
    const { data: mergeRes } = await client.rpc("merge_padova_contendibili");
    const { data: extrasRes } = await client.rpc("recompute_padova_contendibili_extras");

    // 5) Close all running pipeline_runs of agencies started in last 12h
    const { data: openRuns } = await client.from("pipeline_runs")
      .select("id, started_at, sources, mode")
      .eq("pipeline_name", "padova-agencies")
      .eq("status", "running")
      .gte("started_at", new Date(Date.now() - 12 * 3600_000).toISOString());

    const summaries: Record<string, unknown>[] = [];
    for (const pr of (openRuns ?? []) as Array<{ id: number; started_at: string; sources: string[] }>) {
      const dur = Date.now() - new Date(pr.started_at).getTime();
      const perSource = {
        idealista: { ...(promoRes as { idealista?: unknown })?.idealista ?? {} },
        casa:      { ...(promoRes as { casa?: unknown })?.casa ?? {} },
        immobiliare: { updated: immUpdated },
      };
      await client.from("pipeline_runs").update({
        status: "done",
        finished_at: new Date().toISOString(),
        duration_ms: dur,
        cost_usd: totalCost,
        per_source_stats: perSource,
        updated_at: new Date().toISOString(),
      }).eq("id", pr.id);
      summaries.push({ pipeline_run_id: pr.id, per_source: perSource, cost_usd: totalCost });
    }

    return new Response(JSON.stringify({
      ok: true, action,
      processed_apify_runs: processed,
      promoter: promoRes,
      immobiliare_updated: immUpdated,
      expired: expiredInfo,
      contendibili: { recompute: contendRes, merge: mergeRes, extras: extrasRes },
      pipeline_runs_closed: summaries,
      total_cost_usd: totalCost,
      duration_ms: Date.now() - startedAt.getTime(),
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ ok: false, error: "unknown_action", action }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
