// ═══════════════════════════════════════════════════════════════
// auctionRunStore — persistenza async per discovery aste Veneto.
// Usa service_role. Niente bypass. Nessun import in auction_signals
// se non tramite endpoint dedicato.
// ═══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { discoverVenetoAuctions, type DiscoverRequest, type DiscoverReport } from "./auctionDiscovery.ts";
import type { AuctionCandidate } from "./auctionParser.ts";

function admin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface StartResult {
  ok: true;
  run_id: string;
  status: "queued" | "running";
  message: string;
}

export async function startAuctionDiscoveryRun(
  params: DiscoverRequest,
  createdBy?: string,
): Promise<StartResult> {
  const sb = admin();
  // Force dryRun=true at this layer; import is a separate endpoint.
  const safeParams: DiscoverRequest = { ...params, dryRun: true, import: false };

  const { data, error } = await sb
    .from("auction_discovery_runs")
    .insert({
      status: "running",
      params: safeParams,
      created_by: createdBy ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`run_insert_failed:${error?.message ?? "no_data"}`);

  const runId = data.id as string;

  // Background execution. EdgeRuntime.waitUntil keeps the worker alive.
  const job = (async () => {
    const startedAt = Date.now();
    try {
      const report: DiscoverReport = await discoverVenetoAuctions(safeParams);
      await persistCandidatesFromReport(sb, runId, report);
      await sb.from("auction_discovery_runs").update({
        status: report.errors.length > 0 ? "partial" : "succeeded",
        finished_at: new Date().toISOString(),
        report: report as unknown as Record<string, unknown>,
        sources: report.per_source as unknown as Record<string, unknown>[],
        candidates_count: report.candidates_found,
        importable_count: report.candidates_importable,
        needs_review_count: report.candidates_needs_review,
        errors: report.errors,
        warnings: report.warnings,
      }).eq("id", runId);
      console.log(`[auction-run ${runId}] done in ${Date.now() - startedAt}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from("auction_discovery_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        errors: [msg.slice(0, 400)],
      }).eq("id", runId);
      console.error(`[auction-run ${runId}] failed:`, msg);
    }
  })();

  // @ts-ignore EdgeRuntime is provided by Supabase Edge runtime.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(job);
  } else {
    // fallback: run detached (best-effort).
    job.catch((e) => console.error("auction-run detached error", e));
  }

  return { ok: true, run_id: runId, status: "running", message: "Discovery started in background." };
}

async function persistCandidatesFromReport(
  sb: ReturnType<typeof admin>,
  runId: string,
  report: DiscoverReport,
) {
  // Phase 1 (this turn): persist the report's three sample sets. The discovery
  // module currently only exposes samples; full candidate list will be wired
  // in a follow-up turn.
  const importable: AuctionCandidate[] = report.sample_candidates ?? [];
  const needsReview: AuctionCandidate[] = report.sample_needs_review ?? [];

  const rows = [
    ...importable.map((c) => mapCandidate(runId, c, "importable")),
    ...needsReview.map((c) => mapCandidate(runId, c, "needs_review")),
  ];
  if (rows.length === 0) return;
  const { error } = await sb
    .from("auction_discovery_candidates")
    .upsert(rows, { onConflict: "run_id,fingerprint", ignoreDuplicates: true });
  if (error) {
    report.warnings.push(`candidate_persist_warn:${error.message}`.slice(0, 200));
  }
}

function mapCandidate(
  runId: string,
  c: AuctionCandidate,
  status: "importable" | "needs_review" | "rejected",
) {
  return {
    run_id: runId,
    source_name: c.source_name,
    source_url: c.source_url,
    title: (c.payload?.title as string | undefined) ?? null,
    comune: c.comune,
    provincia: c.province,
    tribunal: c.tribunal,
    auction_date: c.auction_date,
    base_price: c.base_price,
    minimum_offer: c.minimum_offer,
    asset_type: c.asset_type,
    lot_number: c.lot_number,
    procedure_number: c.procedure_number,
    pdf_url: c.pdf_url ?? null,
    confidence_score: c.confidence_score,
    quality: c.quality,
    data_basis: c.data_basis,
    privacy_redacted: c.privacy_redacted,
    status,
    reject_reason: null,
    payload: c.payload ?? {},
    fingerprint: c.fingerprint,
  };
}

export async function getAuctionDiscoveryRun(runId: string) {
  const sb = admin();
  const { data: run, error } = await sb
    .from("auction_discovery_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`run_read_failed:${error.message}`);
  if (!run) return { ok: false, error: "RUN_NOT_FOUND" as const };

  const { count: total } = await sb
    .from("auction_discovery_candidates")
    .select("id", { head: true, count: "exact" })
    .eq("run_id", runId);
  const { count: imp } = await sb
    .from("auction_discovery_candidates")
    .select("id", { head: true, count: "exact" })
    .eq("run_id", runId).eq("status", "importable");
  const { count: nr } = await sb
    .from("auction_discovery_candidates")
    .select("id", { head: true, count: "exact" })
    .eq("run_id", runId).eq("status", "needs_review");

  return {
    ok: true as const,
    run_id: runId,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    candidates_persisted: total ?? 0,
    importable_persisted: imp ?? 0,
    needs_review_persisted: nr ?? 0,
    report: run.report,
    errors: run.errors,
    warnings: run.warnings,
  };
}

export interface ImportRequest {
  run_id: string;
  minConfidence?: number;
  includeNeedsReview?: boolean;
  maxImportRecords?: number;
}

export async function importAuctionCandidates(req: ImportRequest) {
  const sb = admin();
  const minConf = Math.max(0.5, req.minConfidence ?? 0.7);
  const maxRec = Math.min(req.maxImportRecords ?? 50, 200);
  const includeNR = req.includeNeedsReview === true;

  const statuses = includeNR ? ["importable", "needs_review"] : ["importable"];
  const { data: cands, error } = await sb
    .from("auction_discovery_candidates")
    .select("*")
    .eq("run_id", req.run_id)
    .in("status", statuses)
    .gte("confidence_score", minConf)
    .limit(maxRec);
  if (error) throw new Error(`candidates_read_failed:${error.message}`);

  const list = cands ?? [];
  let inserted = 0, skipped_dup = 0, skipped_invalid = 0;
  for (const c of list) {
    if (!c.provincia || !c.comune) { skipped_invalid++; continue; }
    // Dedup vs auction_signals.fingerprint
    const { data: existing } = await sb
      .from("auction_signals")
      .select("id")
      .eq("fingerprint", c.fingerprint)
      .maybeSingle();
    if (existing) { skipped_dup++; continue; }

    const { error: insErr } = await sb.from("auction_signals").insert({
      fingerprint: c.fingerprint,
      source_name: c.source_name,
      source_url: c.source_url,
      province: c.provincia,
      municipality: c.comune,
      base_price_eur: c.base_price,
      minimum_offer_eur: c.minimum_offer,
      sale_date: c.auction_date,
      property_type: c.asset_type,
      status: "active",
      data_basis: Array.isArray(c.data_basis) ? c.data_basis.join(",") : String(c.data_basis ?? ""),
      quality: c.quality ?? "parziale",
      payload: {
        ...(c.payload ?? {}),
        tribunal: c.tribunal,
        lot_number: c.lot_number,
        procedure_number: c.procedure_number,
        pdf_url: c.pdf_url,
        from_run: req.run_id,
        candidate_id: c.id,
      },
      is_active: true,
    });
    if (insErr) { skipped_invalid++; continue; }
    inserted++;
  }

  return {
    ok: true as const,
    run_id: req.run_id,
    candidates_examined: list.length,
    inserted,
    skipped_duplicates: skipped_dup,
    skipped_invalid,
    min_confidence: minConf,
    include_needs_review: includeNR,
  };
}
