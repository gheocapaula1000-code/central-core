// test-apify-immobiliare-padova
// One-shot CONTROLLED TEST: runs Apify actor `epctex/immobiliare-it-scraper`
// targeted only on Padova (vendita residenziale), max ~150 listings.
// Does NOT write to production tables. Returns JSON report with
// per-zone breakdown + comparison vs listing_identity (casa.it baseline).
//
// Auth: x-job-secret == CENTRAL_CORE_JOB_SECRET.
// Cost: a single Apify run; usageTotalUsd is read from the run record.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY_BASE = "https://api.apify.com/v2";

interface RawItem {
  url?: string;
  title?: string;
  price?: number | string;
  address?: string;
  location?: string;
  city?: string;
  zone?: string;
  neighborhood?: string;
  zip?: string;
  cap?: string;
  surface?: number | string;
  area?: number | string;
  size?: number | string;
  rooms?: number | string;
  locali?: number | string;
  agency?: string;
  agencyName?: string;
  advertiser?: { name?: string; type?: string };
  contact?: { name?: string; type?: string };
  isPrivate?: boolean;
  latitude?: number | string;
  longitude?: number | string;
  lat?: number | string;
  lng?: number | string;
  [k: string]: unknown;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function pickAgency(it: RawItem): { name: string | null; isPrivate: boolean } {
  const name =
    (typeof it.agency === "string" && it.agency) ||
    (typeof it.agencyName === "string" && it.agencyName) ||
    (it.advertiser && typeof it.advertiser.name === "string" ? it.advertiser.name : "") ||
    (it.contact && typeof it.contact.name === "string" ? it.contact.name : "") ||
    "";
  const type =
    (it.advertiser && typeof it.advertiser.type === "string" ? it.advertiser.type : "") ||
    (it.contact && typeof it.contact.type === "string" ? it.contact.type : "");
  const isPrivate =
    it.isPrivate === true ||
    /priv/i.test(String(type)) ||
    (!name || /priv/i.test(name));
  return { name: name ? String(name).trim().slice(0, 120) : null, isPrivate };
}

function slugTitle(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ");
}

async function apifyJson(path: string, init: RequestInit, timeoutMs: number, token: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${APIFY_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  } finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const hasJobSecret = jobSecret && req.headers.get("x-job-secret") === jobSecret;
  const authHeader = req.headers.get("Authorization") ?? "";
  let hasAuthedUser = false;
  if (!hasJobSecret && authHeader.startsWith("Bearer ")) {
    try {
      const sbAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data } = await sbAuth.auth.getClaims(authHeader.replace("Bearer ", ""));
      if (data?.claims?.sub) hasAuthedUser = true;
    } catch { /* ignore */ }
  }
  if (!hasJobSecret && !hasAuthedUser) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = getApifyToken();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "APIFY_API_TOKEN_missing" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const action = String(body.action ?? "start").toLowerCase();
  const maxItems = Math.min(Number(body.maxItems ?? 150), 200);
  const actorId = String(body.actor ?? "memo23~immobiliare-scraper");

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // ─────────────────────────────────────────────
  // ACTION: start → fires the Apify run, returns runId immediately.
  // ─────────────────────────────────────────────
  if (action === "start") {
    const input = {
      startUrls: ["https://www.immobiliare.it/vendita-case/padova/"],
      maxItems,
      includeAgencyDetails: false,
      proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    };
    const startRes = await apifyJson(
      `/acts/${encodeURIComponent(actorId)}/runs`,
      { method: "POST", body: JSON.stringify(input) },
      30_000, token,
    );
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => "");
      return json({
        ok: false, stage: "apify_start", status: startRes.status,
        error: txt.slice(0, 400).replace(/token=[^&\s]+/gi, "token=[redacted]"),
        hint: startRes.status === 402 ? "actor_requires_paid_plan_or_rental" :
              startRes.status === 404 ? "actor_not_found_check_slug" :
              startRes.status === 401 ? "apify_token_invalid" : "apify_start_failed",
      }, 502);
    }
    const started = await startRes.json();
    return json({
      ok: true, action: "start", actor_id: actorId,
      run_id: started?.data?.id,
      dataset_id: started?.data?.defaultDatasetId,
      run_status: started?.data?.status ?? "READY",
      next: `POST again with {"action":"results","runId":"${started?.data?.id}"} after ~60-120s`,
    });
  }

  // ─────────────────────────────────────────────
  // ACTION: results → polls (briefly) + fetches dataset + analyzes.
  // ─────────────────────────────────────────────
  const runId = String(body.runId ?? "");
  if (!runId) return json({ ok: false, error: "missing_runId" }, 400);

  // Brief poll (max ~45s) to wait for SUCCEEDED if still running.
  let runStatus = "unknown";
  let datasetId: string | undefined;
  let usageTotalUsd: number | null = null;
  let computeUnits: number | null = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const s = await apifyJson(`/actor-runs/${encodeURIComponent(runId)}`, { method: "GET" }, 15_000, token);
    if (!s.ok) {
      const t = await s.text().catch(() => "");
      return json({ ok: false, stage: "run_status", status: s.status, error: t.slice(0, 300) }, 502);
    }
    const sj = await s.json();
    runStatus = sj?.data?.status ?? "unknown";
    datasetId = sj?.data?.defaultDatasetId;
    usageTotalUsd = typeof sj?.data?.usageTotalUsd === "number" ? sj.data.usageTotalUsd : null;
    computeUnits = typeof sj?.data?.stats?.computeUnits === "number" ? sj.data.stats.computeUnits : null;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(runStatus)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(runStatus)) {
    return json({
      ok: false, status: "still_running", run_id: runId, run_status: runStatus,
      cost_usd_so_far: usageTotalUsd, compute_units_so_far: computeUnits,
      hint: "retry POST {action:'results',runId} in 30-60s",
    });
  }

  let items: RawItem[] = [];
  if (datasetId) {
    const dRes = await apifyJson(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=${maxItems}`, { method: "GET" }, 60_000, token);
    if (dRes.ok) items = (await dRes.json()) as RawItem[];
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Helper: parallel-bounded zone lookup with cache.
  const zoneCache = new Map<string, string>();
  const zoneFor = async (lat: number, lng: number): Promise<string> => {
    const k = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (zoneCache.has(k)) return zoneCache.get(k)!;
    try {
      const { data } = await sb.rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });
      const z = Array.isArray(data) && data[0]?.zona ? String(data[0].zona) : "Sconosciuta";
      zoneCache.set(k, z);
      return z;
    } catch { zoneCache.set(k, "Sconosciuta"); return "Sconosciuta"; }
  };

  type Norm = {
    title: string | null; address: string | null; price: number | null; mq: number | null;
    rooms: number | null; agency: string | null; isPrivate: boolean; url: string | null;
    lat: number | null; lng: number | null; cap: string | null;
    zone: string; zoneSource: "omi_point" | "cap" | "address_token" | "unknown";
  };
  const normalized: Norm[] = items.map((it) => {
    const lat = num(it.latitude ?? it.lat);
    const lng = num(it.longitude ?? it.lng);
    const cap = String(it.cap ?? it.zip ?? "").replace(/\D/g, "").slice(0, 5) || null;
    const address = (typeof it.address === "string" && it.address) || (typeof it.location === "string" && it.location) || null;
    const ag = pickAgency(it);
    return {
      title: typeof it.title === "string" ? it.title : null,
      address,
      price: num(it.price),
      mq: num(it.surface ?? it.area ?? it.size),
      rooms: num(it.rooms ?? it.locali),
      agency: ag.name, isPrivate: ag.isPrivate,
      url: typeof it.url === "string" ? it.url : null,
      lat, lng, cap, zone: "Sconosciuta", zoneSource: "unknown" as const,
    };
  });

  // Resolve zones for apify items (parallel, batched at 12).
  const runBatch = async <T,>(arr: T[], n: number, fn: (x: T) => Promise<void>) => {
    for (let i = 0; i < arr.length; i += n) {
      await Promise.all(arr.slice(i, i + n).map(fn));
    }
  };
  await runBatch(normalized, 12, async (n) => {
    if (n.lat != null && n.lng != null) {
      const z = await zoneFor(n.lat, n.lng);
      if (z !== "Sconosciuta") { n.zone = z; n.zoneSource = "omi_point"; return; }
    }
    if (n.cap) { n.zone = `CAP ${n.cap}`; n.zoneSource = "cap"; }
  });

  const total = normalized.length;
  const withAgency = normalized.filter((n) => !n.isPrivate && n.agency).length;
  const privati = normalized.filter((n) => n.isPrivate).length;

  // Baseline casa.it.
  const { data: baseline } = await sb
    .from("listing_identity")
    .select("identity_hash, sources_seen, agencies_seen, lat_rounded, lng_rounded, surface_sqm")
    .ilike("municipality", "padova");
  const baseRows = Array.isArray(baseline) ? baseline : [];

  const baselineByZone = new Map<string, { count: number; multiSource: number }>();
  const baselineAll = { count: baseRows.length, multiSource: 0 };
  type BK = { lat: number; lng: number; mq: number | null; agencies: string[]; zone: string };
  const baselineKeys: BK[] = [];
  for (const b of baseRows) {
    const agencies = Array.isArray(b.agencies_seen) ? b.agencies_seen.map(String) : [];
    const sources = Array.isArray(b.sources_seen) ? b.sources_seen.map(String) : [];
    if (sources.length >= 2 || agencies.length >= 2) baselineAll.multiSource++;
    const lat = b.lat_rounded != null ? Number(b.lat_rounded) : NaN;
    const lng = b.lng_rounded != null ? Number(b.lng_rounded) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      baselineKeys.push({ lat, lng, mq: b.surface_sqm ?? null, agencies, zone: "Sconosciuta" });
    }
  }
  await runBatch(baselineKeys, 12, async (b) => { b.zone = await zoneFor(b.lat, b.lng); });
  for (const b of baselineKeys) {
    const slot = baselineByZone.get(b.zone) ?? { count: 0, multiSource: 0 };
    slot.count++;
    if (b.agencies.length >= 2) slot.multiSource++;
    baselineByZone.set(b.zone, slot);
  }

  // Cross-match.
  let newContendibiliTotal = 0;
  const newContByZone = new Map<string, number>();
  for (const n of normalized) {
    if (n.lat == null || n.lng == null) continue;
    const match = baselineKeys.find((b) => {
      if (Math.abs(b.lat - n.lat!) > 0.0006 || Math.abs(b.lng - n.lng!) > 0.0008) return false;
      if (n.mq != null && b.mq != null && Math.abs(n.mq - b.mq) > 6) return false;
      return true;
    });
    if (!match) continue;
    const isNewAgency = !!n.agency && !match.agencies.some((a) => a.toLowerCase().includes(n.agency!.toLowerCase().slice(0, 8)));
    if (match.agencies.length < 2 && isNewAgency) {
      newContendibiliTotal++;
      newContByZone.set(n.zone, (newContByZone.get(n.zone) ?? 0) + 1);
    }
  }

  // Per-zone vendibility.
  const apifyByZone = new Map<string, { count: number; privati: number; agencies: Set<string> }>();
  for (const n of normalized) {
    const slot = apifyByZone.get(n.zone) ?? { count: 0, privati: 0, agencies: new Set<string>() };
    slot.count++;
    if (n.isPrivate) slot.privati++;
    if (n.agency) slot.agencies.add(n.agency);
    apifyByZone.set(n.zone, slot);
  }
  const allZones = new Set<string>([...apifyByZone.keys(), ...baselineByZone.keys()]);
  const vendibilita = [...allZones].map((zona) => {
    const a = apifyByZone.get(zona);
    const b = baselineByZone.get(zona);
    const newCont = newContByZone.get(zona) ?? 0;
    return {
      zona,
      annunci_immobiliare_it: a?.count ?? 0,
      annunci_casa_it_baseline: b?.count ?? 0,
      contendibili_post_merge: (b?.multiSource ?? 0) + newCont,
      nuovi_contendibili_sbloccati: newCont,
      privati_immobiliare: a?.privati ?? 0,
      agenzie_distinte_immobiliare: a ? a.agencies.size : 0,
    };
  }).sort((x, y) => y.contendibili_post_merge - x.contendibili_post_merge);

  const sample = normalized.slice(0, 5).map((n) => ({
    title: n.title?.slice(0, 80), address: n.address?.slice(0, 80),
    price: n.price, mq: n.mq, rooms: n.rooms, agency: n.agency, isPrivate: n.isPrivate,
    zone: n.zone, zoneSource: n.zoneSource, url: n.url,
  }));

  return json({
    ok: true,
    test_run: { actor_id: actorId, run_id: runId, dataset_id: datasetId, run_status: runStatus,
      cost_usd: usageTotalUsd, compute_units: computeUnits },
    coverage: {
      annunci_totali_immobiliare_padova: total,
      annunci_con_agenzia: withAgency, annunci_privati: privati,
      annunci_senza_zona_risolta: normalized.filter((n) => n.zoneSource === "unknown").length,
      annunci_senza_coords: normalized.filter((n) => n.lat == null || n.lng == null).length,
    },
    baseline_casa_it: {
      righe_listing_identity_padova: baselineAll.count,
      righe_con_coords: baselineKeys.length,
      multi_source_attuali: baselineAll.multiSource,
    },
    nuovi_contendibili_sbloccati_totale: newContendibiliTotal,
    vendibilita_per_zona: vendibilita,
    sample_annunci: sample,
    warnings: items.length === 0
      ? [`dataset_vuoto: actor run=${runStatus}. Vedi run su Apify per stderr.`]
      : [],
  });
});

