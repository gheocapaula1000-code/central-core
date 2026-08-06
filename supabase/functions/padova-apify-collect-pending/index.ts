// padova-apify-collect-pending
// Recovery job: scansiona padova_apify_runs con status='RUNNING' più vecchi di
// `stale_minutes` (default 5) e, se l'actor Apify è SUCCEEDED, scarica il dataset,
// esegue il mapping (idealista / immobiliare detail / immobiliare listview in
// base a actor_id) e fa upsert su padova_collect_v2_items.
//
// Idempotente: usa (portal, url) per de-duplicare. Chiamato manualmente o da
// pg_cron ogni 15 minuti.
//
// Auth: x-job-secret === CENTRAL_CORE_JOB_SECRET
//
// Body opzionale:
//   { stale_minutes?: number, run_ids?: string[], max_runs?: number,
//     max_items_per_run?: number, dry_run?: boolean }

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";
import {
  ACTOR_CASA,
  ACTOR_IDEALISTA,
  ACTOR_IMMO_DETAIL,
  ACTOR_IMMO_LISTVIEW,
  ACTOR_SUBITO,
  isScopeReject,
  mapperFor,
} from "./mappers.ts";
import {
  bumpCounter,
  createScopeCounters,
  
  isComunePadova,
  normalizeCounters,
  reconcileScopeCounters,
} from "../_shared/civikoPadovaScopeGuard.ts";

const APIFY = "https://api.apify.com/v2";


async function apifyRunStatus(runId: string, token: string) {
  const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data ?? null;
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


async function fetchDataset(datasetId: string, token: string, limit: number) {
  const r = await fetch(
    `${APIFY}/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=1&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`apify_dataset_${r.status}`);
  return (await r.json()) as any[];
}


async function upsertItems(
  sb: any, mapped: any[], portal: string, allowListviewOverwrite: boolean,
): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
  const urls = mapped.map((r) => r.url);
  const existing = new Map<string, number>();
  for (let i = 0; i < urls.length; i += 100) {
    const { data } = await sb.from("padova_collect_v2_items").select("id,url")
      .eq("portal", portal).in("url", urls.slice(i, i + 100));
    for (const r of data ?? []) if (r.url) existing.set(r.url, Number(r.id));
  }
  let created = 0, updated = 0, skipped = 0;
  const errors: string[] = [];
  const inserts: any[] = [];
  for (const row of mapped) {
    const eid = existing.get(row.url);
    const isListview = row.parse_status?.endsWith("_listview");
    if (eid) {
      if (isListview && !allowListviewOverwrite) { skipped++; continue; }
      const { error } = await sb.from("padova_collect_v2_items").update(row).eq("id", eid);
      if (error) errors.push(`upd:${error.message}`); else updated++;
    } else inserts.push(row);
  }
  for (let i = 0; i < inserts.length; i += 200) {
    const slice = inserts.slice(i, i + 200);
    const { error } = await sb.from("padova_collect_v2_items").insert(slice);
    if (error) errors.push(`ins:${error.message}`); else created += slice.length;
  }
  return { created, updated, skipped, errors };
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

  let body: any = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  const staleMinutes = Number(body.stale_minutes ?? 5);
  const maxRuns = Number(body.max_runs ?? 20);
  const maxItemsPerRun = Number(body.max_items_per_run ?? 1500);
  const dryRun = !!body.dry_run;
  const zombieHours = Number(body.zombie_hours ?? 4);
  const autoEnrich = body.auto_enrich !== false; // default true
  const maxEnrichPerRun = Number(body.max_enrich_per_run ?? 200);
  // Auto-backfill: quando un run immobiliare_*_enrich/refresh finisce, lancia
  // il batch successivo di URL con agency IS NULL per completare la recovery.
  const agencyBackfillEnabled = body.agency_backfill_enabled !== false; // default true
  const agencyBackfillBatch = Math.max(1, Math.min(500, Number(body.agency_backfill_batch ?? 300)));
  const agencyBackfillMaxLaunches = Math.max(0, Number(body.agency_backfill_max_launches ?? 1));
  // Contratto semantico richiesto dall'orchestratore (fail-closed lato chiamante):
  //  - require_candidates: senza run candidati la risposta NON è un successo;
  //  - require_terminal: tutti i run trattati devono essere in stato terminale;
  //  - required_portals: portali che devono avere almeno un run completato.
  const requireCandidates = body.require_candidates === true;
  const requireTerminal = body.require_terminal === true;
  const requiredPortals: string[] = Array.isArray(body.required_portals)
    ? (body.required_portals as unknown[]).map((p) => String(p)).filter((p) => p.length > 0)
    : [];




  // Seleziona candidati: RUNNING più vecchi di staleMinutes, oppure run_ids espliciti.
  // Include anche SUCCEEDED con imported=0: padova-apify-multi-status può
  // arrivare prima di questo job e persistere lo stato finale Apify. Quella
  // run NON va considerata completata finché il dataset non è stato promosso
  // in padova_collect_v2_items.
  let candidates: any[] = [];
  if (Array.isArray(body.run_ids) && body.run_ids.length) {
    const { data } = await sb.from("padova_apify_runs").select("*").in("run_id", body.run_ids);
    candidates = data ?? [];
  } else {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    const { data: runningRows } = await sb.from("padova_apify_runs").select("*")
      .eq("status", "RUNNING").lt("started_at", cutoff)
      .order("started_at", { ascending: true }).limit(maxRuns);
    const { data: succeededUnimportedRows } = await sb.from("padova_apify_runs").select("*")
      .eq("status", "SUCCEEDED")
      .or("imported.is.null,imported.eq.0")
      .lt("started_at", cutoff)
      .order("started_at", { ascending: true }).limit(maxRuns);
    const byRunId = new Map<string, any>();
    for (const r of [...(runningRows ?? []), ...(succeededUnimportedRows ?? [])]) {
      if (r?.run_id) byRunId.set(String(r.run_id), r);
    }
    candidates = Array.from(byRunId.values()).slice(0, maxRuns);
  }

  const results: any[] = [];
  for (const row of candidates) {
    const runId: string = row.run_id;
    const actorId: string = row.actor_id ?? "";
    const portalTag: string = row.portal ?? "";
    const dsId: string = row.dataset_id ?? "";
    let finalStatus = "UNKNOWN";
    let itemsCount = 0;
    let created = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    try {
      const apifyData = await apifyRunStatus(runId, token);
      if (!apifyData) {
        results.push({ run_id: runId, action: "skip_no_apify_data" });
        continue;
      }
      finalStatus = apifyData.status;
      const datasetId = apifyData.defaultDatasetId ?? dsId;

      if (finalStatus === "SUCCEEDED" && datasetId) {
        const mapper = mapperFor(actorId, portalTag);
        if (!mapper) {
          results.push({ run_id: runId, action: "skip_unknown_actor", actor_id: actorId, portal: portalTag });
          continue;
        }
        const items = await fetchDataset(datasetId, token, maxItemsPerRun);
        itemsCount = items.length;
        const nowIso = new Date().toISOString();
        const jobId = `recovery-${nowIso.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
        // Guard perimetro Civiko: comune autoritativo validato PRIMA di ogni upsert.
        const counters = createScopeCounters();
        const mapped: any[] = [];
        for (const it of items) {
          bumpCounter(counters, "scanned");
          const outcome = mapper.fn(it, jobId, nowIso);
          if (!outcome.ok) {
            bumpCounter(counters, isScopeReject(outcome.code) ? "out_of_scope_rejected" : "other_rejected");
            continue;
          }
          // Doppia barriera: la riga costruita non può uscire dal perimetro.
          if (!isComunePadova(outcome.row.citta)) {
            bumpCounter(counters, "out_of_scope_rejected");
            continue;
          }
          bumpCounter(counters, "padova_kept");
          mapped.push(outcome.row);
        }
        // Dedup by URL
        const byUrl = new Map<string, any>();
        for (const r of mapped) byUrl.set(r.url, r);
        const deduped = Array.from(byUrl.values());
        const outOfScopeInWrites = deduped.filter((r) => !isComunePadova(r.citta)).length;
        bumpCounter(counters, "out_of_scope_written", outOfScopeInWrites);


        let promoted: { new: number; updated: number } | null = null;
        let promoteError: string | null = null;
        if (!dryRun) {
          const up = await upsertItems(sb, deduped, mapper.portal, mapper.allowListviewOverwrite);
          created = up.created; updated = up.updated; skipped = up.skipped;
          errors.push(...up.errors);

          // Promote freshly upserted rows into padova_listings (best-effort).
          const importedCount = created + updated;
          if (importedCount > 0) {
            try {
              const { data: promoRes, error: promoErr } = await sb.rpc(
                "promote_padova_collect_v2_to_listings",
                { p_since: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() },
              );
              if (promoErr) {
                promoteError = promoErr.message;
                errors.push(`promote:${promoErr.message}`);
                console.error(`[collect-pending] promote failed for run ${runId}:`, promoErr.message);
              } else if (promoRes && typeof promoRes === "object") {
                promoted = {
                  new: Number((promoRes as Record<string, unknown>).new ?? 0),
                  updated: Number((promoRes as Record<string, unknown>).updated ?? 0),
                };
                console.log(`[collect-pending] promoted run ${runId}:`, JSON.stringify(promoted));
              }
            } catch (e) {
              promoteError = (e as Error)?.message ?? String(e);
              errors.push(`promote_exception:${promoteError}`);
              console.error(`[collect-pending] promote exception for run ${runId}:`, promoteError);
            }
          }

          await sb.from("padova_apify_runs").update({
            status: "SUCCEEDED",
            finished_at: apifyData.finishedAt ?? nowIso,
            items_count: itemsCount,
            imported: importedCount,
          }).eq("run_id", runId);
        }
        // ============ AUTO-TRIGGER PASS B (enrichment) ============
        // Se la run recuperata è di tipo discovery/listview, lancia enrichment
        // detail-by-URL sui soli URL NEW (non ancora presenti in
        // padova_collect_v2_items come detail). Il nuovo run verrà completato
        // dal prossimo tick di collect-pending.
        let enrichKicked: any = null;
        // Enrichment Pass B è riservato SOLO alle discovery di immobiliare.
        // Casa e altri portali non devono mai lanciarlo.
        const isImmobiliareRun =
          actorId === ACTOR_IMMO_LISTVIEW ||
          portalTag.startsWith("immobiliare");
        const isDiscoveryRun =
          isImmobiliareRun && (
            actorId === ACTOR_IMMO_LISTVIEW ||
            portalTag.includes("_discover") ||
            deduped.some((r) => r.parse_status?.endsWith("_listview"))
          );

        if (autoEnrich && !dryRun && isDiscoveryRun) {
          try {
            const portal = mapper.portal;
            const listviewUrls = deduped
              .filter((r) => r.parse_status?.endsWith("_listview"))
              .map((r) => r.url);
            if (listviewUrls.length > 0) {
              // Filtra NEW: non presenti come detail
              const alreadyDetail = new Set<string>();
              for (let i = 0; i < listviewUrls.length; i += 100) {
                const { data } = await sb.from("padova_collect_v2_items")
                  .select("url,parse_status").eq("portal", portal)
                  .in("url", listviewUrls.slice(i, i + 100));
                for (const r of data ?? []) {
                  if (r.url && r.parse_status?.endsWith("_detail")) alreadyDetail.add(r.url);
                }
              }
              const newUrls = listviewUrls.filter((u) => !alreadyDetail.has(u)).slice(0, maxEnrichPerRun);
              if (newUrls.length > 0) {
                const detailActor = portal === "idealista" ? ACTOR_IDEALISTA : ACTOR_IMMO_DETAIL;
                const input = portal === "idealista"
                  ? { Property_urls: newUrls.map((u) => ({ url: u })) }
                  : {
                      startUrls: newUrls.map((u) => ({ url: u })),
                      maxItems: newUrls.length,
                      includeAgencyDetails: false,
                      proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
                    };
                const { run_id: eRid, dataset_id: eDid } = await startRun(detailActor, input, token);
                await sb.from("padova_apify_runs").insert({
                  portal: `${portal}_autoenrich`,
                  actor_id: detailActor,
                  run_id: eRid,
                  dataset_id: eDid,
                  status: "RUNNING",
                  cost_cap_usd: 0.30,
                });
                enrichKicked = { run_id: eRid, urls: newUrls.length, actor: detailActor };
              } else {
                enrichKicked = { skipped: "no_new_urls", listview_seen: listviewUrls.length };
              }
            }
          } catch (e) {
            enrichKicked = { error: String((e as Error)?.message ?? e) };
          }
        }

        bumpCounter(counters, "writes", created + updated);
        const scope_counters = normalizeCounters(counters);
        const scope_reconciliation = reconcileScopeCounters(scope_counters);
        results.push({
          run_id: runId, actor_id: actorId, portal: portalTag,
          status: finalStatus, items: itemsCount, deduped: deduped.length,
          created, updated, skipped, errors, dry_run: dryRun,
          promoted, promote_error: promoteError,
          auto_enrich: enrichKicked,
          scope_counters, scope_reconciliation,
        });


      } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(finalStatus)) {
        if (!dryRun) {
          await sb.from("padova_apify_runs").update({
            status: finalStatus,
            finished_at: apifyData.finishedAt ?? new Date().toISOString(),
          }).eq("run_id", runId);
        }
        results.push({ run_id: runId, status: finalStatus, action: "marked_failed", dry_run: dryRun });
      } else {
        // Still RUNNING on Apify side → leave the row alone
        results.push({ run_id: runId, status: finalStatus, action: "still_running" });
      }
    } catch (e) {
      results.push({ run_id: runId, error: String((e as Error)?.message ?? e) });
    }
  }

  // ============ AUTO-RECOMPUTE CONTENDIBILI ============
  // Se in questo tick un run agency-backfill ha completato ingest, lancia
  // recompute_padova_listings_contendibili() per misurare subito il delta.
  const recomputeEnabled = body.recompute_after_backfill !== false; // default true
  let recomputeResult: any = null;
  if (!dryRun && recomputeEnabled) {
    const backfillIngested = results.some((r) =>
      r &&
      r.status === "SUCCEEDED" &&
      typeof r.portal === "string" &&
      r.portal === "immobiliare_agency_backfill" &&
      ((r.created ?? 0) + (r.updated ?? 0)) > 0
    );
    if (backfillIngested) {
      try {
        const { data: rc, error: rcErr } = await sb.rpc("recompute_padova_listings_contendibili");
        if (rcErr) {
          recomputeResult = { error: rcErr.message };
          console.error("[collect-pending] recompute failed:", rcErr.message);
        } else {
          recomputeResult = rc ?? { ok: true };
          console.log("[collect-pending] recompute done:", JSON.stringify(recomputeResult));
        }
      } catch (e) {
        recomputeResult = { error: String((e as Error)?.message ?? e) };
        console.error("[collect-pending] recompute exception:", (e as Error)?.message ?? e);
      }
    }
  }



  // ============ AUTO-BACKFILL AGENCY (immobiliare) ============
  // Se in questo tick almeno un run immobiliare detail/refresh ha completato
  // ingest con successo, arruola il batch successivo di URL con agency IS NULL
  // (parse_status='apify_immobiliare_detail' oppure legacy 'radar_ingested'/NULL)
  // e avvia un nuovo run detail-by-URL. Serve a completare la recovery agenzie
  // in modo automatico senza intervento manuale.
  const backfillLaunches: any[] = [];
  if (!dryRun && agencyBackfillEnabled && agencyBackfillMaxLaunches > 0) {
    const immoIngestCompleted = results.some((r) =>
      r &&
      r.actor_id === ACTOR_IMMO_DETAIL &&
      r.status === "SUCCEEDED" &&
      typeof r.portal === "string" &&
      /immobiliare_.*(enrich|refresh|autoenrich)/.test(r.portal) &&
      ((r.created ?? 0) + (r.updated ?? 0)) > 0
    );
    if (immoIngestCompleted) {
      try {
        // Evita di sovrapporre più batch: se c'è già un run immobiliare
        // detail/refresh RUNNING con meno di 2h di età, non lanciarne un altro.
        const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
        const { count: runningCount } = await sb.from("padova_apify_runs")
          .select("run_id", { count: "exact", head: true })
          .eq("status", "RUNNING")
          .eq("actor_id", ACTOR_IMMO_DETAIL)
          .gt("started_at", twoHoursAgo);
        if ((runningCount ?? 0) > 0) {
          backfillLaunches.push({ skipped: "already_running", running: runningCount });
        } else {
          for (let launched = 0; launched < agencyBackfillMaxLaunches; launched++) {
            // Seleziona URL candidati: portal immobiliare, agency null, non scaduti,
            // già presenti come detail (per non re-arricchire listview vuote) o legacy.
            const { data: candRows } = await sb.from("padova_collect_v2_items")
              .select("url")
              .eq("portal", "immobiliare")
              .is("agency", null)
              .in("parse_status", ["apify_immobiliare_detail", "radar_ingested"])
              .order("processed_at", { ascending: true, nullsFirst: true })
              .limit(agencyBackfillBatch);
            const urls = Array.from(new Set((candRows ?? [])
              .map((r: any) => r?.url).filter((u: any) => typeof u === "string" && u.length > 0)));
            if (urls.length === 0) {
              backfillLaunches.push({ skipped: "no_candidates" });
              break;
            }
            const { run_id: bRid, dataset_id: bDid } = await startRun(ACTOR_IMMO_DETAIL, {
              startUrls: urls.map((u) => ({ url: u })),
              maxItems: urls.length,
              includeAgencyDetails: false,
              proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
            }, token);
            await sb.from("padova_apify_runs").insert({
              portal: "immobiliare_agency_backfill",
              actor_id: ACTOR_IMMO_DETAIL,
              run_id: bRid,
              dataset_id: bDid,
              status: "RUNNING",
              cost_cap_usd: 0.30,
            });
            backfillLaunches.push({ run_id: bRid, urls: urls.length });
            console.log(`[collect-pending] agency-backfill launched run ${bRid} with ${urls.length} urls`);
          }
        }
      } catch (e) {
        backfillLaunches.push({ error: String((e as Error)?.message ?? e) });
        console.error("[collect-pending] agency-backfill failed:", (e as Error)?.message ?? e);
      }
    }
  }

  // ============ ZOMBIE CLEANUP ============
  // RUNNING più vecchi di zombieHours ma non più identificabili su Apify
  // (o comunque orfani) → marca TIMED_OUT per non re-processarli in eterno.
  let zombiesMarked = 0;
  if (!dryRun && zombieHours > 0) {
    const zombieCutoff = new Date(Date.now() - zombieHours * 3600_000).toISOString();
    const { data: zRows } = await sb.from("padova_apify_runs")
      .select("run_id,started_at").eq("status", "RUNNING").lt("started_at", zombieCutoff).limit(100);
    for (const z of zRows ?? []) {
      // Doppio check su Apify: se ancora RUNNING lato Apify, lascia stare.
      const d = await apifyRunStatus(z.run_id, token);
      if (d && d.status === "RUNNING") continue;
      const finalSt = d?.status ?? "TIMED_OUT";
      await sb.from("padova_apify_runs").update({
        status: finalSt,
        finished_at: d?.finishedAt ?? new Date().toISOString(),
      }).eq("run_id", z.run_id);
      zombiesMarked++;
    }
  }

  // ============ CONTRATTO SEMANTICO PER L'ORCHESTRATORE ============
  // Espone conteggi espliciti: nessun consumatore deve dedurre il successo
  // dalla sola presenza di un HTTP 200.
  const scanned = candidates.length;
  const terminalStates = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]);
  const importsCount = results.reduce(
    (acc, r) => acc + (Number(r?.created ?? 0) || 0) + (Number(r?.updated ?? 0) || 0),
    0,
  );
  const completedCount = results.filter((r) => r?.status === "SUCCEEDED").length;
  const stillRunning = results.filter((r) => r?.action === "still_running").length;
  const nonTerminal = results.filter(
    (r) => r?.status && !terminalStates.has(String(r.status)),
  ).length;
  const errorsCount = results.reduce(
    (acc, r) => acc + (Number(r?.errors ?? 0) || 0) + (r?.error ? 1 : 0),
    0,
  );
  const portalsCompleted = new Set(
    results
      .filter((r) => r?.status === "SUCCEEDED" && typeof r?.portal === "string")
      .map((r) => String(r.portal).split("_")[0]),
  );
  const missingPortals = requiredPortals.filter((p) => !portalsCompleted.has(p));
  const requiredPortalsComplete = missingPortals.length === 0;
  // Zero novità esplicita: catena completata, nessun errore, nessun import nuovo.
  const zeroNovelty = errorsCount === 0 && completedCount > 0 && importsCount === 0;

  const failures: string[] = [];
  if (requireCandidates && scanned === 0) failures.push("NO_CANDIDATES");
  if (requireTerminal && (stillRunning > 0 || nonTerminal > 0)) failures.push("NON_TERMINAL_RUNS");
  if (requiredPortals.length > 0 && !requiredPortalsComplete) failures.push("REQUIRED_PORTALS_INCOMPLETE");
  const ok = failures.length === 0;

  return new Response(JSON.stringify({
    ok,
    failures,
    scanned,
    completed_count: completedCount,
    still_running: stillRunning,
    imports_count: importsCount,
    errors: errorsCount,
    required_portals: requiredPortals,
    required_portals_complete: requiredPortalsComplete,
    missing_portals: missingPortals,
    zero_novelty: zeroNovelty,
    zombies_marked: zombiesMarked,
    agency_backfill: backfillLaunches, recompute: recomputeResult, results,
  }, null, 2), {
    status: ok ? 200 : 422,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

});

