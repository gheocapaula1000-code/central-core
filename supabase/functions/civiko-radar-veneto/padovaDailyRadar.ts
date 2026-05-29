// ═══════════════════════════════════════════════════════════════
// padovaDailyRadar — orchestratore mattutino multi-fonte per Padova
//
// Esegue server-side, in ordine, le pipeline che alimentano il radar:
//   1. refresh listing portali (Firecrawl + fallback Apify) → listing_price_snapshots
//   2. refresh aste (refresh-padova-auctions) → auction_signals (conferma)
//   3. Perplexity discovery (fonti pubbliche/istituzionali) → early_offmarket_signal_candidates
//   4. build-advanced-veneto-opportunities (velocity engine sui snapshot)
//   5. build-padova-early-warning (aggregator)
//   6. readiness snapshot
//
// HARD RULES:
//   - Nessun dato inventato. Nessun mock.
//   - Job secret letto solo da env, mai esposto al client.
//   - Se un provider fallisce ma altri funzionano → status PARTIAL_WITH_WARNINGS.
//   - Se nessuna nuova opportunità → status NO_NEW_SIGNALS.
//   - Nessun dato personale: top_opportunities espone solo campi aggregati.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPA_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPA_SR  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export interface DailyRadarOptions {
  dryRun?: boolean;
  skipListingRefresh?: boolean;
  skipPerplexity?: boolean;
}

interface StageResult {
  stage: string;
  ok: boolean;
  status: number;
  duration_ms: number;
  rows?: number;
  error?: string;
}

function fnUrl(path: string): string {
  return `${SUPA_URL}/functions/v1/${path.replace(/^\/+/, "")}`;
}

async function callStage(
  stage: string,
  url: string,
  body: unknown,
  jobSecret: string,
  timeoutMs = 90_000,
): Promise<StageResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    const rows = extractRowCount(parsed);
    return {
      stage,
      ok: r.ok,
      status: r.status,
      duration_ms: Date.now() - t0,
      rows,
      error: r.ok ? undefined : `http_${r.status}`,
    };
  } catch (e) {
    return {
      stage,
      ok: false,
      status: 0,
      duration_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(tm);
  }
}

function extractRowCount(p: unknown): number | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  for (const k of ["rows_out", "inserted", "hits", "imported", "count", "totale", "totals"]) {
    const v = o[k];
    if (typeof v === "number") return v;
  }
  return undefined;
}

interface Snapshot {
  total_active: number;
  non_auction: number;
  multi_source: number;
  high_confidence: number;
}

async function snapshotEarlyWarning(sb: ReturnType<typeof createClient>): Promise<Snapshot> {
  const { data } = await sb
    .from("early_warning_opportunities")
    .select("primary_signal_type, sources_count, confidence, is_active")
    .ilike("comune", "Padova")
    .eq("is_active", true)
    .range(0, 999);
  const rows = (data ?? []) as Array<{
    primary_signal_type: string;
    sources_count: number;
    confidence: string;
  }>;
  return {
    total_active: rows.length,
    non_auction: rows.filter((r) => r.primary_signal_type !== "AUCTION_CONFIRMATION").length,
    multi_source: rows.filter((r) => (r.sources_count ?? 0) >= 2).length,
    high_confidence: rows.filter((r) => r.confidence === "alta").length,
  };
}

async function topOpportunities(sb: ReturnType<typeof createClient>, limit = 5) {
  const { data } = await sb
    .from("early_warning_opportunities")
    .select("fingerprint, title, comune, microzona, area_label, primary_signal_type, signal_types, sources_count, evidence_count, confidence, early_acquisition_score, detected_at, updated_at, privacy_safe")
    .ilike("comune", "Padova")
    .eq("is_active", true)
    .eq("privacy_safe", true)
    .order("early_acquisition_score", { ascending: false })
    .limit(limit);
  // Never expose payload/source_urls in summary — keep it lean & privacy-safe
  return (data ?? []).map((r: Record<string, unknown>) => ({
    fingerprint: r.fingerprint,
    title: r.title,
    area: r.area_label ?? r.microzona ?? null,
    primary_signal_type: r.primary_signal_type,
    signal_types: r.signal_types,
    sources_count: r.sources_count,
    evidence_count: r.evidence_count,
    confidence: r.confidence,
    score: r.early_acquisition_score,
    updated_at: r.updated_at,
  }));
}

function commercialReadiness(snap: Snapshot, providerErrors: number, dailyRanRecently: boolean) {
  const checks499 = {
    non_auction_ok: snap.non_auction >= 10,
    multi_source_ok: snap.multi_source >= 5,
    high_conf_ok: snap.high_confidence >= 2,
    recent_run_ok: dailyRanRecently,
  };
  const checks990 = {
    non_auction_ok: snap.non_auction >= 15,
    multi_source_ok: snap.multi_source >= 7,
    high_conf_ok: snap.high_confidence >= 3,
    providers_ok: providerErrors === 0,
  };

  const ok499 = Object.values(checks499).every(Boolean);
  const ok990 = ok499 && Object.values(checks990).every(Boolean);

  let status = "PARTIAL_TECHNICAL";
  if (ok990) status = "READY_FOR_990_CONTROLLED_CLIENT";
  else if (ok499) status = "READY_FOR_499_CONTROLLED_CLIENT";

  return {
    status,
    missing_for_499: Object.entries(checks499).filter(([, v]) => !v).map(([k]) => k),
    missing_for_990: Object.entries(checks990).filter(([, v]) => !v).map(([k]) => k),
  };
}

export async function runPadovaDailyRadar(opts: DailyRadarOptions = {}) {
  const startedAt = new Date().toISOString();
  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const warnings: string[] = [];

  if (!SUPA_URL || !SUPA_SR) {
    return {
      ok: false,
      job: "padova-daily-radar",
      run_at: startedAt,
      status: "FAILED",
      error: "supabase_env_missing",
      stages: [], warnings: ["supabase_env_missing"],
    };
  }
  if (!jobSecret) {
    return {
      ok: false,
      job: "padova-daily-radar",
      run_at: startedAt,
      status: "FAILED",
      error: "CENTRAL_CORE_JOB_SECRET not configured",
      stages: [], warnings: ["job_secret_missing"],
    };
  }

  const sb = createClient(SUPA_URL, SUPA_SR, { auth: { persistSession: false } });

  // ── Snapshot PRIMA ──
  const before = await snapshotEarlyWarning(sb);

  const stages: StageResult[] = [];

  // Stage 1 — refresh listing portali (Firecrawl + fallback Apify) per Padova
  if (!opts.skipListingRefresh) {
    const s = await callStage(
      "refresh-listings",
      fnUrl("civiko-radar-veneto/jobs/deep-scan-padova"),
      { comune: "Padova" },
      jobSecret,
      120_000,
    );
    stages.push(s);
    if (!s.ok) warnings.push(`listings_refresh_failed:${s.status}`);
  } else {
    warnings.push("listings_refresh_skipped");
  }

  // Stage 1b — fonte istituzionale Padova (Comune patrimonio / avvisi pubblici)
  // Volume basso ma legalmente difendibile → seconda source_name distinta.
  try {
    const t0 = Date.now();
    const { runComunePadovaPatrimonio } = await import("./comunePadovaPatrimonio.ts");
    const r = await runComunePadovaPatrimonio();
    stages.push({
      stage: "institutional-comune-padova",
      ok: r.ok,
      status: r.ok ? 200 : 207,
      duration_ms: Date.now() - t0,
      rows: r.items_inserted,
      error: r.ok ? undefined : (r.errors[0] ?? "partial"),
    });
    if (r.warnings.length) warnings.push(...r.warnings.map((w) => `comune_padova:${w}`));
  } catch (e) {
    stages.push({
      stage: "institutional-comune-padova",
      ok: false, status: 0, duration_ms: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    warnings.push("comune_padova_failed");
  }

  // Stage 2 — refresh aste Padova (conferma, non valore primario)
  const sAuc = await callStage(
    "refresh-auctions",
    fnUrl("civiko-radar-veneto/jobs/refresh-padova-auctions"),
    { dryRun: opts.dryRun === true, includeNeedsReview: false, maxPagesPerSource: 6 },
    jobSecret,
    180_000,
  );
  stages.push(sAuc);
  if (!sAuc.ok) warnings.push(`auctions_refresh_failed:${sAuc.status}`);

  // Stage 3 — Perplexity discovery (fonti pubbliche/istituzionali)
  if (!opts.skipPerplexity) {
    const sPx = await callStage(
      "perplexity-discovery",
      fnUrl("civiko-radar-veneto/jobs/perplexity-deep-padova"),
      {},
      jobSecret,
      120_000,
    );
    stages.push(sPx);
    if (!sPx.ok) warnings.push(`perplexity_discovery_failed:${sPx.status}`);
  } else {
    warnings.push("perplexity_skipped");
  }

  // Stage 3b — ping snapshot dei listing noti (max ~40, sequenziale 1.5s/req)
  // Mantiene giorni_online monotòno e produce segnale di delisting dopo 2 fallimenti.
  const sPing = await callStage(
    "ping-padova-snapshots",
    fnUrl("civiko-radar-veneto/jobs/ping-padova-snapshots"),
    {},
    jobSecret,
    150_000,
  );
  stages.push(sPing);
  if (!sPing.ok) warnings.push(`ping_snapshots_failed:${sPing.status}`);

  // Stage 4 — velocity engine (price drop / stale / repost dai snapshot)
  const sAdv = await callStage(
    "advanced-opportunities",
    fnUrl("civiko-radar-veneto/jobs/build-advanced-veneto-opportunities"),
    { doImport: !opts.dryRun, province: ["PD"] },
    jobSecret,
    120_000,
  );
  stages.push(sAdv);
  if (!sAdv.ok) warnings.push(`advanced_opportunities_failed:${sAdv.status}`);

  // Stage 4b — Legal & life-event signals layer (privacy-safe aggregator)
  try {
    const t0 = Date.now();
    const { refreshPadovaLegalLifeEvents } = await import("./legalLifeEvents.ts");
    const rLle = await refreshPadovaLegalLifeEvents({ dryRun: opts.dryRun === true });
    stages.push({
      stage: "legal-life-events",
      ok: rLle.ok,
      status: rLle.ok ? 200 : 207,
      duration_ms: Date.now() - t0,
      rows: rLle.found,
      error: rLle.ok ? undefined : (rLle.warnings[0] ?? "partial"),
    });
    if (rLle.warnings.length) warnings.push(...rLle.warnings.map((w) => `legal_life_events:${w}`));
  } catch (e) {
    stages.push({
      stage: "legal-life-events",
      ok: false, status: 0, duration_ms: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    warnings.push("legal_life_events_failed");
  }

  // Stage 5 — Early Warning aggregator
  const sEw = await callStage(
    "build-early-warning",
    fnUrl("civiko-radar-veneto/jobs/build-padova-early-warning"),
    { dryRun: opts.dryRun === true },
    jobSecret,
    120_000,
  );
  stages.push(sEw);
  if (!sEw.ok) warnings.push(`early_warning_failed:${sEw.status}`);

  // ── Snapshot DOPO ──
  const after = await snapshotEarlyWarning(sb);
  const top = await topOpportunities(sb, 5);

  // ── Diff & status ──
  const newOpps = Math.max(0, after.total_active - before.total_active);
  const failed = stages.filter((s) => !s.ok).length;
  const providerErrors = stages
    .filter((s) => ["refresh-listings", "perplexity-discovery", "refresh-auctions"].includes(s.stage) && !s.ok)
    .length;

  let status: "NO_NEW_SIGNALS" | "NEW_SIGNALS" | "PARTIAL_WITH_WARNINGS" | "FAILED";
  if (failed === stages.length) status = "FAILED";
  else if (failed > 0) status = "PARTIAL_WITH_WARNINGS";
  else if (newOpps > 0 || after.high_confidence > before.high_confidence) status = "NEW_SIGNALS";
  else status = "NO_NEW_SIGNALS";

  // Has a daily run completed in last 7 days? (the current run counts)
  const dailyRanRecently = status !== "FAILED";

  const commercial = commercialReadiness(after, providerErrors, dailyRanRecently);

  // Persist run trace (best-effort, never fail the job for this)
  try {
    await sb.from("ingestion_runs").insert({
      job_name: "padova-daily-radar",
      status: status === "FAILED" ? "failed" : "completed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      rows_out: newOpps,
      errors: warnings.length ? { warnings } : null,
    });
  } catch (_e) { /* trace optional */ }

  return {
    ok: status !== "FAILED",
    job: "padova-daily-radar",
    run_at: startedAt,
    status,
    summary: {
      new_opportunities: newOpps,
      updated_opportunities: Math.max(0, after.total_active),
      high_confidence: after.high_confidence,
      multi_source: after.multi_source,
      non_auction: after.non_auction,
      auction_confirmations: Math.max(0, after.total_active - after.non_auction),
      provider_errors: providerErrors,
    },
    before, after,
    top_opportunities: top,
    readiness: {
      technical: status === "FAILED" ? "FAILED" : (after.non_auction > 0 ? "OPERATIONAL" : "EMPTY"),
      commercial: commercial.status,
      missing_for_499: commercial.missing_for_499,
      missing_for_990: commercial.missing_for_990,
    },
    stages: stages.map((s) => ({
      stage: s.stage, ok: s.ok, status: s.status,
      duration_ms: s.duration_ms, rows: s.rows ?? null,
      error: s.error ?? null,
    })),
    warnings,
    finished_at: new Date().toISOString(),
  };
}
