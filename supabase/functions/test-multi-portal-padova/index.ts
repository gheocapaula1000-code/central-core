// test-multi-portal-padova
// Full-coverage Padova multi-portal TEST with:
//  - SERIALIZED Apify chunk execution (worker pool, default 3 concurrent) to
//    stay under the plan's actor-memory-limit.
//  - Auto-split of price bands when a chunk saturates the actor's ~200 cap.
//  - OMI code → real Padova neighbourhood name mapping.
//  - first_seen_at historization in public.test_listing_first_seen.
//  - Identity matching (street+civic+mq) WITHOUT price as a filter.
//
// Background orchestration: action "run" returns a job_id immediately and the
// real work runs via EdgeRuntime.waitUntil. Poll action "status" for progress
// and final result. NO writes to production tables.
//
// Auth: x-job-secret OR a valid Supabase Bearer JWT.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY_BASE = "https://api.apify.com/v2";
const FIRECRAWL_BASE = "https://api.firecrawl.dev";

type Portal = "immobiliare" | "idealista" | "subito" | "casa";

interface Band { min: number; max: number | null }

// FIXED 8-band plan (pre-calibrated). NO auto-split: saturated bands are
// reported but never re-divided. Run count is fixed and predictable.
const FIXED_BANDS_8: Band[] = [
  { min: 0,       max: 80000   },
  { min: 80000,   max: 130000  },
  { min: 130000,  max: 180000  },
  { min: 180000,  max: 230000  },
  { min: 230000,  max: 300000  },
  { min: 300000,  max: 450000  },
  { min: 450000,  max: 700000  },
  { min: 700000,  max: null    },
];
// HARD CEILING — total Apify runs in a single "run_fixed" job MUST be <= this.
const MAX_RUNS_TOTAL = 20;

function bandLabel(b: Band): string {
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n/1000)}k` : `${n}`;
  return `${fmt(b.min)}-${b.max == null ? "∞" : fmt(b.max)}`;
}

interface ApifyChunk {
  portal: "immobiliare" | "idealista";
  band: Band;
  actor: string;
  input: Record<string, unknown>;
}

function buildImmoChunk(b: Band, perChunkMax: number): ApifyChunk {
  const u = new URL("https://www.immobiliare.it/vendita-case/padova/");
  u.searchParams.set("criterio", "rilevanza");
  u.searchParams.set("prezzoMinimo", String(b.min));
  if (b.max != null) u.searchParams.set("prezzoMassimo", String(b.max));
  return {
    portal: "immobiliare",
    band: b,
    actor: "azzouzana~immobiliare-it-listing-page-scraper-by-search-url",
    input: { startUrl: u.toString(), maxItems: perChunkMax },
  };
}
function buildIdealistaChunk(b: Band, perChunkMax: number): ApifyChunk {
  const parts: string[] = [];
  if (b.min > 0) parts.push(`prezzo-min_${b.min}`);
  if (b.max != null) parts.push(`prezzo-max_${b.max}`);
  const slice = parts.length ? `con-${parts.join(",")}/` : "";
  return {
    portal: "idealista",
    band: b,
    actor: "memo23~idealista-scraper",
    input: {
      startUrls: [`https://www.idealista.it/vendita-case/padova-padova/${slice}`],
      maxItems: perChunkMax,
      scrapeAgencies: false,
      proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    },
  };
}

// Single-run builders (whole Padova, high maxItems) — used when cap_check
// proved that portal can return >200 in one shot.
function buildImmoSingle(maxItems: number): ApifyChunk {
  return {
    portal: "immobiliare", band: { min: 0, max: null },
    actor: "azzouzana~immobiliare-it-listing-page-scraper-by-search-url",
    input: {
      startUrl: "https://www.immobiliare.it/vendita-case/padova/?criterio=rilevanza",
      maxItems, resultsLimit: maxItems, maxRequestsPerCrawl: maxItems + 50,
    },
  };
}
function buildIdealistaSingle(maxItems: number): ApifyChunk {
  return {
    portal: "idealista", band: { min: 0, max: null },
    actor: "memo23~idealista-scraper",
    input: {
      startUrls: [{ url: "https://www.idealista.it/vendita-case/padova-padova/" }],
      maxItems, resultsLimit: maxItems, maxRequestsPerCrawl: maxItems + 50,
      proxy: { useApifyProxy: true },
    },
  };

// ───── OMI → quartiere (Padova) ─────
const OMI_QUARTIERE: Record<string, string> = {
  B1: "Centro Storico",
  B2: "Prato della Valle / Universitario",
  C1: "Portello / Ognissanti",
  C2: "Stazione",
  C3: "Arcella nord",
  C4: "Stanga / Pio X",
  C5: "Sant'Osvaldo / Facciolati",
  C6: "Sacra Famiglia",
  D1: "Chiesanuova / Brentelle",
  D2: "Mandria / Savonarola",
  D3: "Voltabarozzo / Guizza",
  D4: "Camin / San Marco",
  D5: "Pontevigodarzere ovest",
  D6: "Pontevigodarzere",
  D7: "Mortise / Arcella est",
  D8: "Forcellini",
  E1: "Camin industriale",
  E2: "Camin sud",
  E3: "Salboro",
  R1: "rurale nord",
  R3: "rurale sud / Guizza",
};

// ───── Normalisation helpers (unchanged from previous run) ─────
function parsePubDate(it: Record<string, any>): string | null {
  const cands = [
    it.publishedDate, it.publishedAt, it.published_at, it.creationDate, it.createdAt,
    it.date, it.dateInsertion, it.firstSeenAt, it.firstActivationDate,
    it.properties?.[0]?.publishedDate, it.basicInfo?.creationDate,
  ];
  for (const c of cands) {
    if (!c) continue;
    if (typeof c === "number") { const d = new Date(c < 1e12 ? c * 1000 : c); if (!isNaN(+d)) return d.toISOString(); }
    if (typeof c === "string") { const d = new Date(c); if (!isNaN(+d)) return d.toISOString(); }
  }
  return null;
}
function normalizeAddressKey(addr: string | null | undefined): { street: string; civic: string | null } {
  if (!addr) return { street: "", civic: null };
  let s = String(addr).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  s = s.replace(/[.,;:()]/g, " ").replace(/\s+/g, " ").trim();
  s = s.split(/\bpadova\b|\bpd\b/i)[0].trim();
  const prefixMap: Array<[RegExp, string]> = [
    [/^v\.?le\b|^viale\b/, "viale"],
    [/^v\.?\b|^via\b/, "via"],
    [/^p\.?zza\b|^piazza\b|^p\.za\b/, "piazza"],
    [/^c\.?so\b|^corso\b/, "corso"],
    [/^l\.?go\b|^largo\b/, "largo"],
    [/^str\.?\b|^strada\b/, "strada"],
    [/^vic\.?\b|^vicolo\b/, "vicolo"],
    [/^p\.?le\b|^piazzale\b/, "piazzale"],
  ];
  for (const [re, rep] of prefixMap) s = s.replace(re, rep);
  const civicMatch = s.match(/\b(\d{1,4}[a-z]?)\b/);
  const civic = civicMatch ? civicMatch[1] : null;
  const street = (civicMatch ? s.slice(0, civicMatch.index) : s).replace(/\s+/g, " ").trim();
  return { street, civic };
}
function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function nz(n: number | null): number | null {
  return n != null && Number.isFinite(n) && n !== 0 ? n : null;
}

interface NormItem {
  portal: Portal;
  title: string | null; address: string | null;
  price: number | null; mq: number | null; rooms: number | null;
  agency: string | null; isPrivate: boolean;
  lat: number | null; lng: number | null; cap: string | null;
  url: string | null; publishedAt: string | null;
  source_chunk?: string;
}

function normalizeImmobiliare(it: Record<string, any>): NormItem {
  const p = Array.isArray(it.properties) ? it.properties[0] ?? {} : {};
  const loc = p.location ?? {};
  const adv = it.advertiser ?? {};
  const ag = adv.agency ?? {};
  const fl: any[] = Array.isArray(p.featureList) ? p.featureList : [];
  const surfFeat = fl.find((f) => f?.type === "surface");
  const roomsFeat = fl.find((f) => f?.type === "rooms");
  const surf = surfFeat ? num(String(surfFeat.label ?? surfFeat.compactLabel ?? "").replace(/[^\d]/g, "")) : null;
  const rooms = roomsFeat ? num(String(roomsFeat.compactLabel ?? roomsFeat.label ?? "").split(/[-–]/)[0]) : null;
  const agency = ag.displayName ? String(ag.displayName).slice(0, 120) : null;
  const isPrivate = (ag.type === "private") || (adv.label === "privato") || (!agency && !ag.id);
  return {
    portal: "immobiliare",
    title: p.caption ? String(p.caption).slice(0, 200) : null,
    address: loc.address ? String(loc.address).slice(0, 200) : null,
    price: num(it.price?.value ?? it.price?.minValue ?? it.price?.formattedValue),
    mq: surf, rooms, agency, isPrivate,
    lat: nz(num(loc.latitude)), lng: nz(num(loc.longitude)), cap: null,
    url: it.directLink ?? (it.id ? `https://www.immobiliare.it/annunci/${it.id}` : null),
    publishedAt: parsePubDate(it),
  };
}
function normalizeIdealista(it: Record<string, any>): NormItem {
  const b = it.basicInfo ?? it ?? {};
  const ci = b.contactInfo ?? {};
  const userType = String(ci.userType ?? "").toLowerCase();
  const agency = (ci.commercialName ?? ci.contactName ?? null) as string | null;
  const isPrivate = userType === "private" || userType === "particular";
  return {
    portal: "idealista",
    title: b.suggestedTexts?.title ?? b.address ?? null,
    address: b.address ?? null,
    price: num(b.price ?? b.priceInfo?.price?.amount),
    mq: num(b.size), rooms: num(b.rooms),
    agency: agency ? String(agency).slice(0, 120) : null,
    isPrivate: isPrivate || (!agency && userType !== "professional"),
    lat: nz(num(b.latitude)), lng: nz(num(b.longitude)), cap: null,
    url: b.url ?? (b.propertyCode ? `https://www.idealista.it/immobile/${b.propertyCode}/` : null),
    publishedAt: parsePubDate(it),
  };
}
function normalizeSubito(it: Record<string, any>): NormItem {
  const loc = it.location ?? {};
  const coords = loc.coordinates ?? {};
  const f = it.features ?? {};
  const adv = it.advertiser ?? {};
  const advType = String(adv.type ?? "").toLowerCase();
  const isPrivate = it.isPrivateAdvertiser === true || advType === "privato" || advType === "private";
  return {
    portal: "subito",
    title: it.title ?? it.seo_title ?? null,
    address: it.title ?? null,
    price: num(it.price?.value),
    mq: num(f.size_sqm?.value), rooms: num(f.rooms?.value),
    agency: isPrivate ? null : (adv.name ? String(adv.name).slice(0, 120) : null),
    isPrivate,
    lat: nz(num(coords.latitude)), lng: nz(num(coords.longitude)), cap: null,
    url: it.page_url ?? it.request_url ?? null,
    publishedAt: parsePubDate(it),
  };
}
function normalizeCasa(it: Record<string, any>): NormItem {
  const lat = nz(num(it.latitude ?? it.lat));
  const lng = nz(num(it.longitude ?? it.lng));
  const agency = it.agency && String(it.agency).trim() && !/^priv/i.test(String(it.agency)) ? String(it.agency).slice(0, 120) : null;
  const isPrivate = it.isPrivate === true || /^priv/i.test(String(it.agency ?? ""));
  return {
    portal: "casa",
    title: it.title ?? null, address: it.address ?? null,
    price: num(it.price), mq: num(it.surface ?? it.mq), rooms: num(it.rooms),
    agency, isPrivate, lat, lng,
    cap: it.cap ? String(it.cap).replace(/\D/g, "").slice(0, 5) || null : null,
    url: it.url ?? null, publishedAt: parsePubDate(it),
  };
}
function normalizeRaw(portal: Portal, it: Record<string, unknown>): NormItem {
  const r = it as Record<string, any>;
  switch (portal) {
    case "immobiliare": return normalizeImmobiliare(r);
    case "idealista":   return normalizeIdealista(r);
    case "subito":      return normalizeSubito(r);
    case "casa":        return normalizeCasa(r);
  }
}

// ───── Apify low-level ─────
async function apifyJson(path: string, init: RequestInit, ms: number, token: string): Promise<Response> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const url = `${APIFY_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  } finally { clearTimeout(t); }
}

interface ApifyChunkResult {
  portal: Portal; band_label: string;
  status: "OK" | "BLOCCATO" | "ERRORE" | "RUNNING_TIMEOUT" | "MEMORY_LIMIT";
  run_id?: string; run_status?: string;
  raw_count: number; items: NormItem[];
  cost_usd: number | null; saturated: boolean; error?: string;
}

async function runApifyChunk(chunk: ApifyChunk, perChunkMax: number, token: string): Promise<ApifyChunkResult> {
  const label = bandLabel(chunk.band);
  try {
    const startRes = await apifyJson(
      `/acts/${encodeURIComponent(chunk.actor)}/runs`,
      { method: "POST", body: JSON.stringify(chunk.input) },
      30_000, token,
    );
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => "");
      return {
        portal: chunk.portal, band_label: label, status: "ERRORE", raw_count: 0,
        items: [], cost_usd: null, saturated: false,
        error: `start_${startRes.status}:${txt.slice(0, 200).replace(/token=[^&\s]+/gi, "token=[redacted]")}`,
      };
    }
    const sj = await startRes.json();
    const runId: string = sj?.data?.id;
    if (!runId) {
      return { portal: chunk.portal, band_label: label, status: "ERRORE", raw_count: 0, items: [], cost_usd: null, saturated: false, error: "missing_run_id" };
    }

    // Poll until terminal (max ~240s per chunk).
    const MAX_WAIT = 240_000;
    const POLL = 5_000;
    const t0 = Date.now();
    let status = "READY";
    let datasetId: string | undefined;
    let cost: number | null = null;
    while (Date.now() - t0 < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, POLL));
      const r = await apifyJson(`/actor-runs/${encodeURIComponent(runId)}`, { method: "GET" }, 15_000, token);
      if (!r.ok) continue;
      const rj = await r.json();
      status = rj?.data?.status ?? status;
      datasetId = rj?.data?.defaultDatasetId ?? datasetId;
      cost = typeof rj?.data?.usageTotalUsd === "number" ? rj.data.usageTotalUsd : cost;
      if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) break;
    }

    if (status !== "SUCCEEDED") {
      const isMem = String(status).toUpperCase().includes("MEM") ||
        (await fetchExitReason(runId, token)).toLowerCase().includes("memory");
      return {
        portal: chunk.portal, band_label: label,
        status: isMem ? "MEMORY_LIMIT" : (status === "READY" || status === "RUNNING" ? "RUNNING_TIMEOUT" : "ERRORE"),
        run_id: runId, run_status: status, raw_count: 0, items: [], cost_usd: cost, saturated: false,
        error: `run_status=${status}`,
      };
    }

    let raw: Record<string, unknown>[] = [];
    if (datasetId) {
      const dRes = await apifyJson(
        `/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=${perChunkMax + 10}`,
        { method: "GET" }, 60_000, token,
      );
      if (dRes.ok) raw = await dRes.json();
    }
    const items = raw.map((r) => ({ ...normalizeRaw(chunk.portal, r), source_chunk: label }));
    const saturated = raw.length >= perChunkMax - 2; // treat near-cap as saturated
    return {
      portal: chunk.portal, band_label: label,
      status: items.length > 0 ? "OK" : "BLOCCATO",
      run_id: runId, run_status: status,
      raw_count: raw.length, items, cost_usd: cost, saturated,
    };
  } catch (e) {
    return {
      portal: chunk.portal, band_label: label, status: "ERRORE",
      raw_count: 0, items: [], cost_usd: null, saturated: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchExitReason(runId: string, token: string): Promise<string> {
  try {
    const r = await apifyJson(`/actor-runs/${encodeURIComponent(runId)}`, { method: "GET" }, 10_000, token);
    if (!r.ok) return "";
    const j = await r.json();
    return String(j?.data?.statusMessage ?? j?.data?.exitCode ?? "");
  } catch { return ""; }
}

// ───── Firecrawl: casa.it baseline ─────
async function scrapeCasaFirecrawl(url: string, maxItems: number): Promise<{ items: NormItem[]; status: string; cost_usd: number | null; error?: string }> {
  const key = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!key) return { items: [], status: "ERRORE", cost_usd: null, error: "FIRECRAWL_API_KEY_missing" };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/v2/scrape`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: [{
          type: "json",
          prompt: `Estrai fino a ${maxItems} annunci di vendita di appartamenti residenziali a Padova. Per ciascuno: titolo, indirizzo, prezzo in euro, superficie in mq, locali, nome dell'agenzia (o "privato"), URL, lat/lng se presenti, CAP.`,
          schema: { type: "object", properties: { listings: { type: "array", items: { type: "object",
            properties: {
              title: { type: "string" }, address: { type: "string" },
              price: { type: "number" }, surface: { type: "number" }, rooms: { type: "number" },
              agency: { type: "string" }, isPrivate: { type: "boolean" },
              latitude: { type: "number" }, longitude: { type: "number" },
              cap: { type: "string" }, url: { type: "string" },
            } } } } },
        }],
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { items: [], status: "ERRORE", cost_usd: null, error: `firecrawl_${res.status}:${txt.slice(0, 150)}` };
    }
    const j = await res.json();
    const listings = (j?.data?.json?.listings ?? []) as Record<string, unknown>[];
    const items = listings.slice(0, maxItems).map((r) => normalizeRaw("casa", r));
    return { items, status: items.length > 0 ? "OK" : "BLOCCATO", cost_usd: 0.003 };
  } catch (e) {
    return { items: [], status: "ERRORE", cost_usd: null, error: e instanceof Error ? e.message : String(e) };
  } finally { clearTimeout(t); }
}

// ───── Subito (Apify, one URL, all bands) ─────
async function runSubito(perChunkMax: number, token: string): Promise<ApifyChunkResult> {
  const chunk: ApifyChunk = {
    portal: "immobiliare" as any, // placeholder for type only
    band: { min: 0, max: null },
    actor: "emastra~subito-it-immobili",
    input: {
      startUrls: ["https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/"],
      maxResultItems: perChunkMax * 2,
      onlyPrivate: true,
    },
  };
  const r = await runApifyChunk(chunk, perChunkMax * 2, token);
  // re-tag to subito
  return { ...r, portal: "subito", items: r.items.map((i) => ({ ...i, portal: "subito" })) };
}

// ───── Background orchestrator ─────
// Plan is FIXED before launch. NO auto-split: saturated bands are flagged but
// never re-divided. The total number of Apify runs is bounded by MAX_RUNS_TOTAL.
type PortalMode = "single" | "bands" | "reuse";
interface OrchestratePlan {
  immo_mode: PortalMode;
  ide_mode: PortalMode;
  immo_single_max: number;
  ide_single_max: number;
  immo_reuse?: { run_id?: string; dataset_id: string; cost_usd?: number | null } | null;
  ide_reuse?: { run_id?: string; dataset_id: string; cost_usd?: number | null } | null;
  include_subito: boolean;
  include_casa: boolean;
}

// Fetch items from an existing Apify dataset (reuse pattern, no new run).
async function reuseDatasetAsChunk(
  portal: Portal, datasetId: string, runId: string | undefined, costUsd: number | null | undefined, token: string,
): Promise<ApifyChunkResult> {
  try {
    const dRes = await apifyJson(
      `/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=5000`,
      { method: "GET" }, 90_000, token,
    );
    if (!dRes.ok) {
      return { portal, band_label: "reuse", status: "ERRORE", raw_count: 0, items: [], cost_usd: 0, saturated: false, error: `dataset_${dRes.status}` };
    }
    const raw = await dRes.json() as Record<string, unknown>[];
    const items = raw.map((r) => ({ ...normalizeRaw(portal, r), source_chunk: "reuse" }));
    return {
      portal, band_label: "reuse(cap_check)", status: items.length > 0 ? "OK" : "BLOCCATO",
      run_id: runId, run_status: "REUSED",
      raw_count: raw.length, items,
      cost_usd: 0, // reuse → no new spend in this job
      saturated: raw.length >= 1990,
    };
  } catch (e) {
    return { portal, band_label: "reuse", status: "ERRORE", raw_count: 0, items: [], cost_usd: 0, saturated: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Find the most recent SUCCEEDED run of an actor with itemCount above a threshold.
async function findReusableRun(actorId: string, minItems: number, token: string, maxAgeMin = 240): Promise<{ run_id: string; dataset_id: string; itemCount: number; usageTotalUsd: number | null; startedAt: string } | null> {
  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?status=SUCCEEDED&limit=10&desc=true&token=${encodeURIComponent(token)}`,
    );
    if (!r.ok) return null;
    const j = await r.json();
    const items = (j?.data?.items ?? []) as Array<any>;
    const cutoff = Date.now() - maxAgeMin * 60_000;
    for (const it of items) {
      const startedMs = +new Date(it.startedAt ?? it.finishedAt ?? 0);
      if (startedMs < cutoff) continue;
      const dsId = it.defaultDatasetId;
      if (!dsId) continue;
      // get item count
      const h = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(dsId)}?token=${encodeURIComponent(token)}`);
      if (!h.ok) continue;
      const hj = await h.json();
      const itemCount = Number(hj?.data?.itemCount ?? 0);
      if (itemCount >= minItems) {
        return { run_id: it.id, dataset_id: dsId, itemCount, usageTotalUsd: typeof it.usageTotalUsd === "number" ? it.usageTotalUsd : null, startedAt: it.startedAt };
      }
    }
    return null;
  } catch { return null; }
}

async function orchestrate(
  jobId: string, perChunkMax: number, poolSize: number, plan: OrchestratePlan,
) {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const token = getApifyToken();
  const updateProgress = async (patch: Record<string, unknown>) => {
    await sb.from("test_padova_full_run").update({ progress: patch }).eq("id", jobId);
  };
  const progress: Record<string, any> = {
    started_at: new Date().toISOString(),
    pool_size: poolSize, per_chunk_max: perChunkMax,
    plan,
    chunks: [] as ApifyChunkResult[],
    queue_remaining: 0, active: 0, splits: 0,
    auto_split_disabled: true,
  };

  try {
    // 1) Build the FIXED queue for immobiliare + idealista.
    const queue: ApifyChunk[] = [];
    if (plan.immo_mode === "single") {
      queue.push(buildImmoSingle(plan.immo_single_max));
    } else {
      for (const b of FIXED_BANDS_8) queue.push(buildImmoChunk(b, perChunkMax));
    }
    if (plan.ide_mode === "single") {
      queue.push(buildIdealistaSingle(plan.ide_single_max));
    } else {
      for (const b of FIXED_BANDS_8) queue.push(buildIdealistaChunk(b, perChunkMax));
    }

    const apifyMainCount = queue.length;
    const apifyTotalPlanned = apifyMainCount + (plan.include_subito ? 1 : 0);
    progress.apify_runs_planned = apifyTotalPlanned;

    if (apifyTotalPlanned > MAX_RUNS_TOTAL) {
      throw new Error(`run_cap_exceeded: planned=${apifyTotalPlanned} > MAX_RUNS_TOTAL=${MAX_RUNS_TOTAL}`);
    }

    // 2) Launch subito + casa in parallel (background).
    const sidePromise = (async () => {
      const subitoP = plan.include_subito
        ? runSubito(perChunkMax, token)
        : Promise.resolve<ApifyChunkResult>({ portal: "subito", band_label: "skipped", status: "BLOCCATO", raw_count: 0, items: [], cost_usd: 0, saturated: false });
      const casaP = plan.include_casa
        ? scrapeCasaFirecrawl("https://www.casa.it/vendita/residenziale/padova", perChunkMax)
        : Promise.resolve({ items: [], status: "BLOCCATO", cost_usd: 0 } as { items: NormItem[]; status: string; cost_usd: number | null; error?: string });
      const [subitoRes, casaRes] = await Promise.allSettled([subitoP, casaP]);
      const out: ApifyChunkResult[] = [];
      if (subitoRes.status === "fulfilled") out.push(subitoRes.value as ApifyChunkResult);
      else out.push({ portal: "subito", band_label: "all", status: "ERRORE", raw_count: 0, items: [], cost_usd: null, saturated: false, error: String(subitoRes.reason) });
      if (casaRes.status === "fulfilled") {
        const r = casaRes.value as { items: NormItem[]; status: string; cost_usd: number | null; error?: string };
        out.push({
          portal: "casa", band_label: "baseline",
          status: r.status === "OK" ? "OK" : (r.error ? "ERRORE" : "BLOCCATO"),
          raw_count: r.items.length, items: r.items.map((i) => ({ ...i, source_chunk: "baseline" })),
          cost_usd: r.cost_usd, saturated: false, error: r.error,
        });
      } else {
        out.push({ portal: "casa", band_label: "baseline", status: "ERRORE", raw_count: 0, items: [], cost_usd: null, saturated: false, error: String(casaRes.reason) });
      }
      return out;
    })();

    // 3) Worker pool — STRICTLY no auto-split. Saturated bands are recorded.
    const results: ApifyChunkResult[] = [];
    let active = 0;
    const worker = async (workerIdx: number) => {
      while (true) {
        const chunk = queue.shift();
        if (!chunk) return;
        active++;
        progress.queue_remaining = queue.length;
        progress.active = active;
        await updateProgress(progress);

        const res = await runApifyChunk(chunk, perChunkMax, token);
        results.push(res);
        progress.chunks.push({
          portal: res.portal, band_label: res.band_label, status: res.status,
          raw_count: res.raw_count, saturated: res.saturated,
          cost_usd: res.cost_usd, error: res.error, worker: workerIdx,
        });

        // NOTE: NO auto-split. Saturated bands are flagged in results only.
        // NOTE: NO requeue on memory-limit either (would breach the run cap).

        active--;
        progress.queue_remaining = queue.length;
        progress.active = active;
        await updateProgress(progress);
      }
    };
    await Promise.all(Array.from({ length: poolSize }, (_, i) => worker(i + 1)));


    // 4) Join side jobs.
    const sideResults = await sidePromise;
    results.push(...sideResults);

    // ───────────── Post-processing (same logic as previous run) ─────────────
    // Dedupe per-portal by URL.
    const seen = new Set<string>();
    const allRaw: NormItem[] = [];
    for (const r of results) for (const it of r.items) {
      const k = it.url ?? `${it.portal}:${it.address}:${it.mq}:${it.price}`;
      if (seen.has(k)) continue; seen.add(k); allRaw.push(it);
    }

    // Geocoding for items without lat/lng.
    const gKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
    const geocodeAddr = async (addr: string): Promise<{ lat: number; lng: number } | null> => {
      if (!gKey || !addr || addr.length < 5) return null;
      try {
        const q = `${addr}, Padova, Italia`;
        const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=it&key=${gKey}`;
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(u, { signal: ctrl.signal }); clearTimeout(t);
        if (!r.ok) return null;
        const j = await r.json();
        const loc = j?.results?.[0]?.geometry?.location;
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) &&
            loc.lat > 45.25 && loc.lat < 45.55 && loc.lng > 11.6 && loc.lng < 12.1) {
          return { lat: loc.lat, lng: loc.lng };
        }
        return null;
      } catch { return null; }
    };
    const needGeo = allRaw.filter((i) => (i.lat == null || i.lng == null) && !!i.address);
    const senzaGeoPre = needGeo.length;
    let geocodedOk = 0; let geocodedFail = 0;
    for (let i = 0; i < needGeo.length; i += 5) {
      const slice = needGeo.slice(i, i + 5);
      await Promise.all(slice.map(async (it) => {
        const r = await geocodeAddr(it.address!);
        if (r) { it.lat = r.lat; it.lng = r.lng; geocodedOk++; } else { geocodedFail++; }
      }));
    }
    const senzaGeoPost = allRaw.filter((i) => i.lat == null || i.lng == null).length;

    // first_seen_at historization.
    const firstSeenMap = new Map<string, string>();
    let fsInserted = 0, fsExisting = 0, fsErrors = 0;
    const itemsWithUrl = allRaw.filter((i) => !!i.url);
    const urls = itemsWithUrl.map((i) => i.url!);
    for (let i = 0; i < urls.length; i += 200) {
      const { data, error } = await sb.from("test_listing_first_seen")
        .select("url,first_seen_at").in("url", urls.slice(i, i + 200));
      if (error) { fsErrors++; continue; }
      for (const row of (data ?? [])) firstSeenMap.set(row.url, row.first_seen_at);
    }
    const upsertRows = itemsWithUrl.map((i) => ({ url: i.url!, portal: i.portal, last_seen_at: new Date().toISOString() }));
    for (let i = 0; i < upsertRows.length; i += 500) {
      const { data, error } = await sb.from("test_listing_first_seen")
        .upsert(upsertRows.slice(i, i + 500), { onConflict: "url", ignoreDuplicates: false })
        .select("url,first_seen_at");
      if (error) { fsErrors++; continue; }
      for (const row of (data ?? [])) {
        if (!firstSeenMap.has(row.url)) { firstSeenMap.set(row.url, row.first_seen_at); fsInserted++; }
        else fsExisting++;
      }
    }

    // Zone resolution via OMI point-in-polygon.
    const zoneCache = new Map<string, string>();
    const zoneFor = async (lat: number, lng: number): Promise<string> => {
      const k = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (zoneCache.has(k)) return zoneCache.get(k)!;
      try {
        const { data } = await sb.rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });
        const z = Array.isArray(data) && data[0]?.zona ? String(data[0].zona) : "Sconosciuta";
        zoneCache.set(k, z); return z;
      } catch { zoneCache.set(k, "Sconosciuta"); return "Sconosciuta"; }
    };
    type Annotated = NormItem & { zone: string; first_seen_at: string | null; giorni_online: number | null };
    const now = Date.now();
    const allItems: Annotated[] = [];
    for (const it of allRaw) {
      let zone = "Sconosciuta";
      if (it.lat != null && it.lng != null) zone = await zoneFor(it.lat, it.lng);
      if (zone === "Sconosciuta" && it.cap) zone = `CAP ${it.cap}`;
      const fs = it.url ? firstSeenMap.get(it.url) ?? null : null;
      const giorni_online = fs ? Math.floor((now - +new Date(fs)) / 86400000) : null;
      allItems.push({ ...it, zone, first_seen_at: fs, giorni_online });
    }

    // Identity matching (street+civic + mq ±8%).
    type IdCluster = { items: Annotated[]; portals: Set<string>; agencies: Set<string>; key: string };
    const idGroups = new Map<string, IdCluster>();
    for (const it of allItems) {
      const { street, civic } = normalizeAddressKey(it.address);
      if (!street || street.length < 4) continue;
      const baseKey = `${street}|${civic ?? "_"}`;
      let matched: IdCluster | null = null;
      for (const [k, c] of idGroups) {
        if (!k.startsWith(baseKey + "|")) continue;
        const ref = c.items[0];
        const mqOk = it.mq == null || ref.mq == null ||
          Math.abs((it.mq - ref.mq) / Math.max(ref.mq, 1)) <= 0.08;
        if (mqOk) { matched = c; break; }
      }
      if (matched) {
        matched.items.push(it); matched.portals.add(it.portal);
        if (it.agency) matched.agencies.add(it.agency.toLowerCase());
      } else {
        const mqBucket = it.mq != null ? Math.round(it.mq / 10) : "x";
        const key = `${baseKey}|${mqBucket}`;
        idGroups.set(key, {
          items: [it], portals: new Set([it.portal]),
          agencies: new Set(it.agency ? [it.agency.toLowerCase()] : []), key,
        });
      }
    }
    const idContendibili = [...idGroups.values()].filter((c) => c.portals.size >= 2 || c.agencies.size >= 2);
    const itemToCluster = new Map<NormItem, IdCluster>();
    for (const c of idGroups.values()) for (const it of c.items) itemToCluster.set(it, c);

    // Enrichment.
    const omiUnmapped = new Set<string>();
    const enriched = allItems.map((it) => {
      const cluster = itemToCluster.get(it);
      let prezzo_divergente: { min: number; max: number; delta_pct: number } | null = null;
      if (cluster && cluster.items.length >= 2) {
        const prices = cluster.items.map((x) => x.price).filter((p): p is number => p != null && p > 0);
        if (prices.length >= 2) {
          const min = Math.min(...prices), max = Math.max(...prices);
          const delta_pct = Math.round(((max - min) / min) * 1000) / 10;
          if (delta_pct >= 1) prezzo_divergente = { min, max, delta_pct };
        }
      }
      const isContendibile = !!cluster && (cluster.portals.size >= 2 || cluster.agencies.size >= 2);
      const privato_stanco = it.isPrivate && it.giorni_online != null && it.giorni_online > 60;
      let tipo_lead: "contendibile" | "privato_stanco" | "ribasso" | "privato" | "standard" = "standard";
      if (isContendibile) tipo_lead = "contendibile";
      else if (privato_stanco) tipo_lead = "privato_stanco";
      else if (prezzo_divergente && prezzo_divergente.delta_pct >= 5) tipo_lead = "ribasso";
      else if (it.isPrivate) tipo_lead = "privato";

      const omiCode = /^[A-Z]\d/.test(it.zone) ? it.zone : null;
      let quartiere: string;
      if (omiCode && OMI_QUARTIERE[omiCode]) quartiere = OMI_QUARTIERE[omiCode];
      else if (omiCode) { quartiere = `(non mappato)`; omiUnmapped.add(omiCode); }
      else quartiere = it.zone;

      return { ...it, quartiere, omi_code: omiCode, privato_stanco, prezzo_divergente, tipo_lead, contendibile: isContendibile };
    });

    // Per-quartiere table.
    const byQ = new Map<string, typeof enriched>();
    for (const e of enriched) {
      const key = `${e.omi_code ?? e.zone}|${e.quartiere}`;
      const arr = byQ.get(key) ?? []; arr.push(e); byQ.set(key, arr);
    }
    const tabella_per_quartiere = [...byQ.entries()].map(([key, items]) => {
      const [omi, quartiere] = key.split("|");
      return {
        codice_omi: omi, quartiere,
        annunci_tot: items.length,
        contendibili: items.filter((i) => i.contendibile).length,
        privati: items.filter((i) => i.isPrivate).length,
        privati_stanchi: items.filter((i) => i.privato_stanco).length,
        ribassi: items.filter((i) => i.tipo_lead === "ribasso").length,
        agenzie_distinte: new Set(items.filter((i) => i.agency).map((i) => i.agency!.toLowerCase())).size,
      };
    }).sort((a, b) => b.contendibili - a.contendibili || b.annunci_tot - a.annunci_tot);

    const conteggi_tipo_lead = {
      contendibile: enriched.filter((e) => e.tipo_lead === "contendibile").length,
      privato_stanco: enriched.filter((e) => e.tipo_lead === "privato_stanco").length,
      ribasso: enriched.filter((e) => e.tipo_lead === "ribasso").length,
      privato: enriched.filter((e) => e.tipo_lead === "privato").length,
      standard: enriched.filter((e) => e.tipo_lead === "standard").length,
    };

    const totalCost = results.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

    const per_portal_summary = (["immobiliare", "idealista", "subito", "casa"] as Portal[]).map((p) => {
      const portalChunks = results.filter((r) => r.portal === p);
      const annunci = enriched.filter((i) => i.portal === p);
      return {
        portal: p,
        chunks_completati: portalChunks.filter((r) => r.status === "OK" || r.status === "BLOCCATO").length,
        chunks_totali: portalChunks.length,
        chunks_saturi_residui: portalChunks.filter((r) => r.saturated).length,
        chunks_errore: portalChunks.filter((r) => r.status === "ERRORE" || r.status === "MEMORY_LIMIT" || r.status === "RUNNING_TIMEOUT").length,
        annunci_dedup: annunci.length,
        privati: annunci.filter((i) => i.isPrivate).length,
        cost_usd: Number(portalChunks.reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(4)),
      };
    });

    const esempi_contendibili = idContendibili.slice(0, 10).map((c) => ({
      portals: [...c.portals], agencies_distinct: c.agencies.size, n_items: c.items.length,
      address_sample: c.items[0].address?.slice(0, 90),
      codice_omi: /^[A-Z]\d/.test(c.items[0].zone) ? c.items[0].zone : null,
      quartiere: OMI_QUARTIERE[c.items[0].zone] ?? c.items[0].zone,
      members: c.items.map((i) => ({ portal: i.portal, mq: i.mq, price: i.price, agency: i.agency, url: i.url })),
    }));

    const finalResult = {
      ok: true,
      geocoding: {
        candidati_senza_geo: senzaGeoPre,
        geocodati_ok: geocodedOk, geocodati_falliti: geocodedFail,
        ancora_senza_geo: senzaGeoPost,
        provider: gKey ? "google_maps" : "none",
      },
      first_seen_at: {
        tabella_staging: "public.test_listing_first_seen",
        annunci_con_url: itemsWithUrl.length,
        nuovi_inseriti_oggi: fsInserted,
        gia_esistenti_storicizzati: fsExisting,
        errori_db: fsErrors,
        nota: "Storicizzazione attiva: ad ogni run aggiorniamo last_seen_at; first_seen_at resta immutabile dal primo incontro.",
      },
      chunking: {
        per_chunk_max: perChunkMax,
        pool_size: poolSize,
        plan,
        auto_split_disabled: true,
        tetto_max_runs_apify: MAX_RUNS_TOTAL,
        apify_runs_eseguite_totali: results.filter((r) => r.portal !== "casa").length,
        chunks_totali: results.filter((r) => r.portal === "immobiliare" || r.portal === "idealista").length,
        chunks_completati_ok: results.filter((r) => (r.portal === "immobiliare" || r.portal === "idealista") && (r.status === "OK" || r.status === "BLOCCATO")).length,
        bande_sature_non_divise: results.filter((r) => r.saturated).map((r) => ({ portal: r.portal, band: r.band_label, raw: r.raw_count })),
        dettaglio: results
          .filter((r) => r.portal === "immobiliare" || r.portal === "idealista")
          .map((r) => ({ portal: r.portal, band: r.band_label, status: r.status, raw: r.raw_count, saturated: r.saturated, cost_usd: r.cost_usd, error: r.error })),
      },
      riepilogo_per_portale: per_portal_summary,
      omi_quartiere: {
        mappa_utilizzata: OMI_QUARTIERE,
        codici_omi_non_mappati: [...omiUnmapped].sort(),
      },
      matching: {
        metodo: "IDENTITA via+civico+mq8% (prezzo NON usato come filtro)",
        contendibili_totali: idContendibili.length,
        contendibili_con_prezzo_divergente: enriched.filter((e) => e.contendibile && e.prezzo_divergente).length,
        esempi: esempi_contendibili,
      },
      tabella_per_quartiere,
      conteggi_tipo_lead,
      aggregato: {
        annunci_totali_dedup: enriched.length,
        con_coords_finali: enriched.filter((i) => i.lat != null && i.lng != null).length,
        privati_totali: enriched.filter((i) => i.isPrivate).length,
        cost_totale_usd: Number(totalCost.toFixed(4)),
      },
    };

    await sb.from("test_padova_full_run")
      .update({ state: "done", finished_at: new Date().toISOString(), progress, result: finalResult })
      .eq("id", jobId);
  } catch (e) {
    await sb.from("test_padova_full_run")
      .update({ state: "error", finished_at: new Date().toISOString(),
        progress: { ...progress, fatal_error: e instanceof Error ? e.message : String(e) } })
      .eq("id", jobId);
  }
}

// ───── HTTP entrypoint ─────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const hasJobSecret = jobSecret && req.headers.get("x-job-secret") === jobSecret;
  const authHeader = req.headers.get("Authorization") ?? "";
  let hasUser = false;
  if (!hasJobSecret && authHeader.startsWith("Bearer ")) {
    try {
      const sbA = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data } = await sbA.auth.getClaims(authHeader.replace("Bearer ", ""));
      if (data?.claims?.sub) hasUser = true;
    } catch { /* ignore */ }
  }
  if (!hasJobSecret && !hasUser) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const action = String(body.action ?? "run").toLowerCase();
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  if (action === "status") {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return json({ ok: false, error: "missing_job_id" }, 400);
    const { data, error } = await sb.from("test_padova_full_run")
      .select("id,started_at,finished_at,state,progress,result").eq("id", jobId).maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 500);
    if (!data) return json({ ok: false, error: "job_not_found" }, 404);
    return json({ ok: true, job_id: jobId, ...data });
  }

  // ACTION: abort → aborts ALL currently-running Apify runs on the account.
  // Editing/redeploying this file also kills the background orchestrator isolate.
  if (action === "abort") {
    const jobId = String(body.job_id ?? "");
    const listRes = await fetch(
      `https://api.apify.com/v2/actor-runs?status=RUNNING&limit=100&token=${encodeURIComponent(token)}`,
    );
    const listJson = await listRes.json().catch(() => ({}));
    const items = (listJson?.data?.items ?? []) as Array<{ id: string; actId: string }>;
    const aborted: Array<{ id: string; actId: string; status: number }> = [];
    for (const it of items) {
      const a = await fetch(
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(it.id)}/abort?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      aborted.push({ id: it.id, actId: it.actId, status: a.status });
    }
    if (jobId) {
      await sb.from("test_padova_full_run")
        .update({ state: "aborted", finished_at: new Date().toISOString() })
        .eq("id", jobId);
    }
    return json({ ok: true, action: "abort", aborted_count: aborted.length, aborted, job_id: jobId || null });
  }

  // ACTION: cap_check → one Apify run per portal with high maxItems.
  // ACTION: cap_check → fire 1 Apify run per portal, return run_ids immediately.
  // Poll later with action "cap_check_status" {run_ids:[{portal,actor,run_id,dataset_id}]}.
  if (action === "cap_check") {
    const maxItems = Math.min(Number(body.maxItems ?? 2000), 5000);
    const tests = [
      {
        portal: "immobiliare",
        actor: "azzouzana~immobiliare-it-listing-page-scraper-by-search-url",
        param_used: "maxItems+resultsLimit+maxRequestsPerCrawl",
        input: {
          startUrl: "https://www.immobiliare.it/vendita-case/padova/?criterio=rilevanza",
          maxItems, resultsLimit: maxItems, maxRequestsPerCrawl: maxItems + 50,
        },
      },
      {
        portal: "idealista",
        actor: "memo23~idealista-scraper",
        param_used: "maxItems+resultsLimit+maxRequestsPerCrawl",
        input: {
          startUrls: [{ url: "https://www.idealista.it/vendita-case/padova-padova/" }],
          maxItems, resultsLimit: maxItems, maxRequestsPerCrawl: maxItems + 50,
          proxy: { useApifyProxy: true },
        },
      },
    ];
    const started = await Promise.all(tests.map(async (t) => {
      const r = await fetch(
        `https://api.apify.com/v2/acts/${encodeURIComponent(t.actor)}/runs?token=${encodeURIComponent(token)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t.input) },
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return { portal: t.portal, actor: t.actor, ok: false, status: r.status, error: txt.slice(0, 300) };
      }
      const j = await r.json();
      return {
        portal: t.portal, actor: t.actor, param_used: t.param_used,
        run_id: j?.data?.id, dataset_id: j?.data?.defaultDatasetId, started_at: j?.data?.startedAt,
      };
    }));
    return json({
      ok: true, action: "cap_check", maxItems_requested: maxItems, started,
      poll: `POST {"action":"cap_check_status","runs":[...started]}`,
    });
  }

  if (action === "cap_check_status") {
    const runs = (body.runs ?? []) as Array<{ portal: string; actor: string; param_used?: string; run_id: string; dataset_id?: string }>;
    const results = await Promise.all(runs.map(async (r) => {
      const s = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(r.run_id)}?token=${encodeURIComponent(token)}`);
      if (!s.ok) return { ...r, error: `status_${s.status}` };
      const sj = await s.json();
      const runStatus = sj?.data?.status ?? "unknown";
      const cost = typeof sj?.data?.usageTotalUsd === "number" ? sj.data.usageTotalUsd : null;
      const dsId = sj?.data?.defaultDatasetId ?? r.dataset_id;
      let rawCount: number | null = null;
      if (dsId) {
        const h = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(dsId)}?token=${encodeURIComponent(token)}`);
        if (h.ok) { const hj = await h.json(); rawCount = hj?.data?.itemCount ?? null; }
      }
      return {
        portal: r.portal, actor: r.actor, param_used: r.param_used,
        run_id: r.run_id, run_status: runStatus, raw_count: rawCount, cost_usd: cost,
        hit_200_wall: rawCount != null && rawCount > 0 && rawCount <= 210,
        went_beyond_200: rawCount != null && rawCount > 210,
      };
    }));
    const totalCost = results.reduce((s, x: any) => s + (typeof x.cost_usd === "number" ? x.cost_usd : 0), 0);
    return json({
      ok: true, action: "cap_check_status", results, total_cost_usd: Number(totalCost.toFixed(4)),
      verdict: results.map((r: any) =>
        r.went_beyond_200 ? `${r.portal}: ✅ cap superabile (${r.raw_count})`
        : r.hit_200_wall ? `${r.portal}: ❌ muro 200 (${r.raw_count})`
        : `${r.portal}: ⏳ ${r.run_status ?? r.error ?? "?"}`),
    });
  }


  // action === "run" | "run_fixed"  — requires explicit plan, NO auto-split.
  const perChunkMax = Math.min(Number(body.perChunkMax ?? 200), 250);
  const poolSize = Math.min(Math.max(Number(body.poolSize ?? 3), 1), 6);

  const planIn = (body.plan ?? {}) as Record<string, unknown>;
  const plan: OrchestratePlan = {
    immo_mode: (planIn.immo_mode === "single" ? "single" : "bands"),
    ide_mode: (planIn.ide_mode === "single" ? "single" : "bands"),
    immo_single_max: Math.min(Number(planIn.immo_single_max ?? 2000), 5000),
    ide_single_max: Math.min(Number(planIn.ide_single_max ?? 2000), 5000),
    include_subito: planIn.include_subito !== false,
    include_casa: planIn.include_casa !== false,
  };

  // Hard ceiling check BEFORE inserting / launching.
  const apifyPlanned =
    (plan.immo_mode === "single" ? 1 : FIXED_BANDS_8.length) +
    (plan.ide_mode === "single" ? 1 : FIXED_BANDS_8.length) +
    (plan.include_subito ? 1 : 0);
  if (apifyPlanned > MAX_RUNS_TOTAL) {
    return json({
      ok: false, error: "run_cap_exceeded",
      apify_runs_planned: apifyPlanned,
      tetto_max_runs_apify: MAX_RUNS_TOTAL,
      plan,
      hint: "Riduci a 'single' almeno un portale o disattiva subito.",
    }, 400);
  }

  const { data: ins, error: insErr } = await sb.from("test_padova_full_run")
    .insert({ state: "running", progress: { queued: true, pool_size: poolSize, per_chunk_max: perChunkMax, plan, apify_runs_planned: apifyPlanned } })
    .select("id").single();
  if (insErr || !ins) return json({ ok: false, error: insErr?.message ?? "insert_failed" }, 500);
  const jobId = ins.id as string;

  // Fire-and-forget orchestration.
  // @ts-ignore EdgeRuntime is provided by Supabase runtime
  EdgeRuntime.waitUntil(orchestrate(jobId, perChunkMax, poolSize, plan));

  return json({
    ok: true, job_id: jobId, plan,
    apify_runs_planned: apifyPlanned, tetto_max_runs_apify: MAX_RUNS_TOTAL,
    poll: `POST {"action":"status","job_id":"${jobId}"} every 30-60s until state="done"`,
    pool_size: poolSize, per_chunk_max: perChunkMax,
    expected_duration: "5-20 minuti (NO auto-split, run count fisso)",
  });
});

