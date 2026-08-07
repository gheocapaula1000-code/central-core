// civiko-commissioning
// ---------------------------------------------------------------------------
// Endpoint amministrativo ADDITIVO e ISOLATO, dedicato esclusivamente al
// commissioning di Civiko One. Non modifica né referenzia il comportamento, il
// contratto o l'allowlist di UEradar/TrovaBandi, Wyloni, LuxuRadar o altre PWA.
// Le azioni normali del Central Core restano invariate: qui non ne viene
// ridefinita nessuna.
//
// Auth: Authorization: Bearer <CIVIKO_ORCHESTRATOR_DISPATCH_SECRET>
//       (lo stesso secret dell'orchestrator Civiko), confronto timing-safe,
//       fail-closed. Nessun secret viene mai loggato o restituito.
//
// Schema chiuso: nessun URL, body, target o cap arbitrario dal client.
// I cap sono costanti server-side minime e non aumentabili (caps.ts).
//
// Nessun cron viene creato o attivato da questa funzione.

import {
  capExactlyApplied,
  CIVIKO_COMMISSIONING_ACTIONS,
  CIVIKO_COMMISSIONING_CAPS,
  CIVIKO_COMMISSIONING_CLAIM_TTL_SECONDS,
  type CivikoCommissioningProvider,
  type CivikoCommissioningStatus,
  validateCommissioningBody,
} from "./caps.ts";
import { canSpendFirecrawl, recordFirecrawlSpend } from "../_shared/firecrawlBudget.ts";
import { canSpendAi, recordAiSpend } from "../_shared/aiBudget.ts";
import { CIVIKO_COMMERCIAL_ZONES } from "../_shared/civikoCommercialZoneContract.ts";

const DISPATCH_SECRET = Deno.env.get("CIVIKO_ORCHESTRATOR_DISPATCH_SECRET") ?? "";
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const CIVIKO_APP_SECRET = Deno.env.get("AI_CORE_SECRET_CIVIKO") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 1024;
const HTTP_TIMEOUT_MS = 20_000;
const CHAIN_STEP_TIMEOUT_MS = 30_000;

// Le otto zone ufficiali Padova restano identiche: qui vengono soltanto lette
// dal contratto condiviso, mai ridefinite.
const CIVIKO_SCOPE_SLUGS = CIVIKO_COMMERCIAL_ZONES.map((z) => z.slug);

// Target di micro-run: costanti, pubblici e Padova-only.
// Il micro-run Apify NON avvia l'actor direttamente: passa dal collector
// Civiko esistente `padova-apify-subito-collect` (budget + padova_apify_runs +
// ingest in padova_collect_v2_items). Singola URL Padova.
const APIFY_MICRORUN_COLLECTOR = "padova-apify-subito-collect";
const APIFY_MICRORUN_SEARCH_URL =
  "https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/";
// Attesa minima controllata del collector (sync), sotto il limite HTTP.
const APIFY_COLLECT_WAIT_SECONDS = 150;
const APIFY_COLLECT_TIMEOUT_MS = 170_000;

const FIRECRAWL_MICRORUN_URL = "https://www.comune.padova.it/";
const PERPLEXITY_MICRORUN_MODEL = "sonar";
const PERPLEXITY_MICRORUN_QUERY =
  "Elenca in una riga la data dell'ultimo aggiornamento pubblico del portale del Comune di Padova.";

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function restFetch(
  pathAndQuery: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response | null> {
  if (!SERVICE_KEY || !SUPABASE_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      ...init,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function realCount(pathAndQuery: string): Promise<number | null> {
  const res = await restFetch(pathAndQuery, { method: "HEAD", headers: { Prefer: "count=exact", Range: "0-0" } });
  if (!res || (!res.ok && res.status !== 206)) return null;
  const total = (res.headers.get("content-range") ?? "").split("/")[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

async function realRows(pathAndQuery: string): Promise<Record<string, unknown>[] | null> {
  const res = await restFetch(pathAndQuery);
  if (!res || !res.ok) return null;
  const payload = await res.json().catch(() => null);
  return Array.isArray(payload)
    ? payload.filter((r) => r && typeof r === "object" && !Array.isArray(r))
    : null;
}

async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<boolean> {
  if (!rows.length) return true;
  const res = await restFetch(table, { method: "POST", body: JSON.stringify(rows) });
  return Boolean(res && res.ok);
}

async function patchRow(pathAndQuery: string, patch: Record<string, unknown>): Promise<boolean> {
  const res = await restFetch(pathAndQuery, { method: "PATCH", body: JSON.stringify(patch) });
  return Boolean(res && res.ok);
}

async function rpc(name: string, args: Record<string, unknown>, timeoutMs = HTTP_TIMEOUT_MS): Promise<
  { ok: boolean; status: number; payload: unknown }
> {
  const res = await restFetch(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) }, timeoutMs);
  if (!res) return { ok: false, status: 502, payload: null };
  const payload = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, payload };
}

// ───────────────────────── baseline (read-only) ─────────────────────────────

const SCOPE_IN = `in.(${CIVIKO_SCOPE_SLUGS.join(",")})`;

async function captureCounters(): Promise<{
  counters: Record<string, unknown>;
  failed: string[];
}> {
  const failed: string[] = [];
  const q = async (key: string, path: string) => {
    const n = await realCount(path);
    if (n === null) failed.push(key);
    return n;
  };

  const [
    listingsTotal,
    listingsActive,
    listingsImmobiliare,
    listingsIdealista,
    listingsSubito,
    listingsCasa,
    contendibili,
    multiPortale,
    classificati,
    ribassi,
    offmarket,
    cambiAgenzia,
    providerRuns,
  ] = await Promise.all([
    q("listings_total", "padova_listings?select=id"),
    // Schema reale: padova_listings NON ha `stato`. Attivo = expired_at IS NULL.
    q("listings_active", "padova_listings?select=id&expired_at=is.null"),
    q("listings_immobiliare", "padova_listings?select=id&fonte=eq.immobiliare"),
    q("listings_idealista", "padova_listings?select=id&fonte=eq.idealista"),
    q("listings_subito", "padova_listings?select=id&fonte=eq.subito"),
    q("listings_casa", "padova_listings?select=id&fonte=eq.casa"),
    q("contendibili", `padova_contendibili?select=id&commercial_zone_slug=${SCOPE_IN}`),
    q("multi_portale", "padova_multi_portale?select=id"),
    q("signals_classified", "civiko_signals_classified?select=id"),
    q("ribassi_price_history", "padova_listings_price_history?select=id"),
    q("offmarket_scores", "offmarket_opportunity_scores?select=id"),
    q("cambi_agenzia", "padova_cambi_agenzia?select=id"),
    q("provider_runs", "padova_apify_runs?select=id"),
  ]);

  // Schema reale: i timestamp di padova_listings sono imported_at/last_seen_at
  // (nessun created_at/updated_at).
  const lastListing = await realRows(
    "padova_listings?select=imported_at,last_seen_at,expired_at&order=last_seen_at.desc.nullslast&limit=1",
  );
  // Schema reale: padova_apify_runs usa started_at/finished_at.
  const lastProviderRun = await realRows(
    "padova_apify_runs?select=id,run_id,portal,status,started_at,finished_at&order=started_at.desc.nullslast&limit=1",
  );
  // Schema reale: civiko_pwa_sync_acks usa started_at/finished_at/created_at,
  // counts, scope_comune/scope_slugs e municipality/commercial_zone_slugs.
  const lastAck = await realRows(
    "civiko_pwa_sync_acks?select=run_id,pipeline_run_id,ok,started_at,finished_at,created_at,counts,scope_comune,scope_slugs,municipality,commercial_zone_slugs&order=created_at.desc&limit=1",
  );
  if (lastListing === null) failed.push("last_listing");
  if (lastProviderRun === null) failed.push("last_provider_run");
  if (lastAck === null) failed.push("last_pwa_sync_ack");

  return {
    counters: {
      listings: {
        total: listingsTotal,
        active: listingsActive,
        by_fonte: {
          immobiliare: listingsImmobiliare,
          idealista: listingsIdealista,
          subito: listingsSubito,
          casa: listingsCasa,
        },
        last_imported_at: lastListing?.[0]?.imported_at ?? null,
        last_seen_at: lastListing?.[0]?.last_seen_at ?? null,
        last_expired_at: lastListing?.[0]?.expired_at ?? null,
      },
      categories: {
        contendibili,
        multi_portale: multiPortale,
        classificazione: classificati,
        ribassi: ribassi,
        off_market: offmarket,
        cambi_agenzia: cambiAgenzia,
      },
      provider_runs: {
        total: providerRuns,
        last: lastProviderRun?.[0] ?? null,
      },
      pwa_sync: { last_ack: lastAck?.[0] ?? null },
      commercial_zone_slugs: CIVIKO_SCOPE_SLUGS,
    },
    failed,
  };
}

async function persistBaseline(): Promise<{ snapshotId: string; counters: Record<string, unknown>; failed: string[] } | null> {
  const { counters, failed } = await captureCounters();
  const snapshotId = crypto.randomUUID();
  const ok = await insertRows("civiko_commissioning_baselines", [{
    snapshot_id: snapshotId,
    captured_at: new Date().toISOString(),
    counters,
    complete: failed.length === 0,
    failed_queries: failed,
  }]);
  if (!ok) return null;
  return { snapshotId, counters, failed };
}

// ───────────────────────── audit + claim ────────────────────────────────────

interface RunRecord {
  runId: string;
  provider: string;
  action: string;
  startedAt: string;
  baselineSnapshotId: string | null;
  requestedCap: Record<string, number>;
}

async function openRun(rec: RunRecord): Promise<boolean> {
  return await insertRows("civiko_commissioning_runs", [{
    run_id: rec.runId,
    provider: rec.provider,
    action: rec.action,
    status: "RUNNING" as CivikoCommissioningStatus,
    requested_cap: rec.requestedCap,
    applied_cap: null,
    baseline_snapshot_id: rec.baselineSnapshotId,
    started_at: rec.startedAt,
  }]);
}

async function closeRun(
  runId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  return await patchRow(`civiko_commissioning_runs?run_id=eq.${runId}`, {
    ...patch,
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function claim(provider: string, runId: string): Promise<boolean> {
  const r = await rpc("civiko_commissioning_claim", {
    p_provider: provider,
    p_run_id: runId,
    p_ttl_seconds: CIVIKO_COMMISSIONING_CLAIM_TTL_SECONDS,
  });
  return r.ok && r.payload === true;
}

async function releaseClaim(provider: string, runId: string): Promise<void> {
  await rpc("civiko_commissioning_release_claim", { p_provider: provider, p_run_id: runId });
}

interface Artifact {
  table_name: string;
  change_kind: "insert" | "update";
  row_ref: string;
  evidence: Record<string, unknown>;
}

async function persistArtifacts(
  runId: string,
  provider: string,
  artifacts: Artifact[],
): Promise<boolean> {
  if (!artifacts.length) return true;
  return await insertRows(
    "civiko_commissioning_artifacts",
    artifacts.slice(0, 50).map((a) => ({
      run_id: runId,
      provider,
      table_name: a.table_name,
      change_kind: a.change_kind,
      row_ref: a.row_ref,
      evidence: a.evidence,
    })),
  );
}

// ───────────────────────── adapter provider (cap-confirmed) ─────────────────

interface AdapterOutcome {
  status: CivikoCommissioningStatus;
  applied_cap: Record<string, number> | null;
  cap_confirmed: boolean;
  actual_cost_usd: number;
  counters: Record<string, unknown>;
  artifacts: Artifact[];
  error_code: string | null;
}

/**
 * Micro-run Apify Civiko.
 *
 * NON avvia mai l'actor direttamente: usa esclusivamente il percorso Civiko
 * esistente `padova-apify-subito-collect` (che internamente chiama
 * `startApifyRun`), l'unico che applica la budget guard, registra la riga in
 * `padova_apify_runs` e importa il dataset in `padova_collect_v2_items`.
 *
 * Il collector NON viene modificato: riceve soltanto i parametri già previsti
 * dal suo contratto (search_urls, max_items, wait_seconds), con max_items
 * imposto server-side dal cap Civiko e nessun dry_run.
 */
async function apifyMicroRun(runId: string): Promise<AdapterOutcome> {
  const requested = {
    max_items: CIVIKO_COMMISSIONING_CAPS.apify.max_items,
    max_total_charge_usd: CIVIKO_COMMISSIONING_CAPS.apify.max_total_charge_usd,
  };
  const base: AdapterOutcome = {
    status: "BLOCKED",
    applied_cap: null,
    cap_confirmed: false,
    actual_cost_usd: 0,
    counters: {},
    artifacts: [],
    error_code: null,
  };
  if (!JOB_SECRET) return { ...base, error_code: "job_secret_missing" };
  if (!SUPABASE_URL) return { ...base, error_code: "supabase_url_missing" };

  // Coerenza cap ↔ costo reale del percorso Civiko: 5 USD / 1000 item.
  const expectedCapUsd = Number(((requested.max_items * 5) / 1000).toFixed(3));
  if (expectedCapUsd !== requested.max_total_charge_usd) {
    return { ...base, error_code: "apify_cap_formula_mismatch" };
  }

  let collect: Record<string, unknown> | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIFY_COLLECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${APIFY_MICRORUN_COLLECTOR}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": JOB_SECRET,
      },
      // Attesa minima controllata, nessun dry_run, nessun async_start:
      // il micro-run reale deve arrivare fino all'ingest.
      body: JSON.stringify({
        search_urls: [APIFY_MICRORUN_SEARCH_URL],
        max_items: requested.max_items,
        wait_seconds: APIFY_COLLECT_WAIT_SECONDS,
      }),
      signal: controller.signal,
    });
    collect = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      return {
        ...base,
        status: res.status === 429 || res.status === 409 ? "BLOCKED" : "FAILED",
        counters: { collector_http_status: res.status, collector_reason: collect?.reason ?? collect?.skipped_reason ?? null },
        error_code: `apify_collect_http_${res.status}`,
      };
    }
  } catch {
    return { ...base, status: "FAILED", error_code: "apify_collect_unreachable" };
  } finally {
    clearTimeout(timer);
  }

  const apifyRunId = typeof collect?.run_id === "string" ? collect.run_id : null;
  const jobId = typeof collect?.job_id === "string" ? collect.job_id : null;
  const created = Number(collect?.created ?? NaN);
  const updated = Number(collect?.updated ?? NaN);
  if (!apifyRunId) {
    return { ...base, status: "FAILED", error_code: "apify_collect_no_run_id" };
  }

  // Cap applicato: riletto dalla riga realmente persistita dal percorso Civiko
  // (nessun echo provider inventato).
  const runRows = await realRows(
    `padova_apify_runs?run_id=eq.${encodeURIComponent(apifyRunId)}` +
      `&select=id,run_id,portal,status,cost_cap_usd,cost_usd,items_count,imported,started_at,finished_at&limit=1`,
  );
  const runRow = runRows?.[0] ?? null;
  if (!runRow) {
    return {
      ...base,
      status: "BLOCKED",
      counters: { apify_run_id: apifyRunId, job_id: jobId },
      error_code: "apify_run_row_missing",
    };
  }
  const applied = {
    max_items: requested.max_items,
    max_total_charge_usd: Number(runRow.cost_cap_usd ?? NaN),
  };
  const capConfirmed = capExactlyApplied(requested, applied);
  if (!capConfirmed) {
    return {
      ...base,
      status: "BLOCKED",
      applied_cap: Number.isFinite(applied.max_total_charge_usd) ? applied : null,
      counters: { apify_run_id: apifyRunId, job_id: jobId },
      error_code: "apify_cap_not_confirmed",
    };
  }

  const runSucceeded = String(runRow.status ?? "") === "SUCCEEDED";
  const stagingRows = jobId
    ? await realCount(`padova_collect_v2_items?select=id&job_id=eq.${encodeURIComponent(jobId)}`)
    : null;
  const writesOk = Number.isFinite(created) && Number.isFinite(updated) && (created + updated) > 0;
  const stagingOk = runSucceeded && Boolean(jobId) && (stagingRows ?? 0) > 0 && writesOk;

  const actualCostUsd = Number.isFinite(Number(runRow.cost_usd))
    ? Number(runRow.cost_usd)
    : Number(applied.max_total_charge_usd);

  const counters: Record<string, unknown> = {
    apify_run_id: apifyRunId,
    dataset_id: typeof collect?.dataset_id === "string" ? collect.dataset_id : null,
    job_id: jobId,
    run_status: runRow.status ?? null,
    dataset_size: Number.isFinite(Number(collect?.dataset_size)) ? Number(collect?.dataset_size) : null,
    created: Number.isFinite(created) ? created : null,
    updated: Number.isFinite(updated) ? updated : null,
    staging_rows_for_job: stagingRows,
    // Staging persistito ≠ PWA-ready: la promozione a padova_listings richiede
    // un processor globale non isolabile per questo run, quindi non viene
    // invocata e l'attivazione non è consentita da questo micro-run.
    staging_persisted: stagingOk,
    pwa_ready: false,
    activation_allowed: false,
    promotion_note:
      "righe persistite in padova_collect_v2_items (staging); promozione a padova_listings non eseguita: processor non isolabile per run Civiko",
  };

  if (!stagingOk) {
    return {
      ...base,
      status: runSucceeded ? "PARTIAL" : "PARTIAL",
      applied_cap: applied,
      cap_confirmed: true,
      actual_cost_usd: actualCostUsd,
      counters,
      error_code: !runSucceeded ? "apify_run_not_succeeded" : "apify_staging_rows_missing",
    };
  }

  return {
    status: "SUCCESS",
    applied_cap: applied,
    cap_confirmed: true,
    actual_cost_usd: actualCostUsd,
    counters,
    artifacts: [{
      table_name: "padova_collect_v2_items",
      change_kind: created > 0 ? "insert" : "update",
      row_ref: String(jobId),
      evidence: {
        provider: "apify",
        commissioning_run_id: runId,
        apify_run_id: apifyRunId,
        job_id: jobId,
        created,
        updated,
        rows_for_job: stagingRows,
        pwa_ready: false,
      },
    }],
    error_code: null,
  };
}


async function firecrawlMicroRun(runId: string): Promise<AdapterOutcome> {
  const requested = {
    max_pages: CIVIKO_COMMISSIONING_CAPS.firecrawl.max_pages,
    max_credits: CIVIKO_COMMISSIONING_CAPS.firecrawl.max_credits,
  };
  const base: AdapterOutcome = {
    status: "BLOCKED",
    applied_cap: null,
    cap_confirmed: false,
    actual_cost_usd: 0,
    counters: {},
    artifacts: [],
    error_code: null,
  };
  const key = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!key) return { ...base, error_code: "firecrawl_key_missing" };

  const budget = await canSpendFirecrawl(requested.max_pages);
  if (!budget.ok) return { ...base, error_code: budget.reason ?? "firecrawl_budget_cap_reached" };

  let payload: Record<string, unknown> | null = null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // /v1/scrape è single-page per contratto: una pagina, un credito.
      body: JSON.stringify({
        url: FIRECRAWL_MICRORUN_URL,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });
    if (!res.ok) return { ...base, status: "FAILED", error_code: `firecrawl_http_${res.status}` };
    payload = await res.json().catch(() => null) as Record<string, unknown> | null;
  } catch {
    return { ...base, status: "FAILED", error_code: "firecrawl_error" };
  }
  if (!payload || payload.success === false) {
    return { ...base, status: "FAILED", error_code: "firecrawl_invalid_response" };
  }

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const creditsRaw = payload.creditsUsed ?? data.creditsUsed;
  const creditsUsed = Number(creditsRaw ?? requested.max_credits);
  const applied = { max_pages: 1, max_credits: Number.isFinite(creditsUsed) ? creditsUsed : NaN };
  const confirmed = capExactlyApplied(requested, applied);
  if (!confirmed) {
    return {
      ...base,
      status: "BLOCKED",
      applied_cap: Number.isFinite(applied.max_credits) ? applied : null,
      error_code: "firecrawl_cap_not_confirmed",
    };
  }

  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  try {
    await recordFirecrawlSpend(requested.max_pages, 1, { portal: "civiko_commissioning" } as never);
  } catch { /* best effort */ }

  return {
    status: "SUCCESS",
    applied_cap: applied,
    cap_confirmed: true,
    actual_cost_usd: Number((requested.max_pages * 0.001).toFixed(4)),
    counters: { pages: 1, markdown_chars: markdown.length },
    artifacts: [{
      table_name: "civiko_commissioning_artifacts",
      change_kind: "insert",
      row_ref: FIRECRAWL_MICRORUN_URL,
      evidence: {
        provider: "firecrawl",
        commissioning_run_id: runId,
        markdown_chars: markdown.length,
        http_ok: true,
      },
    }],
    error_code: null,
  };
}

async function perplexityMicroRun(runId: string): Promise<AdapterOutcome> {
  const requested = {
    max_queries: CIVIKO_COMMISSIONING_CAPS.perplexity.max_queries,
    max_completion_tokens: CIVIKO_COMMISSIONING_CAPS.perplexity.max_completion_tokens,
  };
  const base: AdapterOutcome = {
    status: "BLOCKED",
    applied_cap: null,
    cap_confirmed: false,
    actual_cost_usd: 0,
    counters: {},
    artifacts: [],
    error_code: null,
  };
  const key = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
  if (!key) return { ...base, error_code: "perplexity_key_missing" };

  const budget = await canSpendAi(requested.max_completion_tokens * 4, "perplexity");
  if (!budget.ok) return { ...base, error_code: budget.reason ?? "ai_budget_cap_reached" };

  let payload: Record<string, unknown> | null = null;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PERPLEXITY_MICRORUN_MODEL,
        messages: [{ role: "user", content: PERPLEXITY_MICRORUN_QUERY }],
        max_tokens: requested.max_completion_tokens,
        temperature: 0,
      }),
    });
    if (!res.ok) return { ...base, status: "FAILED", error_code: `perplexity_http_${res.status}` };
    payload = await res.json().catch(() => null) as Record<string, unknown> | null;
  } catch {
    return { ...base, status: "FAILED", error_code: "perplexity_error" };
  }
  const usage = (payload?.usage ?? {}) as Record<string, unknown>;
  const completion = Number(usage.completion_tokens ?? NaN);
  const prompt = Number(usage.prompt_tokens ?? 0);
  if (!Number.isFinite(completion)) {
    return { ...base, status: "FAILED", error_code: "perplexity_usage_missing" };
  }
  // Il cap è confermato solo se il provider ha davvero rispettato il tetto.
  const applied = {
    max_queries: 1,
    max_completion_tokens: completion <= requested.max_completion_tokens
      ? requested.max_completion_tokens
      : completion,
  };
  const confirmed = capExactlyApplied(requested, applied);
  if (!confirmed) {
    return {
      ...base,
      status: "BLOCKED",
      applied_cap: applied,
      error_code: "perplexity_cap_not_confirmed",
    };
  }

  try {
    await recordAiSpend("perplexity", prompt, completion);
  } catch { /* best effort */ }

  return {
    status: "SUCCESS",
    applied_cap: applied,
    cap_confirmed: true,
    actual_cost_usd: Number((((prompt + completion) / 1_000_000) * 1.0).toFixed(6)),
    counters: { queries: 1, prompt_tokens: prompt, completion_tokens: completion },
    artifacts: [{
      table_name: "civiko_commissioning_artifacts",
      change_kind: "insert",
      row_ref: `perplexity:${runId}`,
      evidence: {
        provider: "perplexity",
        commissioning_run_id: runId,
        model: PERPLEXITY_MICRORUN_MODEL,
        completion_tokens: completion,
      },
    }],
    error_code: null,
  };
}

const ADAPTERS: Record<CivikoCommissioningProvider, (runId: string) => Promise<AdapterOutcome>> = {
  apify: apifyMicroRun,
  firecrawl: firecrawlMicroRun,
  perplexity: perplexityMicroRun,
};

// ────────────── prova persistita Civiko provider-specifica ──────────────────
//
// Un artifact di audit NON è una prova: la scansione vale solo se il provider
// ha davvero scritto in una tabella di dominio Civiko (PWA/listing) una riga
// correlabile a questo micro-run. Le tabelle di audit del commissioning sono
// escluse per definizione.
//
// `writer_available = false` significa che nel Central Core non esiste oggi
// alcun writer che leghi l'output di quel provider a una riga di dominio
// Civiko: in quel caso il micro-run è BLOCKED PRIMA di qualsiasi spesa, senza
// simulare la prova. Firecrawl (pagina Comune) e Perplexity (query generica)
// ricadono in questo caso: producono testo, non dati PWA/listing.
export const CIVIKO_PROVIDER_PERSISTENCE: Record<
  CivikoCommissioningProvider,
  { table: string; writer_available: boolean; note: string }
> = {
  apify: {
    // La prova NON è la sola riga padova_apify_runs: serve anche lo staging
    // dati importato dal percorso Civiko (padova_collect_v2_items del job_id).
    table: "padova_collect_v2_items",
    writer_available: true,
    note:
      "run SUCCEEDED in padova_apify_runs + righe staging padova_collect_v2_items legate al job_id (created+updated>0)",
  },

  firecrawl: {
    table: "padova_listings",
    writer_available: false,
    note: "nessun writer lega una pagina scrapata a una riga listing Civiko",
  },
  perplexity: {
    table: "civiko_signals_classified",
    writer_available: false,
    note: "nessun writer lega una query generica a un segnale Civiko classificato",
  },
};

export const CIVIKO_AUDIT_TABLES = [
  "civiko_commissioning_artifacts",
  "civiko_commissioning_runs",
  "civiko_commissioning_baselines",
  "civiko_commissioning_claims",
];

export function isCivikoDomainProofTable(table: unknown): boolean {
  return typeof table === "string" && table.length > 0 &&
    !CIVIKO_AUDIT_TABLES.includes(table);
}

/** Cerca la riga di dominio Civiko realmente scritta dal provider. */
async function domainProof(
  provider: CivikoCommissioningProvider,
  outcome: AdapterOutcome,
): Promise<Artifact | null> {
  const spec = CIVIKO_PROVIDER_PERSISTENCE[provider];
  if (!spec.writer_available) return null;
  if (provider === "apify") {
    const apifyRunId = outcome.counters.apify_run_id;
    const jobId = outcome.counters.job_id;
    if (typeof apifyRunId !== "string" || !apifyRunId) return null;
    if (typeof jobId !== "string" || !jobId) return null;
    const rows = await realRows(
      `padova_apify_runs?run_id=eq.${encodeURIComponent(apifyRunId)}` +
        `&select=id,run_id,portal,status,cost_cap_usd,cost_usd,items_count,imported,started_at,finished_at&limit=1`,
    );
    const row = rows?.[0];
    // Falso positivo da evitare: la sola riga padova_apify_runs non è prova.
    if (!row || String(row.status ?? "") !== "SUCCEEDED") return null;
    const stagingRows = await realCount(
      `padova_collect_v2_items?select=id&job_id=eq.${encodeURIComponent(jobId)}`,
    );
    if (!stagingRows || stagingRows <= 0) return null;
    const created = Number(outcome.counters.created ?? 0);
    const updated = Number(outcome.counters.updated ?? 0);
    if (!(created + updated > 0)) return null;
    return {
      table_name: "padova_collect_v2_items",
      change_kind: created > 0 ? "insert" : "update",
      row_ref: jobId,
      evidence: {
        provider: "apify",
        job_id: jobId,
        rows_for_job: stagingRows,
        created,
        updated,
        apify_run: {
          id: row.id,
          run_id: row.run_id,
          portal: row.portal,
          status: row.status,
          cost_cap_usd: row.cost_cap_usd ?? null,
          cost_usd: row.cost_usd ?? null,
          items_count: row.items_count ?? null,
          imported: row.imported ?? null,
          started_at: row.started_at ?? null,
          finished_at: row.finished_at ?? null,
        },
        pwa_ready: false,
        activation_allowed: false,
      },
    };
  }

  return null;
}

async function runMicroRun(
  provider: CivikoCommissioningProvider,
  action: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const requestedCap = { ...CIVIKO_COMMISSIONING_CAPS[provider] } as unknown as Record<string, number>;

  const claimed = await claim(provider, runId);
  if (!claimed) {
    return {
      status: 409,
      payload: {
        ok: false,
        action,
        provider,
        run_id: runId,
        status: "BLOCKED",
        error_code: "concurrent_microrun_in_flight",
        started_at: startedAt,
      },
    };
  }

  try {
    const baseline = await persistBaseline();
    if (!baseline) {
      return {
        status: 502,
        payload: {
          ok: false, action, provider, run_id: runId, status: "BLOCKED",
          error_code: "baseline_persist_failed", started_at: startedAt,
        },
      };
    }
    const opened = await openRun({
      runId, provider, action, startedAt,
      baselineSnapshotId: baseline.snapshotId,
      requestedCap,
    });
    if (!opened) {
      return {
        status: 502,
        payload: {
          ok: false, action, provider, run_id: runId, status: "BLOCKED",
          error_code: "audit_start_failed", started_at: startedAt,
        },
      };
    }

    // Nessuna spesa se il provider non può produrre una prova persistita
    // Civiko: fail-closed PRIMA della chiamata, senza simulare la prova.
    const persistenceSpec = CIVIKO_PROVIDER_PERSISTENCE[provider];
    if (!persistenceSpec.writer_available) {
      await closeRun(runId, {
        status: "BLOCKED",
        applied_cap: null,
        actual_cost_usd: 0,
        counters: { persistence_target: persistenceSpec.table, note: persistenceSpec.note },
        error_code: `${provider}_no_civiko_persistence`,
      });
      return {
        status: 409,
        payload: {
          ok: false, action, provider, run_id: runId, status: "BLOCKED",
          baseline_snapshot_id: baseline.snapshotId,
          requested_cap: requestedCap, applied_cap: null, cap_confirmed: false,
          actual_cost_usd: 0,
          persistence_target: persistenceSpec.table,
          persistence_note: persistenceSpec.note,
          error_code: `${provider}_no_civiko_persistence`,
          started_at: startedAt, finished_at: new Date().toISOString(),
        },
      };
    }

    const outcome = await ADAPTERS[provider](runId);

    // Prova persistita provider-specifica in una tabella di dominio Civiko:
    // senza di essa il run resta BLOCKED, anche con HTTP 200 del provider.
    const proof = outcome.status === "SUCCESS" ? await domainProof(provider, outcome) : null;
    const allArtifacts = proof ? [proof, ...outcome.artifacts] : outcome.artifacts;
    const artifactsOk = outcome.status === "SUCCESS" && proof
      ? await persistArtifacts(runId, provider, allArtifacts)
      : true;

    let finalStatus: CivikoCommissioningStatus = outcome.status;
    let errorCode = outcome.error_code;
    if (outcome.status === "SUCCESS" && !proof) {
      finalStatus = "BLOCKED";
      errorCode = `${provider}_no_civiko_persistence`;
    } else if (outcome.status === "SUCCESS" && !artifactsOk) {
      finalStatus = "PARTIAL";
      errorCode = "artifact_persist_failed";
    }

    await closeRun(runId, {
      status: finalStatus,
      applied_cap: outcome.applied_cap,
      actual_cost_usd: outcome.actual_cost_usd,
      counters: outcome.counters,
      error_code: errorCode,
    });

    const ok = finalStatus === "SUCCESS";
    return {
      status: ok ? 200 : 409,
      payload: {
        ok,
        action,
        provider,
        run_id: runId,
        baseline_snapshot_id: baseline.snapshotId,
        status: finalStatus,
        requested_cap: requestedCap,
        applied_cap: outcome.applied_cap,
        cap_confirmed: outcome.cap_confirmed,
        actual_cost_usd: outcome.actual_cost_usd,
        counters: outcome.counters,
        persistence_target: persistenceSpec.table,
        domain_proof: proof
          ? { table_name: proof.table_name, row_ref: proof.row_ref, change_kind: proof.change_kind }
          : null,
        artifacts_persisted: ok ? allArtifacts.length : 0,
        error_code: errorCode,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      },
    };
  } finally {
    await releaseClaim(provider, runId);
  }
}

// ───────────────────────── verify delta (read-only) ─────────────────────────

function numAt(source: unknown, path: string[]): number | null {
  let cur: unknown = source;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

const DELTA_PATHS: Array<{ key: string; path: string[] }> = [
  { key: "listings_total", path: ["listings", "total"] },
  { key: "listings_active", path: ["listings", "active"] },
  { key: "contendibili", path: ["categories", "contendibili"] },
  { key: "multi_portale", path: ["categories", "multi_portale"] },
  { key: "classificazione", path: ["categories", "classificazione"] },
  { key: "ribassi", path: ["categories", "ribassi"] },
  { key: "off_market", path: ["categories", "off_market"] },
  { key: "cambi_agenzia", path: ["categories", "cambi_agenzia"] },
  { key: "provider_runs", path: ["provider_runs", "total"] },
];

async function verifyDelta(
  runId: string,
  baselineOverride?: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const runRows = await realRows(`civiko_commissioning_runs?run_id=eq.${runId}&select=*`);
  const run = runRows?.[0];
  if (!run) {
    return {
      status: 404,
      payload: { ok: false, action: "civiko_commissioning_verify_delta", run_id: runId, error_code: "unknown_run_id" },
    };
  }
  const baselineId = baselineOverride ?? (typeof run.baseline_snapshot_id === "string" ? run.baseline_snapshot_id : null);
  const baselineRows = baselineId
    ? await realRows(`civiko_commissioning_baselines?snapshot_id=eq.${baselineId}&select=*`)
    : null;
  const baseline = baselineRows?.[0];
  if (!baseline) {
    return {
      status: 409,
      payload: {
        ok: false, action: "civiko_commissioning_verify_delta", run_id: runId,
        error_code: "baseline_not_found", baseline_snapshot_id: baselineId,
      },
    };
  }

  const { counters: after, failed } = await captureCounters();
  const artifacts = await realRows(
    `civiko_commissioning_artifacts?run_id=eq.${runId}&select=table_name,change_kind,row_ref,evidence,created_at&order=created_at.asc&limit=50`,
  );

  const before = baseline.counters as Record<string, unknown>;
  const deltas: Record<string, { before: number | null; after: number | null; delta: number | null }> = {};
  let inserts = 0;
  for (const spec of DELTA_PATHS) {
    const b = numAt(before, spec.path);
    const a = numAt(after, spec.path);
    const d = b === null || a === null ? null : a - b;
    deltas[spec.key] = { before: b, after: a, delta: d };
    if (d !== null && d > 0) inserts += d;
  }

  // Un artifact di audit non basta: serve almeno una riga di dominio Civiko
  // (fuori dalle tabelle di commissioning) legata a questo run.
  const domainArtifacts = (artifacts ?? []).filter((a) => isCivikoDomainProofTable(a.table_name));
  const persistedProof = domainArtifacts.length > 0;
  const updateProof = domainArtifacts.some(
    (a) => a.change_kind === "update" || a.change_kind === "insert",
  );
  const runSucceeded = run.status === "SUCCESS";
  const metricsComplete = failed.length === 0;

  // Zero nuove righe è ammesso soltanto con una prova persistita specifica del
  // provider, non ambigua e legata allo stesso run.
  const ok = runSucceeded && metricsComplete && persistedProof && updateProof;
  const errorCode = !runSucceeded
    ? "run_not_succeeded"
    : !metricsComplete
    ? "metrics_incomplete"
    : !persistedProof
    ? "no_persisted_proof"
    : !updateProof
    ? "ambiguous_delta"
    : null;

  return {
    status: ok ? 200 : 409,
    payload: {
      ok,
      action: "civiko_commissioning_verify_delta",
      run_id: runId,
      provider: run.provider,
      run_status: run.status,
      requested_cap: run.requested_cap,
      applied_cap: run.applied_cap,
      actual_cost_usd: run.actual_cost_usd,
      baseline_snapshot_id: baselineId,
      baseline_captured_at: baseline.captured_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      deltas,
      delta_inserts_total: inserts,
      persisted_proof: domainArtifacts.map((a) => ({
        table_name: a.table_name,
        change_kind: a.change_kind,
        row_ref: a.row_ref,
        created_at: a.created_at,
      })),
      failed_queries: failed,
      error_code: errorCode,
      checked_at: new Date().toISOString(),
    },
  };
}

// ───────────────────────── PWA feed counts (read-only) ──────────────────────

async function pwaFeedCounts(): Promise<{ status: number; payload: Record<string, unknown> }> {
  const adminRows = await realRows(
    "civiko_admin_workspaces?select=workspace_id&active=is.true&limit=1",
  );
  const workspaceId = adminRows?.[0]?.workspace_id;
  if (typeof workspaceId !== "string") {
    return {
      status: 502,
      payload: { ok: false, action: "civiko_commissioning_pwa_feed_counts", error_code: "admin_workspace_missing" },
    };
  }
  if (!CIVIKO_APP_SECRET) {
    return {
      status: 500,
      payload: { ok: false, action: "civiko_commissioning_pwa_feed_counts", error_code: "civiko_secret_missing" },
    };
  }

  // Stessa query/semantica del feed autenticato della PWA: nessun contatore
  // marketing della landing.
  let feed: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/civiko-one-signals-feed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": CIVIKO_APP_SECRET,
        "x-source-app": "civiko-one",
        "x-workspace-id": workspaceId,
      },
      body: JSON.stringify({
        include: ["contendibili", "ribassi", "privati", "off_market", "multi_portale"],
        limit: 1000,
      }),
    });
    feed = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      return {
        status: 502,
        payload: {
          ok: false, action: "civiko_commissioning_pwa_feed_counts",
          error_code: `feed_http_${res.status}`,
        },
      };
    }
  } catch {
    return {
      status: 502,
      payload: { ok: false, action: "civiko_commissioning_pwa_feed_counts", error_code: "feed_unreachable" },
    };
  }

  const summary = (feed?.summary ?? {}) as Record<string, unknown>;
  const diagnostics = (feed?.diagnostics ?? {}) as Record<string, unknown>;
  const classificati = await realCount("civiko_signals_classified?select=id");
  // Schema reale: padova_cambi_agenzia usa is_active (nessun campo `stato`).
  const cambiAgenzia = await realCount("padova_cambi_agenzia?select=id&is_active=is.true");
  const ackRows = await realRows(
    "civiko_pwa_sync_acks?select=run_id,pipeline_run_id,ok,started_at,finished_at,created_at,counts,scope_comune,scope_slugs,municipality,commercial_zone_slugs&order=created_at.desc&limit=1",
  );

  const counts = {
    classificazione: classificati,
    contendibili: summary.contendibili ?? null,
    ribassi: summary.ribassi ?? null,
    off_market: summary.off_market ?? null,
    cambi_agenzia: cambiAgenzia,
    privati: summary.privati ?? null,
    multi_portale: summary.multi_portale ?? null,
  };
  const complete = Object.values(counts).every((v) => typeof v === "number");

  return {
    status: complete ? 200 : 409,
    payload: {
      ok: complete && feed?.ok === true,
      action: "civiko_commissioning_pwa_feed_counts",
      source: "civiko-one-signals-feed",
      workspace_scope: "admin_full_city",
      commercial_zone_slugs: CIVIKO_SCOPE_SLUGS,
      counts,
      data_freshness: {
        generated_at: feed?.generated_at ?? null,
        last_provider_refresh_at: diagnostics.last_provider_refresh_at ?? null,
        newest_source_updated_at: diagnostics.newest_source_updated_at ?? null,
        upstream_refresh_status: diagnostics.upstream_refresh_status ?? null,
      },
      pwa_sync_ack: ackRows?.[0] ?? null,
      error_code: complete ? null : "feed_counts_incomplete",
      checked_at: new Date().toISOString(),
    },
  };
}

// ───────────────────────── chain (post-provider) ────────────────────────────

interface ChainStep {
  key: string;
  kind: "function" | "rpc" | "read" | "gate";
  fn?: string;
  query?: string;
  rpcName?: string;
  body?: Record<string, unknown>;
}

const CHAIN_STEPS: ChainStep[] = [
  { key: "classificazione", kind: "function", fn: "civiko-signals-classify", body: { dry_run: false } },
  { key: "contendibili", kind: "rpc", rpcName: "recompute_padova_listings_contendibili", body: {} },
  { key: "ribassi_cambi_agenzia", kind: "rpc", rpcName: "recompute_padova_contendibili_extras", body: {} },
  {
    key: "off_market",
    kind: "function",
    fn: "cron-offmarket-padova-nightly",
    query: "job=build-offmarket-opportunity-scores",
    body: {},
  },
  { key: "sync_pwa", kind: "read" },
  { key: "release_gate", kind: "gate" },
];

async function runChainStep(step: ChainStep): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const fail = (status: CivikoCommissioningStatus, code: string, httpStatus: number) => ({
    step: step.key,
    status,
    http_status: httpStatus,
    error_code: code,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  if (step.kind === "read") {
    const rows = await realRows(
      "civiko_pwa_sync_acks?select=run_id,pipeline_run_id,ok,started_at,finished_at,created_at,counts,scope_comune,scope_slugs,municipality,commercial_zone_slugs&order=created_at.desc&limit=1",
    );
    if (rows === null) return fail("FAILED", "pwa_ack_unreadable", 502);
    const ack = rows[0];
    if (!ack) return fail("PARTIAL", "pwa_ack_missing", 200);
    return {
      step: step.key,
      status: ack.ok === true ? "SUCCESS" : "PARTIAL",
      http_status: 200,
      error_code: ack.ok === true ? null : "pwa_ack_not_ok",
      pipeline_run_id: ack.pipeline_run_id ?? null,
      ack_started_at: ack.started_at ?? null,
      ack_finished_at: ack.finished_at ?? null,
      ack_created_at: ack.created_at ?? null,
      counts: ack.counts ?? null,
      scope_comune: ack.scope_comune ?? ack.municipality ?? null,
      scope_slugs: ack.scope_slugs ?? ack.commercial_zone_slugs ?? null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  if (step.kind === "gate") {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/civiko-orchestrator-dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DISPATCH_SECRET}`,
        },
        body: JSON.stringify({ action: "release_gate" }),
      });
      const payload = await res.json().catch(() => null) as Record<string, unknown> | null;
      const passed = payload?.gate_passed === true;
      return {
        step: step.key,
        status: passed ? "SUCCESS" : res.status === 502 ? "FAILED" : "BLOCKED",
        http_status: res.status,
        gate_passed: passed,
        missing: Array.isArray(payload?.missing) ? payload?.missing : [],
        error_code: passed ? null : "release_gate_not_passed",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
    } catch {
      return fail("FAILED", "release_gate_unreachable", 502);
    }
  }

  if (step.kind === "rpc") {
    const r = await rpc(step.rpcName as string, step.body ?? {}, CHAIN_STEP_TIMEOUT_MS);
    return {
      step: step.key,
      status: r.ok ? "SUCCESS" : "FAILED",
      http_status: r.status,
      error_code: r.ok ? null : "rpc_failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }

  if (!JOB_SECRET) return fail("BLOCKED", "job_secret_missing", 500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAIN_STEP_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/${step.fn}${step.query ? `?${step.query}` : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-job-secret": JOB_SECRET },
        body: JSON.stringify(step.body ?? {}),
        signal: controller.signal,
      },
    );
    const payload = await res.json().catch(() => null) as Record<string, unknown> | null;
    const semanticOk = res.ok && payload?.ok !== false;
    return {
      step: step.key,
      status: semanticOk ? "SUCCESS" : res.ok ? "PARTIAL" : "FAILED",
      http_status: res.status,
      error_code: semanticOk ? null : `downstream_${res.status}`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return fail("FAILED", aborted ? "timeout" : "network_error", aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

const CHAIN_SEVERITY: Record<string, number> = {
  SUCCESS: 0, PARTIAL: 1, BLOCKED: 2, FAILED: 3,
};

async function runChain(): Promise<{ status: number; payload: Record<string, unknown> }> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const claimed = await claim("chain", runId);
  if (!claimed) {
    return {
      status: 409,
      payload: {
        ok: false, action: "civiko_commissioning_chain", run_id: runId,
        status: "BLOCKED", error_code: "concurrent_chain_in_flight", started_at: startedAt,
      },
    };
  }
  await openRun({
    runId, provider: "chain", action: "civiko_commissioning_chain",
    startedAt, baselineSnapshotId: null, requestedCap: {},
  });

  const steps: Record<string, unknown>[] = [];
  try {
    for (const step of CHAIN_STEPS) {
      const result = await runChainStep(step);
      steps.push(result);
      // Fail-closed: nessuna trasformazione semantica dello stato reale.
      if (result.status === "FAILED" || result.status === "BLOCKED") break;
    }
  } finally {
    await releaseClaim("chain", runId);
  }

  const worst = steps.reduce(
    (acc, s) => Math.max(acc, CHAIN_SEVERITY[String(s.status)] ?? 3),
    0,
  );
  const overall = (Object.keys(CHAIN_SEVERITY) as string[])
    .find((k) => CHAIN_SEVERITY[k] === worst) as CivikoCommissioningStatus;
  const executedAll = steps.length === CHAIN_STEPS.length;
  const finalStatus: CivikoCommissioningStatus = executedAll ? overall : (overall === "SUCCESS" ? "PARTIAL" : overall);

  await closeRun(runId, {
    status: finalStatus,
    counters: { steps_executed: steps.length, steps_planned: CHAIN_STEPS.length },
    error_code: finalStatus === "SUCCESS" ? null : "chain_not_fully_successful",
  });

  return {
    status: finalStatus === "SUCCESS" ? 200 : 409,
    payload: {
      ok: finalStatus === "SUCCESS",
      action: "civiko_commissioning_chain",
      run_id: runId,
      status: finalStatus,
      steps,
      steps_planned: CHAIN_STEPS.map((s) => s.key),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    },
  };
}

// ───────────────────────── handler ──────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!DISPATCH_SECRET) {
    console.error("[civiko-commissioning] misconfigured");
    return json(500, { ok: false, error: "misconfigured" });
  }
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || !timingSafeEqual(bearer, DISPATCH_SECRET)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const ctype = (req.headers.get("Content-Type") ?? "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return json(415, { ok: false, error: "unsupported_media_type" });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: "payload_too_large" });
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, { ok: false, error: "invalid_payload" });
  }

  const validated = validateCommissioningBody(parsed as Record<string, unknown>);
  if (!validated.ok) {
    return json(validated.status, {
      ok: false,
      error: validated.error,
      allowed: CIVIKO_COMMISSIONING_ACTIONS,
    });
  }

  if (validated.action === "civiko_commissioning_healthcheck") {
    return json(200, {
      ok: Boolean(DISPATCH_SECRET && SUPABASE_URL && SERVICE_KEY),
      action: validated.action,
      actions: CIVIKO_COMMISSIONING_ACTIONS,
      caps: CIVIKO_COMMISSIONING_CAPS,
      commercial_zone_slugs: CIVIKO_SCOPE_SLUGS,
      config: {
        dispatch_secret: Boolean(DISPATCH_SECRET),
        job_secret: Boolean(JOB_SECRET),
        civiko_app_secret: Boolean(CIVIKO_APP_SECRET),
        service_key: Boolean(SERVICE_KEY),
      },
      checked_at: new Date().toISOString(),
    });
  }

  if (!SERVICE_KEY || !SUPABASE_URL) {
    console.error("[civiko-commissioning] misconfigured");
    return json(500, { ok: false, error: "misconfigured" });
  }

  if (validated.action === "civiko_commissioning_baseline") {
    const baseline = await persistBaseline();
    if (!baseline) return json(502, { ok: false, error: "baseline_persist_failed" });
    return json(baseline.failed.length ? 409 : 200, {
      ok: baseline.failed.length === 0,
      action: validated.action,
      snapshot_id: baseline.snapshotId,
      run_id: baseline.snapshotId,
      counters: baseline.counters,
      failed_queries: baseline.failed,
      captured_at: new Date().toISOString(),
    });
  }

  if (validated.action === "civiko_commissioning_microrun_apify") {
    const r = await runMicroRun("apify", validated.action);
    return json(r.status, r.payload);
  }
  if (validated.action === "civiko_commissioning_microrun_firecrawl") {
    const r = await runMicroRun("firecrawl", validated.action);
    return json(r.status, r.payload);
  }
  if (validated.action === "civiko_commissioning_microrun_perplexity") {
    const r = await runMicroRun("perplexity", validated.action);
    return json(r.status, r.payload);
  }
  if (validated.action === "civiko_commissioning_verify_delta") {
    const r = await verifyDelta(validated.runId as string, validated.baselineSnapshotId);
    return json(r.status, r.payload);
  }
  if (validated.action === "civiko_commissioning_pwa_feed_counts") {
    const r = await pwaFeedCounts();
    return json(r.status, r.payload);
  }
  if (validated.action === "civiko_commissioning_chain") {
    const r = await runChain();
    return json(r.status, r.payload);
  }

  return json(400, { ok: false, error: "action_not_allowed" });
});
