// test-multi-portal-padova
// ONE-SHOT controlled multi-portal test on Padova.
// Portals: immobiliare.it (Apify), idealista.it (Apify), subito.it (Apify, privati),
//          casa.it (Firecrawl, baseline).
// Pattern: action=start launches Apify runs in parallel + runs Firecrawl casa.it
// synchronously. action=results polls remaining runs + aggregates everything.
//
// Does NOT write to production tables. Returns JSON.
// Auth: x-job-secret OR a valid Supabase Bearer JWT.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY_BASE = "https://api.apify.com/v2";
const FIRECRAWL_BASE = "https://api.firecrawl.dev";

type Portal = "immobiliare" | "idealista" | "subito" | "casa";

interface PortalConfig {
  portal: Portal;
  engine: "apify" | "firecrawl";
  actor?: string;
  input?: Record<string, unknown>;
  firecrawl_url?: string;
}

const PORTALS = (maxItems: number): PortalConfig[] => [
  {
    portal: "immobiliare",
    engine: "apify",
    actor: "azzouzana~immobiliare-it-listing-page-scraper-by-search-url",
    input: {
      startUrl: "https://www.immobiliare.it/vendita-case/padova/",
      maxItems,
    },
  },
  {
    portal: "idealista",
    engine: "apify",
    actor: "memo23~idealista-scraper",
    input: {
      startUrls: ["https://www.idealista.it/vendita-case/padova-padova/"],
      maxItems,
      scrapeAgencies: false,
      splitByPrice: true,
      proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    },
  },
  {
    portal: "subito",
    engine: "apify",
    actor: "emastra~subito-it-immobili",
    input: {
      startUrls: ["https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/"],
      maxResultItems: maxItems,
      onlyPrivate: true,
    },
  },
  {
    portal: "casa",
    engine: "firecrawl",
    firecrawl_url: "https://www.casa.it/vendita/residenziale/padova",
  },
];

// Parse a publication date from various actor field shapes → ISO string or null.
function parsePubDate(it: Record<string, any>): string | null {
  const cands = [
    it.publishedDate, it.publishedAt, it.published_at, it.creationDate, it.createdAt,
    it.date, it.dateInsertion, it.firstSeenAt, it.firstActivationDate,
    it.properties?.[0]?.publishedDate, it.basicInfo?.creationDate,
  ];
  for (const c of cands) {
    if (!c) continue;
    if (typeof c === "number") {
      const d = new Date(c < 1e12 ? c * 1000 : c);
      if (!isNaN(+d)) return d.toISOString();
    }
    if (typeof c === "string") {
      const d = new Date(c);
      if (!isNaN(+d)) return d.toISOString();
    }
  }
  return null;
}

// Normalize Italian street address → "via_norm|civic"
function normalizeAddressKey(addr: string | null | undefined): { street: string; civic: string | null } {
  if (!addr) return { street: "", civic: null };
  let s = String(addr).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  s = s.replace(/[.,;:()]/g, " ").replace(/\s+/g, " ").trim();
  // Strip city/region tails
  s = s.split(/\bpadova\b|\bpd\b/i)[0].trim();
  // Normalize prefixes
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
  // Extract civic (first number sequence after street name)
  const civicMatch = s.match(/\b(\d{1,4}[a-z]?)\b/);
  const civic = civicMatch ? civicMatch[1] : null;
  // Street = remove civic and everything after
  const street = (civicMatch ? s.slice(0, civicMatch.index) : s).replace(/\s+/g, " ").trim();
  return { street, civic };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function apifyJson(path: string, init: RequestInit, ms: number, token: string): Promise<Response> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const url = `${APIFY_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  } finally { clearTimeout(t); }
}

interface NormItem {
  portal: Portal;
  title: string | null; address: string | null;
  price: number | null; mq: number | null; rooms: number | null;
  agency: string | null; isPrivate: boolean;
  lat: number | null; lng: number | null; cap: string | null;
  url: string | null;
  publishedAt: string | null;
}

function nz(n: number | null): number | null {
  return n != null && Number.isFinite(n) && n !== 0 ? n : null;
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
    mq: surf, rooms,
    agency, isPrivate,
    lat: nz(num(loc.latitude)), lng: nz(num(loc.longitude)),
    cap: null,
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
    mq: num(b.size),
    rooms: num(b.rooms),
    agency: agency ? String(agency).slice(0, 120) : null,
    isPrivate: isPrivate || (!agency && userType !== "professional"),
    lat: nz(num(b.latitude)), lng: nz(num(b.longitude)),
    cap: null,
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
    mq: num(f.size_sqm?.value),
    rooms: num(f.rooms?.value),
    agency: isPrivate ? null : (adv.name ? String(adv.name).slice(0, 120) : null),
    isPrivate,
    lat: nz(num(coords.latitude)), lng: nz(num(coords.longitude)),
    cap: null,
    url: it.page_url ?? it.request_url ?? null,
  };
}

function normalizeCasa(it: Record<string, any>): NormItem {
  // Firecrawl-extracted shape (flat fields).
  const lat = nz(num(it.latitude ?? it.lat));
  const lng = nz(num(it.longitude ?? it.lng));
  const agency = it.agency && String(it.agency).trim() && !/^priv/i.test(String(it.agency)) ? String(it.agency).slice(0, 120) : null;
  const isPrivate = it.isPrivate === true || /^priv/i.test(String(it.agency ?? ""));
  return {
    portal: "casa",
    title: it.title ?? null,
    address: it.address ?? null,
    price: num(it.price),
    mq: num(it.surface ?? it.mq),
    rooms: num(it.rooms),
    agency,
    isPrivate,
    lat, lng,
    cap: it.cap ? String(it.cap).replace(/\D/g, "").slice(0, 5) || null : null,
    url: it.url ?? null,
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

// ───────── Firecrawl casa.it scraper ─────────
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
          prompt: `Estrai fino a ${maxItems} annunci di vendita di appartamenti residenziali a Padova. Per ciascuno: titolo, indirizzo (via + zona/quartiere), prezzo in euro, superficie in mq, locali, nome dell'agenzia (o "privato" se è un privato), URL dell'annuncio, latitudine e longitudine se presenti, CAP.`,
          schema: {
            type: "object",
            properties: {
              listings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" }, address: { type: "string" },
                    price: { type: "number" }, surface: { type: "number" }, rooms: { type: "number" },
                    agency: { type: "string" }, isPrivate: { type: "boolean" },
                    latitude: { type: "number" }, longitude: { type: "number" },
                    cap: { type: "string" }, url: { type: "string" },
                  },
                },
              },
            },
          },
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
    // Firecrawl cost: ~1 credit per scrape (~$0.003 on Standard plan; not exact)
    return { items, status: items.length > 0 ? "OK" : "BLOCCATO", cost_usd: 0.003 };
  } catch (e) {
    return { items: [], status: "ERRORE", cost_usd: null, error: e instanceof Error ? e.message : String(e) };
  } finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth
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
  const action = String(body.action ?? "start").toLowerCase();
  const maxItems = Math.min(Number(body.maxItems ?? 150), 200);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // ───────── ACTION: dump_raw (debug) ─────────
  if (action === "dump_raw") {
    const runs = (body.runs ?? {}) as Record<string, string>;
    const limit = Math.min(Number(body.limit ?? 2), 5);
    const out: Record<string, unknown> = {};
    for (const [portal, runId] of Object.entries(runs)) {
      try {
        const sRes = await apifyJson(`/actor-runs/${encodeURIComponent(runId)}`, { method: "GET" }, 15_000, token);
        const sj = await sRes.json();
        const status = sj?.data?.status;
        const datasetId = sj?.data?.defaultDatasetId;
        if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
          out[portal] = { status, note: "still running" }; continue;
        }
        const dRes = await apifyJson(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=${limit}`, { method: "GET" }, 30_000, token);
        const raw = dRes.ok ? await dRes.json() : [];
        out[portal] = { status, items: raw, top_level_keys: Array.isArray(raw) && raw[0] ? Object.keys(raw[0]) : [] };
      } catch (e) {
        out[portal] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return json({ ok: true, action: "dump_raw", portals: out });
  }

  // ───────── ACTION: start ─────────
  if (action === "start") {
    const configs = PORTALS(maxItems);
    type StartResult = {
      portal: Portal; engine: string; actor?: string;
      status: "OK_STARTED" | "OK_FINISHED" | "ERRORE" | "BLOCCATO";
      run_id?: string; dataset_id?: string;
      items?: NormItem[]; cost_usd?: number | null; error?: string;
    };
    const started: StartResult[] = await Promise.all(configs.map(async (c): Promise<StartResult> => {
      if (c.engine === "firecrawl") {
        const r = await scrapeCasaFirecrawl(c.firecrawl_url!, maxItems);
        return { portal: c.portal, engine: "firecrawl", status: r.status === "OK" ? "OK_FINISHED" : (r.error ? "ERRORE" : "BLOCCATO"),
                 items: r.items, cost_usd: r.cost_usd, error: r.error };
      }
      try {
        const res = await apifyJson(`/acts/${encodeURIComponent(c.actor!)}/runs`,
          { method: "POST", body: JSON.stringify(c.input ?? {}) }, 30_000, token);
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          const hint = res.status === 402 ? "actor_requires_paid_plan_or_rental"
                     : res.status === 404 ? "actor_not_found"
                     : res.status === 401 ? "apify_token_invalid"
                     : `apify_${res.status}`;
          return { portal: c.portal, engine: "apify", actor: c.actor, status: "ERRORE",
                   error: `${hint}: ${txt.slice(0, 200).replace(/token=[^&\s]+/gi, "token=[redacted]")}` };
        }
        const sj = await res.json();
        return { portal: c.portal, engine: "apify", actor: c.actor, status: "OK_STARTED",
                 run_id: sj?.data?.id, dataset_id: sj?.data?.defaultDatasetId };
      } catch (e) {
        return { portal: c.portal, engine: "apify", actor: c.actor, status: "ERRORE", error: e instanceof Error ? e.message : String(e) };
      }
    }));

    return json({
      ok: true, action: "start",
      portals: started.map((s) => ({
        portal: s.portal, engine: s.engine, status: s.status,
        run_id: s.run_id, dataset_id: s.dataset_id, actor: s.actor,
        firecrawl_items: s.items?.length, cost_usd: s.cost_usd, error: s.error,
      })),
      next: `POST {"action":"results","runs":{...}} with the apify run_ids returned above (~90-180s after start)`,
      runs_for_results: Object.fromEntries(started.filter((s) => s.run_id).map((s) => [s.portal, s.run_id!])),
      firecrawl_snapshot: started.filter((s) => s.engine === "firecrawl").map((s) => ({ portal: s.portal, items: s.items?.length ?? 0 })),
      _firecrawl_items_passthrough: started.filter((s) => s.engine === "firecrawl").flatMap((s) => s.items ?? []),
    });
  }

  // ───────── ACTION: results ─────────
  const runs = (body.runs ?? {}) as Record<Portal, string>;
  const firecrawlPassthrough = (body.firecrawl_items ?? []) as NormItem[];

  type PortalResult = {
    portal: Portal; engine: "apify" | "firecrawl";
    status: "OK" | "BLOCCATO" | "ERRORE" | "RUNNING";
    items: NormItem[]; run_status?: string; cost_usd: number | null;
    raw_count?: number; error?: string;
  };
  const portalResults: PortalResult[] = [];

  // Casa.it (re-fetch via Firecrawl in case passthrough wasn't preserved across calls).
  if (firecrawlPassthrough.length > 0) {
    portalResults.push({ portal: "casa", engine: "firecrawl", status: "OK",
      items: firecrawlPassthrough, cost_usd: 0.003, raw_count: firecrawlPassthrough.length });
  } else {
    const r = await scrapeCasaFirecrawl("https://www.casa.it/vendita/residenziale/padova", maxItems);
    portalResults.push({ portal: "casa", engine: "firecrawl",
      status: r.status === "OK" ? "OK" : (r.error ? "ERRORE" : "BLOCCATO"),
      items: r.items, cost_usd: r.cost_usd, raw_count: r.items.length, error: r.error });
  }

  // Apify portals — fetch run status + dataset items.
  for (const portal of ["immobiliare", "idealista", "subito"] as Portal[]) {
    const runId = runs[portal];
    if (!runId) {
      portalResults.push({ portal, engine: "apify", status: "ERRORE", items: [], cost_usd: null, error: "missing_run_id" });
      continue;
    }
    try {
      const sRes = await apifyJson(`/actor-runs/${encodeURIComponent(runId)}`, { method: "GET" }, 15_000, token);
      if (!sRes.ok) {
        const t = await sRes.text().catch(() => "");
        portalResults.push({ portal, engine: "apify", status: "ERRORE", items: [], cost_usd: null, error: `run_status_${sRes.status}:${t.slice(0, 150)}` });
        continue;
      }
      const sj = await sRes.json();
      const status: string = sj?.data?.status ?? "unknown";
      const datasetId: string | undefined = sj?.data?.defaultDatasetId;
      const cost: number | null = typeof sj?.data?.usageTotalUsd === "number" ? sj.data.usageTotalUsd : null;
      if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
        portalResults.push({ portal, engine: "apify", status: "RUNNING", items: [], cost_usd: cost, run_status: status });
        continue;
      }
      let raw: Record<string, unknown>[] = [];
      if (datasetId) {
        const dRes = await apifyJson(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=${maxItems}`, { method: "GET" }, 60_000, token);
        if (dRes.ok) raw = await dRes.json();
      }
      const items = raw.slice(0, maxItems).map((r) => normalizeRaw(portal, r));
      portalResults.push({
        portal, engine: "apify",
        status: status === "SUCCEEDED" ? (items.length > 0 ? "OK" : "BLOCCATO") : "ERRORE",
        items, run_status: status, cost_usd: cost, raw_count: raw.length,
      });
    } catch (e) {
      portalResults.push({ portal, engine: "apify", status: "ERRORE", items: [], cost_usd: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─────── Geocoding (Google Maps) for items missing lat/lng ───────
  const gKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
  const geocodeAddr = async (addr: string): Promise<{ lat: number; lng: number } | null> => {
    if (!gKey || !addr || addr.length < 5) return null;
    try {
      const q = `${addr}, Padova, Italia`;
      const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=it&key=${gKey}`;
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(u, { signal: ctrl.signal }); clearTimeout(t);
      if (!res.ok) return null;
      const j = await res.json();
      const loc = j?.results?.[0]?.geometry?.location;
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        // ensure it's in/near Padova (lat 45.3-45.5, lng 11.7-12.0)
        if (loc.lat > 45.25 && loc.lat < 45.55 && loc.lng > 11.6 && loc.lng < 12.1) {
          return { lat: loc.lat, lng: loc.lng };
        }
      }
      return null;
    } catch { return null; }
  };

  // Collect items needing geocoding.
  const allItemsRaw: NormItem[] = portalResults.flatMap((r) => r.items);
  const needGeo = allItemsRaw.filter((i) => (i.lat == null || i.lng == null) && !!i.address);
  let geocodedOk = 0; let geocodedFail = 0;
  // Run geocoding with concurrency 5.
  const conc = 5;
  for (let i = 0; i < needGeo.length; i += conc) {
    const slice = needGeo.slice(i, i + conc);
    await Promise.all(slice.map(async (it) => {
      const r = await geocodeAddr(it.address!);
      if (r) { it.lat = r.lat; it.lng = r.lng; geocodedOk++; } else { geocodedFail++; }
    }));
  }
  const senzaGeoTotPre = allItemsRaw.filter((i) => i.lat == null || i.lng == null).length + geocodedOk;
  const senzaGeoTotPost = allItemsRaw.filter((i) => i.lat == null || i.lng == null).length;

  // ─────── Zone resolution ───────
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
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

  type Annotated = NormItem & { zone: string };
  const allItems: Annotated[] = [];
  for (const it of allItemsRaw) {
    let zone = "Sconosciuta";
    if (it.lat != null && it.lng != null) zone = await zoneFor(it.lat, it.lng);
    if (zone === "Sconosciuta" && it.cap) zone = `CAP ${it.cap}`;
    allItems.push({ ...it, zone });
  }

  // Per-portal summary.
  const perPortalSummary = portalResults.map((r) => {
    const annotated = allItems.filter((i) => i.portal === r.portal);
    return {
      portal: r.portal, engine: r.engine, status: r.status, run_status: r.run_status,
      annunci: annotated.length, raw_dataset_items: r.raw_count,
      con_agenzia: annotated.filter((i) => !i.isPrivate && i.agency).length,
      privati: annotated.filter((i) => i.isPrivate).length,
      con_coords: annotated.filter((i) => i.lat != null && i.lng != null).length,
      con_zona_reale: annotated.filter((i) => i.zone !== "Sconosciuta" && !i.zone.startsWith("CAP ")).length,
      con_url: annotated.filter((i) => !!i.url).length,
      cost_usd: r.cost_usd, error: r.error,
    };
  });

  // ─────── Clustering at 3 thresholds (distance + mq tolerance) ───────
  // Greedy O(N^2) — N<=500.
  const haversine = (a: Annotated, b: Annotated): number => {
    const R = 6371000;
    const toRad = (x: number) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat! - a.lat!); const dLng = toRad(b.lng! - a.lng!);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat!))*Math.cos(toRad(b.lat!))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const itemsGeo = allItems.filter((i) => i.lat != null && i.lng != null);

  type Cluster = { items: Annotated[]; portals: Set<string>; agencies: Set<string> };
  const clusterAt = (radiusM: number, mqTol: number) => {
    const n = itemsGeo.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const uni = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = itemsGeo[i], b = itemsGeo[j];
        if (Math.abs((a.lat! - b.lat!)) > 0.003) continue;
        if (haversine(a, b) > radiusM) continue;
        if (a.mq != null && b.mq != null && Math.abs(a.mq - b.mq) > mqTol) continue;
        uni(i, j);
      }
    }
    const groups = new Map<number, Cluster>();
    for (let i = 0; i < n; i++) {
      const r = find(i); const it = itemsGeo[i];
      const slot = groups.get(r) ?? { items: [], portals: new Set<string>(), agencies: new Set<string>() };
      slot.items.push(it); slot.portals.add(it.portal); if (it.agency) slot.agencies.add(it.agency.toLowerCase());
      groups.set(r, slot);
    }
    const contendibili = [...groups.values()].filter((c) => c.portals.size >= 2 || c.agencies.size >= 2);
    return { totale: contendibili.length, clusters: contendibili };
  };

  const sogliaStretta = clusterAt(110, 5);
  const sogliaMedia   = clusterAt(150, 8);
  const sogliaLarga   = clusterAt(200, 10);

  const sampleClusters = (cs: Cluster[]) => cs.slice(0, 3).map((c) => ({
    size: c.items.length, portals: [...c.portals], agencies: [...c.agencies],
    members: c.items.map((i) => ({
      portal: i.portal, address: i.address?.slice(0, 90), title: i.title?.slice(0, 70),
      mq: i.mq, price: i.price, agency: i.agency, url: i.url,
    })),
  }));

  // ─────── Tabella A — contendibili per zona (soglia MEDIA) ───────
  const tabellaA = new Map<string, { tot: number; portals: Set<string>; agencies: Set<string>; cont: Set<number> }>();
  for (const it of allItems) {
    const s = tabellaA.get(it.zone) ?? { tot: 0, portals: new Set<string>(), agencies: new Set<string>(), cont: new Set<number>() };
    s.tot++; s.portals.add(it.portal); if (it.agency) s.agencies.add(it.agency.toLowerCase());
    tabellaA.set(it.zone, s);
  }
  sogliaMedia.clusters.forEach((c, idx) => {
    const z = c.items[0].zone;
    const s = tabellaA.get(z); if (s) s.cont.add(idx);
  });
  const tabella_A_contendibili = [...tabellaA.entries()].map(([zona, v]) => ({
    zona, annunci_tot: v.tot, portali: v.portals.size, agenzie_distinte: v.agencies.size, contendibili: v.cont.size,
  })).sort((a, b) => b.contendibili - a.contendibili || b.annunci_tot - a.annunci_tot);

  // ─────── Tabella B — volume / privati per zona ───────
  const tabella_B_volume = [...tabellaA.entries()].map(([zona, v]) => {
    const items = allItems.filter((i) => i.zone === zona);
    return {
      zona, annunci_tot: v.tot,
      agenzie_attive_distinte: v.agencies.size,
      privati: items.filter((i) => i.isPrivate).length,
      densita: v.tot,
    };
  }).sort((a, b) => b.privati - a.privati || b.annunci_tot - a.annunci_tot);

  const totalCost = perPortalSummary.reduce((s, p) => s + (p.cost_usd ?? 0), 0);

  return json({
    ok: true,
    geocoding: {
      candidati_senza_geo_iniziali: senzaGeoTotPre,
      geocodati_ok: geocodedOk,
      geocodati_falliti: geocodedFail,
      ancora_senza_geo_dopo_tentativo: senzaGeoTotPost,
      provider: gKey ? "google_maps" : "none",
    },
    riepilogo_per_portale: perPortalSummary,
    contendibili_per_soglia: {
      stretta_110m_mq5:  { totale: sogliaStretta.totale, esempi: sampleClusters(sogliaStretta.clusters) },
      media_150m_mq8:    { totale: sogliaMedia.totale,   esempi: sampleClusters(sogliaMedia.clusters) },
      larga_200m_mq10:   { totale: sogliaLarga.totale,   esempi: sampleClusters(sogliaLarga.clusters) },
    },
    tabella_A_contendibili_per_zona_soglia_media: tabella_A_contendibili,
    tabella_B_volume_e_privati_per_zona: tabella_B_volume,
    aggregato: {
      annunci_totali: allItems.length,
      con_coords_finali: itemsGeo.length,
      privati_totali: allItems.filter((i) => i.isPrivate).length,
      cost_totale_usd: Number(totalCost.toFixed(4)),
    },
  });
});
