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
  const maxItems = Math.min(Number(body.maxItems ?? 150), 200);
  const actorId = String(body.actor ?? "memo23~immobiliare-scraper");

  const input = {
    startUrls: ["https://www.immobiliare.it/vendita-case/padova/"],
    maxItems,
    includeAgencyDetails: false,
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };

  // 1) Run actor synchronously and fetch dataset items.
  const t0 = Date.now();
  let runId: string | undefined;
  let datasetId: string | undefined;
  let items: RawItem[] = [];
  let runStatus = "unknown";

  try {
    const startRes = await apifyJson(
      `/acts/${encodeURIComponent(actorId)}/runs`,
      { method: "POST", body: JSON.stringify(input) },
      30_000, token,
    );
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => "");
      return new Response(JSON.stringify({
        ok: false,
        stage: "apify_start",
        status: startRes.status,
        error: txt.slice(0, 400).replace(/token=[^&\s]+/gi, "token=[redacted]"),
        hint: startRes.status === 402 ? "actor_requires_paid_plan_or_rental" :
              startRes.status === 404 ? "actor_not_found_check_slug" :
              startRes.status === 401 ? "apify_token_invalid" : "apify_start_failed",
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const started = await startRes.json();
    runId = started?.data?.id;
    datasetId = started?.data?.defaultDatasetId;
    runStatus = started?.data?.status ?? "READY";

    // Poll until done (max 3 minutes).
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(runStatus)) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await apifyJson(`/actor-runs/${runId}`, { method: "GET" }, 15_000, token);
      if (!s.ok) break;
      const sj = await s.json();
      runStatus = sj?.data?.status ?? runStatus;
      datasetId = sj?.data?.defaultDatasetId ?? datasetId;
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, stage: "apify_run", error: e instanceof Error ? e.message : String(e) }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 2) Fetch dataset items.
  if (datasetId) {
    try {
      const dRes = await apifyJson(`/datasets/${datasetId}/items?clean=true&limit=${maxItems}`, { method: "GET" }, 60_000, token);
      if (dRes.ok) items = (await dRes.json()) as RawItem[];
    } catch { /* ignore */ }
  }

  // 3) Fetch run cost/usage.
  let usageTotalUsd: number | null = null;
  let computeUnits: number | null = null;
  if (runId) {
    try {
      const r = await apifyJson(`/actor-runs/${runId}`, { method: "GET" }, 15_000, token);
      if (r.ok) {
        const rj = await r.json();
        usageTotalUsd = typeof rj?.data?.usageTotalUsd === "number" ? rj.data.usageTotalUsd : null;
        computeUnits = typeof rj?.data?.stats?.computeUnits === "number" ? rj.data.stats.computeUnits : null;
      }
    } catch { /* ignore */ }
  }

  // 4) Normalize + zone resolution via OMI geometry.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  type Norm = {
    title: string | null; address: string | null; price: number | null; mq: number | null;
    rooms: number | null; agency: string | null; isPrivate: boolean; url: string | null;
    lat: number | null; lng: number | null; cap: string | null;
    zone: string; zoneSource: "omi_point" | "cap" | "address_token" | "unknown";
    titleKey: string;
  };
  const normalized: Norm[] = [];
  for (const it of items) {
    const lat = num(it.latitude ?? it.lat);
    const lng = num(it.longitude ?? it.lng);
    const cap = String(it.cap ?? it.zip ?? "").replace(/\D/g, "").slice(0, 5) || null;
    const address = (typeof it.address === "string" && it.address) || (typeof it.location === "string" && it.location) || null;
    let zone = "Sconosciuta";
    let zoneSource: Norm["zoneSource"] = "unknown";

    if (lat != null && lng != null) {
      try {
        const { data } = await sb.rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });
        if (Array.isArray(data) && data[0]?.zona) {
          zone = String(data[0].zona);
          zoneSource = "omi_point";
        }
      } catch { /* ignore */ }
    }
    if (zone === "Sconosciuta") {
      const declared = (typeof it.zone === "string" && it.zone) || (typeof it.neighborhood === "string" && it.neighborhood) || "";
      if (declared) { zone = declared.trim(); zoneSource = "address_token"; }
      else if (cap) { zone = `CAP ${cap}`; zoneSource = "cap"; }
    }

    const ag = pickAgency(it);
    normalized.push({
      title: typeof it.title === "string" ? it.title : null,
      address,
      price: num(it.price),
      mq: num(it.surface ?? it.area ?? it.size),
      rooms: num(it.rooms ?? it.locali),
      agency: ag.name,
      isPrivate: ag.isPrivate,
      url: typeof it.url === "string" ? it.url : null,
      lat, lng, cap, zone, zoneSource,
      titleKey: address ? slugTitle(address) : (typeof it.title === "string" ? slugTitle(it.title) : ""),
    });
  }

  const total = normalized.length;
  const withAgency = normalized.filter((n) => !n.isPrivate && n.agency).length;
  const privati = normalized.filter((n) => n.isPrivate).length;

  // 5) Casa.it baseline from listing_identity (Padova).
  const { data: baseline } = await sb
    .from("listing_identity")
    .select("identity_hash, sources_seen, agencies_seen, lat_rounded, lng_rounded, surface_sqm, rooms, municipality")
    .ilike("municipality", "padova");
  const baseRows = Array.isArray(baseline) ? baseline : [];

  // Zone-map baseline rows via point-in-polygon (only those with coords).
  const baselineByZone = new Map<string, { count: number; multiSource: number; agencies: Set<string> }>();
  const baselineAll = { count: baseRows.length, multiSource: 0 };
  // For matching with apify: collect baseline coord pairs + surface buckets.
  const baselineKeys: Array<{ lat: number; lng: number; mq: number | null; agencies: string[] }> = [];
  for (const b of baseRows) {
    const agencies = Array.isArray(b.agencies_seen) ? b.agencies_seen : [];
    const sources = Array.isArray(b.sources_seen) ? b.sources_seen : [];
    if (sources.length >= 2 || agencies.length >= 2) baselineAll.multiSource++;
    const lat = b.lat_rounded != null ? Number(b.lat_rounded) : NaN;
    const lng = b.lng_rounded != null ? Number(b.lng_rounded) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      baselineKeys.push({ lat, lng, mq: b.surface_sqm ?? null, agencies });
      try {
        const { data } = await sb.rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });
        const zona = Array.isArray(data) && data[0]?.zona ? String(data[0].zona) : "Sconosciuta";
        const slot = baselineByZone.get(zona) ?? { count: 0, multiSource: 0, agencies: new Set<string>() };
        slot.count++;
        if (agencies.length >= 2 || sources.length >= 2) slot.multiSource++;
        for (const a of agencies) slot.agencies.add(String(a));
        baselineByZone.set(zona, slot);
      } catch { /* ignore */ }
    }
  }

  // 6) Match each apify item with baseline → new contendibili candidates.
  //    Match by lat/lng proximity (~50m) + mq tolerance (±5).
  let newContendibiliTotal = 0;
  const newContByZone = new Map<string, number>();
  for (const n of normalized) {
    if (n.lat == null || n.lng == null) continue;
    const match = baselineKeys.find((b) => {
      const dLat = Math.abs(b.lat - n.lat!);
      const dLng = Math.abs(b.lng - n.lng!);
      if (dLat > 0.0006 || dLng > 0.0008) return false; // ~60m
      if (n.mq != null && b.mq != null && Math.abs(n.mq - b.mq) > 6) return false;
      return true;
    });
    if (!match) continue;
    // Already had this listing in baseline. Is the immobiliare agency distinct from casa.it agencies?
    const isNewAgency = !!n.agency && !match.agencies.some((a) => a.toLowerCase().includes(n.agency!.toLowerCase().slice(0, 8)));
    const wasMonoSource = match.agencies.length < 2;
    if (wasMonoSource && isNewAgency) {
      newContendibiliTotal++;
      newContByZone.set(n.zone, (newContByZone.get(n.zone) ?? 0) + 1);
    }
  }

  // 7) Per-zone vendibility table.
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
    const apifyCount = a?.count ?? 0;
    const casaCount = b?.count ?? 0;
    const baselineMulti = b?.multiSource ?? 0;
    const newCont = newContByZone.get(zona) ?? 0;
    const contendibiliPostMerge = baselineMulti + newCont;
    return {
      zona,
      annunci_immobiliare_it: apifyCount,
      annunci_casa_it_baseline: casaCount,
      contendibili_post_merge: contendibiliPostMerge,
      nuovi_contendibili_sbloccati: newCont,
      privati_immobiliare: a?.privati ?? 0,
      agenzie_distinte_immobiliare: a ? a.agencies.size : 0,
    };
  }).sort((x, y) => y.contendibili_post_merge - x.contendibili_post_merge);

  const elapsedMs = Date.now() - t0;
  const sample = normalized.slice(0, 5).map((n) => ({
    title: n.title?.slice(0, 80), address: n.address?.slice(0, 80),
    price: n.price, mq: n.mq, rooms: n.rooms, agency: n.agency, isPrivate: n.isPrivate,
    zone: n.zone, zoneSource: n.zoneSource, url: n.url,
  }));

  return new Response(JSON.stringify({
    ok: true,
    test_run: {
      actor_id: actorId,
      run_id: runId,
      dataset_id: datasetId,
      run_status: runStatus,
      elapsed_ms: elapsedMs,
      cost_usd: usageTotalUsd,
      compute_units: computeUnits,
    },
    coverage: {
      annunci_totali_immobiliare_padova: total,
      annunci_con_agenzia: withAgency,
      annunci_privati: privati,
      annunci_senza_zona_risolta: normalized.filter((n) => n.zoneSource === "unknown").length,
    },
    baseline_casa_it: {
      righe_listing_identity_padova: baselineAll.count,
      multi_source_attuali: baselineAll.multiSource,
    },
    nuovi_contendibili_sbloccati_totale: newContendibiliTotal,
    vendibilita_per_zona: vendibilita,
    sample_annunci: sample,
    warnings: items.length === 0
      ? ["dataset_vuoto: actor non ha restituito items. Vedi run_status e visita la run su Apify per stderr."]
      : [],
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
