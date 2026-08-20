// civiko-contendibili-evidence-refresh
// Accoda ogni giorno SOLO le schede dettaglio dei candidati già in quarantena
// per mancanza di evidenza di unità. Non modifica le regole di certificazione,
// non legge URL dal chiamante e non serve altre PWA.
//
// v5 matcher identity is photo + mq + price + zone. CIVICO_ASSENTE here is
// enrichment-only — via/civico are not a contendibile hard gate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
const DEFAULT_CAP = 24;
const HARD_CAP = 36;
const OFFICIAL_ZONES = new Set([
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
]);
const ALLOWED_REASONS = new Set(["CIVICO_ASSENTE", "EVIDENZA_UNITA_ASSENTE"]);

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

type QuarantineRow = {
  id: number;
  chiave_match: string;
  urls: string[] | null;
  motivi: string[] | null;
  n_agenzie: number | null;
  commercial_zone_slug: string | null;
};

type ListingRow = {
  id: number;
  url: string;
  fonte: string;
  agency: string | null;
  commercial_zone_slug: string | null;
  last_seen_at: string | null;
  raw_json: Record<string, unknown> | null;
  ev_civico_norm: string | null;
  ev_piano_key: string | null;
  ev_descr_fp: string | null;
};

type AttemptRow = {
  listing_id: number;
  status: string;
  last_attempt_at: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normAgency(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sourceText(row: ListingRow): string {
  return JSON.stringify(row.raw_json ?? {}).toLowerCase() + " " + (row.agency ?? "").toLowerCase();
}

function hasForbiddenEvidence(row: ListingRow): boolean {
  const t = sourceText(row);
  return /(?:\basta\b|giudiziar|procedura esecutiva|base d.?asta|offerta minima|\br\.?g\.?e\.?\b)/i.test(t) ||
    /(?:\bmls\b|multiple listing service|incarico in esclusiva|mandato in esclusiva)/i.test(t);
}

function mustRetry(row: ListingRow, attempt: AttemptRow | undefined, now: number): boolean {
  if (!attempt) return true;
  const attempted = Date.parse(attempt.last_attempt_at);
  const seen = Date.parse(row.last_seen_at ?? "");
  if (Number.isFinite(seen) && Number.isFinite(attempted) && seen > attempted) return true;
  const age = now - (Number.isFinite(attempted) ? attempted : 0);
  if (attempt.status === "failed" || attempt.status === "dead") return age >= 2 * 86400_000;
  if (attempt.status === "queued" || attempt.status === "processing") return age >= 2 * 86400_000;
  return age >= 30 * 86400_000;
}

async function sha1(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const supplied = req.headers.get("x-job-secret") ?? "";
  if (!JOB_SECRET || !safeEqual(supplied, JOB_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let requested = DEFAULT_CAP;
  try {
    const body = await req.json().catch(() => ({}));
    if (Number.isFinite(Number(body?.limit))) requested = Math.trunc(Number(body.limit));
  } catch {
    requested = DEFAULT_CAP;
  }
  const configured = Math.min(
    HARD_CAP,
    Math.max(1, Math.trunc(Number(Deno.env.get("CIVIKO_CONTENDIBILI_DETAIL_DAILY_CAP")) || DEFAULT_CAP)),
  );
  const limit = Math.min(configured, Math.max(1, requested));
  const runId = crypto.randomUUID();
  const runDate = new Date().toISOString().slice(0, 10);
  const started = new Date().toISOString();

  await sb.from("civiko_contendibili_evidence_runs").insert({
    id: runId,
    run_date: runDate,
    status: "started",
    requested_limit: limit,
    started_at: started,
  });

  const { data: qData, error: qError } = await sb
    .from("padova_contendibili_quarantena")
    .select("id,chiave_match,urls,motivi,n_agenzie,commercial_zone_slug")
    .gte("n_agenzie", 2)
    .contains("motivi", ["EVIDENZA_UNITA_ASSENTE"])
    .limit(200);

  if (qError) {
    await sb.from("civiko_contendibili_evidence_runs").update({
      status: "failure", error_code: "quarantine_read_failed", completed_at: new Date().toISOString(),
    }).eq("id", runId);
    return json({ ok: false, error: "quarantine_read_failed", run_id: runId }, 500);
  }

  const groups = (qData ?? []) as QuarantineRow[];
  const eligibleGroups = groups.filter((g) => {
    const reasons = g.motivi ?? [];
    return Boolean(
      g.commercial_zone_slug &&
      OFFICIAL_ZONES.has(g.commercial_zone_slug) &&
      g.n_agenzie && g.n_agenzie >= 2 &&
      reasons.length > 0 &&
      reasons.every((r) => ALLOWED_REASONS.has(r)) &&
      (g.urls?.length ?? 0) >= 2,
    );
  });

  const allUrls = Array.from(new Set(eligibleGroups.flatMap((g) => g.urls ?? []))).slice(0, 300);
  if (allUrls.length === 0) {
    await sb.from("civiko_contendibili_evidence_runs").update({
      status: "success", groups_considered: groups.length, groups_eligible: 0,
      enqueued: 0, completed_at: new Date().toISOString(),
    }).eq("id", runId);
    return json({ ok: true, run_id: runId, groups_considered: groups.length, groups_eligible: 0, enqueued: 0 });
  }

  const { data: lData, error: lError } = await sb
    .from("padova_listings")
    .select("id,url,fonte,agency,commercial_zone_slug,last_seen_at,raw_json,ev_civico_norm,ev_piano_key,ev_descr_fp")
    .in("url", allUrls)
    .is("expired_at", null)
    .limit(500);

  if (lError) {
    await sb.from("civiko_contendibili_evidence_runs").update({
      status: "failure", error_code: "listing_read_failed", completed_at: new Date().toISOString(),
    }).eq("id", runId);
    return json({ ok: false, error: "listing_read_failed", run_id: runId }, 500);
  }

  const listings = (lData ?? []) as ListingRow[];
  const byUrl = new Map(listings.map((l) => [l.url, l]));
  const candidates: Array<{ row: ListingRow; group: QuarantineRow }> = [];
  let groupsForbidden = 0;
  let groupsInvalid = 0;

  for (const group of eligibleGroups) {
    const rows = (group.urls ?? []).map((u) => byUrl.get(u)).filter(Boolean) as ListingRow[];
    const agencies = new Set(rows.map((r) => normAgency(r.agency)).filter(Boolean));
    const zoneOk = rows.length >= 2 && rows.every((r) => r.commercial_zone_slug === group.commercial_zone_slug);
    if (!zoneOk || agencies.size < 2) {
      groupsInvalid++;
      continue;
    }
    if (rows.some(hasForbiddenEvidence)) {
      groupsForbidden++;
      continue;
    }
    for (const row of rows) candidates.push({ row, group });
  }

  const uniqueCandidates = Array.from(
    new Map(candidates.map((c) => [c.row.id, c])).values(),
  );

  const ids = uniqueCandidates.map((c) => c.row.id);
  let attempts: AttemptRow[] = [];
  if (ids.length > 0) {
    const { data } = await sb
      .from("civiko_contendibili_evidence_attempts")
      .select("listing_id,status,last_attempt_at")
      .in("listing_id", ids);
    attempts = (data ?? []) as AttemptRow[];
  }
  const attemptsById = new Map(attempts.map((a) => [a.listing_id, a]));
  const now = Date.now();
  const work = uniqueCandidates
    .filter((c) => mustRetry(c.row, attemptsById.get(c.row.id), now))
    .sort((a, b) => {
      const am = Number(Boolean(a.row.ev_civico_norm)) + Number(Boolean(a.row.ev_piano_key)) + Number(Boolean(a.row.ev_descr_fp));
      const bm = Number(Boolean(b.row.ev_civico_norm)) + Number(Boolean(b.row.ev_piano_key)) + Number(Boolean(b.row.ev_descr_fp));
      return am - bm || Date.parse(b.row.last_seen_at ?? "1970-01-01") - Date.parse(a.row.last_seen_at ?? "1970-01-01");
    })
    .slice(0, limit);

  const results: Array<{ listing_id: number; ok: boolean; queue_id?: string; error?: string }> = [];
  for (const item of work) {
    const urlHash = (await sha1(item.row.url)).slice(0, 16);
    const idem = `civiko-cont-detail:v1:${runDate}:${item.row.id}:${urlHash}`;
    const { data, error } = await sb.rpc("scraping_enqueue_processed", {
      p_provider: "firecrawl",
      p_operation: "scrape",
      p_payload: {
        url: item.row.url,
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 2500,
      },
      p_processor: "civiko_contendibile_detail_v1",
      p_processor_context: {
        listing_id: item.row.id,
        url: item.row.url,
        commercial_zone_slug: item.group.commercial_zone_slug,
        chiave_match: item.group.chiave_match,
        run_id: runId,
      },
      p_idempotency_key: idem,
      p_group_key: "civiko-contendibili-detail",
      p_priority: 850,
      p_max_attempts: 3,
      p_timeout_seconds: 45,
      p_processing_max_attempts: 4,
    });
    if (error) {
      results.push({ listing_id: item.row.id, ok: false, error: "enqueue_failed" });
      continue;
    }
    const queueId = typeof data === "string" ? data : String((data as { id?: unknown } | null)?.id ?? "");
    await sb.from("civiko_contendibili_evidence_attempts").upsert({
      listing_id: item.row.id,
      url: item.row.url,
      commercial_zone_slug: item.group.commercial_zone_slug,
      chiave_match: item.group.chiave_match,
      queue_id: queueId || null,
      status: "queued",
      last_attempt_at: new Date().toISOString(),
      run_id: runId,
      error_code: null,
    }, { onConflict: "listing_id" });
    results.push({ listing_id: item.row.id, ok: true, queue_id: queueId || undefined });
  }

  const enqueued = results.filter((r) => r.ok).length;
  const failed = results.length - enqueued;
  await sb.from("civiko_contendibili_evidence_runs").update({
    status: failed > 0 && enqueued === 0 ? "failure" : "success",
    groups_considered: groups.length,
    groups_eligible: eligibleGroups.length - groupsForbidden - groupsInvalid,
    groups_forbidden: groupsForbidden,
    groups_invalid: groupsInvalid,
    candidates_found: uniqueCandidates.length,
    enqueued,
    failed,
    completed_at: new Date().toISOString(),
  }).eq("id", runId);

  return json({
    ok: enqueued > 0 || work.length === 0,
    run_id: runId,
    groups_considered: groups.length,
    groups_eligible: eligibleGroups.length - groupsForbidden - groupsInvalid,
    groups_forbidden: groupsForbidden,
    groups_invalid: groupsInvalid,
    candidates_found: uniqueCandidates.length,
    enqueued,
    failed,
    daily_cap: configured,
  }, failed > 0 && enqueued === 0 ? 500 : 200);
});
