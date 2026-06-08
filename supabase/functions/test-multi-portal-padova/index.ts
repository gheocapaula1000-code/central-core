// test-multi-portal-padova
// ONE-SHOT multi-portal test on Padova with per-portal URL chunking,
// first_seen_at historization (staging table), and identity matching
// (street+civic+mq) WITHOUT price as a filter (price = signal only).
//
// Does NOT write to production tables. Returns JSON.
// Auth: x-job-secret OR a valid Supabase Bearer JWT.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getApifyToken } from "../_shared/apify.ts";

const APIFY_BASE = "https://api.apify.com/v2";
const FIRECRAWL_BASE = "https://api.firecrawl.dev";

type Portal = "immobiliare" | "idealista" | "subito" | "casa";

// Price bands (EUR) used to split immobiliare.it / idealista.it crawls and bypass
// the actors' internal ~200-item paging cap. 10 bands × 200 items ≈ 2000/portal.
const PRICE_BANDS: Array<{ label: string; min: number; max: number | null }> = [
  { label: "0-100k",      min: 0,       max: 100000  },
  { label: "100-150k",    min: 100000,  max: 150000  },
  { label: "150-200k",    min: 150000,  max: 200000  },
  { label: "200-250k",    min: 200000,  max: 250000  },
  { label: "250-300k",    min: 250000,  max: 300000  },
  { label: "300-400k",    min: 300000,  max: 400000  },
  { label: "400-500k",    min: 400000,  max: 500000  },
  { label: "500-700k",    min: 500000,  max: 700000  },
  { label: "700k-1M",     min: 700000,  max: 1000000 },
  { label: "1M+",         min: 1000000, max: null    },
];

interface PortalChunk {
  portal: Portal;
  engine: "apify" | "firecrawl";
  label: string;
  actor?: string;
  input?: Record<string, unknown>;
  firecrawl_url?: string;
}

function buildImmobiliareUrl(band: { min: number; max: number | null }): string {
  const u = new URL("https://www.immobiliare.it/vendita-case/padova/");
  u.searchParams.set("criterio", "rilevanza");
  u.searchParams.set("prezzoMinimo", String(band.min));
  if (band.max != null) u.searchParams.set("prezzoMassimo", String(band.max));
  return u.toString();
}
function buildIdealistaUrl(band: { min: number; max: number | null }): string {
  // Idealista URL pattern: /con-prezzo-min_X,prezzo-max_Y/  (price slice in path).
  const parts: string[] = [];
  if (band.min > 0) parts.push(`prezzo-min_${band.min}`);
  if (band.max != null) parts.push(`prezzo-max_${band.max}`);
  const slice = parts.length ? `con-${parts.join(",")}/` : "";
  return `https://www.idealista.it/vendita-case/padova-padova/${slice}`;
}

function buildChunks(perChunkMax: number): PortalChunk[] {
  const out: PortalChunk[] = [];
  for (const b of PRICE_BANDS) {
    out.push({
      portal: "immobiliare",
      engine: "apify",
      label: b.label,
      actor: "azzouzana~immobiliare-it-listing-page-scraper-by-search-url",
      input: { startUrl: buildImmobiliareUrl(b), maxItems: perChunkMax },
    });
    out.push({
      portal: "idealista",
      engine: "apify",
      label: b.label,
      actor: "memo23~idealista-scraper",
      input: {
        startUrls: [buildIdealistaUrl(b)],
        maxItems: perChunkMax,
        scrapeAgencies: false,
        proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      },
    });
  }
  // subito.it: keep as single URL (privati only).
  out.push({
    portal: "subito",
    engine: "apify",
    label: "all",
    actor: "emastra~subito-it-immobili",
    input: {
      startUrls: ["https://www.subito.it/annunci-veneto/vendita/appartamenti/padova/padova/"],
      maxResultItems: perChunkMax * 2,
      onlyPrivate: true,
    },
  });
  // casa.it: Firecrawl baseline.
  out.push({
    portal: "casa",
    engine: "firecrawl",
    label: "baseline",
    firecrawl_url: "https://www.casa.it/vendita/residenziale/padova",
  });
  return out;
}

// Parse a publication date (rarely present in these actors) → ISO string or null.
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

// Normalize Italian street address → {street, civic}
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
  source_chunk?: string;
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
    publishedAt: parsePubDate(it),
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
  const action = String(body.action ?? "start").toLowerCase();
  const perChunkMax = Math.min(Number(body.perChunkMax ?? 200), 250);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // ───────── ACTION: start ─────────
  if (action === "start") {
    const chunks = buildChunks(perChunkMax);
    type Started = {
      portal: Portal; label: string; engine: string; actor?: string;
      status: "OK_STARTED" | "OK_FINISHED" | "ERRORE" | "BLOCCATO";
      run_id?: string; items?: NormItem[]; cost_usd?: number | null; error?: string;
    };
    const started: Started[] = await Promise.all(chunks.map(async (c): Promise<Started> => {
      if (c.engine === "firecrawl") {
        const r = await scrapeCasaFirecrawl(c.firecrawl_url!, perChunkMax);
        return { portal: c.portal, label: c.label, engine: "firecrawl",
          status: r.status === "OK" ? "OK_FINISHED" : (r.error ? "ERRORE" : "BLOCCATO"),
          items: r.items, cost_usd: r.cost_usd, error: r.error };
      }
      try {
        const res = await apifyJson(`/acts/${encodeURIComponent(c.actor!)}/runs`,
          { method: "POST", body: JSON.stringify(c.input ?? {}) }, 30_000, token);
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          const hint = res.status === 402 ? "actor_requires_paid_plan"
                     : res.status === 404 ? "actor_not_found"
                     : res.status === 401 ? "apify_token_invalid"
                     : `apify_${res.status}`;
          return { portal: c.portal, label: c.label, engine: "apify", actor: c.actor, status: "ERRORE",
                   error: `${hint}: ${txt.slice(0, 200).replace(/token=[^&\s]+/gi, "token=[redacted]")}` };
        }
        const sj = await res.json();
        return { portal: c.portal, label: c.label, engine: "apify", actor: c.actor,
                 status: "OK_STARTED", run_id: sj?.data?.id };
      } catch (e) {
        return { portal: c.portal, label: c.label, engine: "apify", actor: c.actor,
                 status: "ERRORE", error: e instanceof Error ? e.message : String(e) };
      }
    }));

    // runs map: { immobiliare: [{label, run_id}, ...], idealista: [...], subito: [...] }
    const runsMap: Record<string, Array<{ label: string; run_id: string }>> = {};
    for (const s of started) {
      if (!s.run_id) continue;
      (runsMap[s.portal] ??= []).push({ label: s.label, run_id: s.run_id });
    }

    return json({
      ok: true, action: "start",
      chunks_launched: started.map((s) => ({
        portal: s.portal, label: s.label, engine: s.engine, status: s.status,
        run_id: s.run_id, error: s.error, firecrawl_items: s.items?.length,
      })),
      runs_for_results: runsMap,
      firecrawl_passthrough: started.filter((s) => s.engine === "firecrawl").flatMap((s) => s.items ?? []),
      next: `POST {"action":"results","runs":<runs_for_results>,"firecrawl_items":<firecrawl_passthrough>} after ~3-5 min`,
    });
  }

  // ───────── ACTION: results ─────────
  // runs[portal] is now an array of { label, run_id }
  const runsIn = (body.runs ?? {}) as Record<Portal, Array<{ label: string; run_id: string }>>;
  const firecrawlPassthrough = (body.firecrawl_items ?? []) as NormItem[];

  type RunResult = {
    portal: Portal; engine: "apify" | "firecrawl"; label: string;
    status: "OK" | "BLOCCATO" | "ERRORE" | "RUNNING";
    items: NormItem[]; run_status?: string; cost_usd: number | null;
    raw_count?: number; error?: string;
  };
  const runResults: RunResult[] = [];

  // casa.it (Firecrawl baseline) — single entry.
  if (firecrawlPassthrough.length > 0) {
    runResults.push({ portal: "casa", engine: "firecrawl", label: "baseline",
      status: "OK", items: firecrawlPassthrough.map((i) => ({ ...i, source_chunk: "baseline" })),
      cost_usd: 0.003, raw_count: firecrawlPassthrough.length });
  } else {
    const r = await scrapeCasaFirecrawl("https://www.casa.it/vendita/residenziale/padova", perChunkMax);
    runResults.push({ portal: "casa", engine: "firecrawl", label: "baseline",
      status: r.status === "OK" ? "OK" : (r.error ? "ERRORE" : "BLOCCATO"),
      items: r.items.map((i) => ({ ...i, source_chunk: "baseline" })),
      cost_usd: r.cost_usd, raw_count: r.items.length, error: r.error });
  }

  // Apify portals — iterate ALL chunks per portal.
  for (const portal of ["immobiliare", "idealista", "subito"] as Portal[]) {
    const list = runsIn[portal] ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      runResults.push({ portal, engine: "apify", label: "_missing_", status: "ERRORE",
        items: [], cost_usd: null, error: "missing_run_ids" });
      continue;
    }
    // Fetch all chunk runs in parallel (max 10).
    const fetched = await Promise.all(list.map(async (chunk): Promise<RunResult> => {
      try {
        const sRes = await apifyJson(`/actor-runs/${encodeURIComponent(chunk.run_id)}`, { method: "GET" }, 15_000, token);
        if (!sRes.ok) {
          const t = await sRes.text().catch(() => "");
          return { portal, engine: "apify", label: chunk.label, status: "ERRORE",
            items: [], cost_usd: null, error: `run_status_${sRes.status}:${t.slice(0, 120)}` };
        }
        const sj = await sRes.json();
        const status: string = sj?.data?.status ?? "unknown";
        const datasetId: string | undefined = sj?.data?.defaultDatasetId;
        const cost: number | null = typeof sj?.data?.usageTotalUsd === "number" ? sj.data.usageTotalUsd : null;
        if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
          return { portal, engine: "apify", label: chunk.label, status: "RUNNING",
            items: [], cost_usd: cost, run_status: status };
        }
        let raw: Record<string, unknown>[] = [];
        if (datasetId) {
          const dRes = await apifyJson(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&limit=${perChunkMax}`, { method: "GET" }, 60_000, token);
          if (dRes.ok) raw = await dRes.json();
        }
        const items = raw.slice(0, perChunkMax).map((r) => ({ ...normalizeRaw(portal, r), source_chunk: chunk.label }));
        return { portal, engine: "apify", label: chunk.label,
          status: status === "SUCCEEDED" ? (items.length > 0 ? "OK" : "BLOCCATO") : "ERRORE",
          items, run_status: status, cost_usd: cost, raw_count: raw.length };
      } catch (e) {
        return { portal, engine: "apify", label: chunk.label, status: "ERRORE",
          items: [], cost_usd: null, error: e instanceof Error ? e.message : String(e) };
      }
    }));
    runResults.push(...fetched);
  }

  // Dedupe within each portal by URL (price-band overlap is rare but possible).
  const seenUrl = new Set<string>();
  const allRaw: NormItem[] = [];
  for (const r of runResults) {
    for (const it of r.items) {
      const k = it.url ?? `${it.portal}:${it.address}:${it.mq}:${it.price}`;
      if (seenUrl.has(k)) continue;
      seenUrl.add(k);
      allRaw.push(it);
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
        if (loc.lat > 45.25 && loc.lat < 45.55 && loc.lng > 11.6 && loc.lng < 12.1) return { lat: loc.lat, lng: loc.lng };
      }
      return null;
    } catch { return null; }
  };

  const needGeo = allRaw.filter((i) => (i.lat == null || i.lng == null) && !!i.address);
  const senzaGeoPre = needGeo.length;
  let geocodedOk = 0; let geocodedFail = 0;
  const conc = 5;
  for (let i = 0; i < needGeo.length; i += conc) {
    const slice = needGeo.slice(i, i + conc);
    await Promise.all(slice.map(async (it) => {
      const r = await geocodeAddr(it.address!);
      if (r) { it.lat = r.lat; it.lng = r.lng; geocodedOk++; } else { geocodedFail++; }
    }));
  }
  const senzaGeoPost = allRaw.filter((i) => i.lat == null || i.lng == null).length;

  // ─────── first_seen_at historization (staging table) ───────
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const firstSeenMap = new Map<string, string>(); // url → ISO
  let fsInserted = 0, fsExisting = 0, fsErrors = 0;
  const itemsWithUrl = allRaw.filter((i) => !!i.url);
  // Lookup existing
  const urls = itemsWithUrl.map((i) => i.url!) ;
  // chunked SELECTs to avoid URL length issues
  for (let i = 0; i < urls.length; i += 200) {
    const slice = urls.slice(i, i + 200);
    const { data, error } = await sb
      .from("test_listing_first_seen")
      .select("url,first_seen_at")
      .in("url", slice);
    if (error) { fsErrors++; continue; }
    for (const row of (data ?? [])) firstSeenMap.set(row.url, row.first_seen_at);
  }
  // Upsert
  const upsertRows = itemsWithUrl.map((i) => ({
    url: i.url!, portal: i.portal, last_seen_at: new Date().toISOString(),
  }));
  for (let i = 0; i < upsertRows.length; i += 500) {
    const slice = upsertRows.slice(i, i + 500);
    const { data, error } = await sb
      .from("test_listing_first_seen")
      .upsert(slice, { onConflict: "url", ignoreDuplicates: false })
      .select("url,first_seen_at");
    if (error) { fsErrors++; continue; }
    for (const row of (data ?? [])) {
      if (!firstSeenMap.has(row.url)) { firstSeenMap.set(row.url, row.first_seen_at); fsInserted++; }
      else { fsExisting++; }
    }
  }

  // ─────── Zone resolution ───────
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

  // ─────── Per-chunk + per-portal summary (PRIMA vs DOPO split) ───────
  const perChunkSummary = runResults.map((r) => ({
    portal: r.portal, chunk: r.label, status: r.status, run_status: r.run_status,
    annunci: r.items.length, raw: r.raw_count, cost_usd: r.cost_usd, error: r.error,
  }));
  const perPortalSummary = (["immobiliare", "idealista", "subito", "casa"] as Portal[]).map((p) => {
    const annotated = allItems.filter((i) => i.portal === p);
    const runs = runResults.filter((r) => r.portal === p);
    const cost = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    return {
      portal: p,
      n_chunks: runs.length,
      annunci_DOPO_split_dedup: annotated.length,
      annunci_PRIMA_singolo_url_riferimento: p === "immobiliare" || p === "idealista" ? 200 : (p === "subito" ? 70 : 10),
      con_agenzia: annotated.filter((i) => !i.isPrivate && i.agency).length,
      privati: annotated.filter((i) => i.isPrivate).length,
      con_coords: annotated.filter((i) => i.lat != null && i.lng != null).length,
      cost_usd: Number(cost.toFixed(4)),
      chunks_running: runs.filter((r) => r.status === "RUNNING").length,
      chunks_error: runs.filter((r) => r.status === "ERRORE").length,
    };
  });

  // ─────── Identity matching: street+civic + mq ±8%  (NO price filter) ───────
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
        agencies: new Set(it.agency ? [it.agency.toLowerCase()] : []),
        key,
      });
    }
  }
  const idContendibili = [...idGroups.values()].filter((c) => c.portals.size >= 2 || c.agencies.size >= 2);

  // map item → identity cluster (for enrichment)
  const itemToCluster = new Map<NormItem, IdCluster>();
  for (const c of idGroups.values()) for (const it of c.items) itemToCluster.set(it, c);

  // ─────── OMI → quartiere ───────
  const uniqueOmi = [...new Set(allItems.map((i) => i.zone).filter((z) => /^[A-Z]\d/.test(z)))];
  const omiDescrMap = new Map<string, string>();
  if (uniqueOmi.length) {
    const { data } = await sb.from("omi_zone_geometry")
      .select("zona,zona_descr")
      .ilike("comune_descrizione", "padova")
      .in("zona", uniqueOmi);
    for (const r of (data ?? [])) {
      if (r.zona && r.zona_descr && !omiDescrMap.has(r.zona)) omiDescrMap.set(r.zona, r.zona_descr);
    }
  }

  // ─────── Enrichment: tipo_lead, prezzo_divergente ───────
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
    return {
      ...it,
      quartiere: omiDescrMap.get(it.zone) ?? it.zone,
      privato_stanco,
      prezzo_divergente,
      tipo_lead,
      contendibile: isContendibile,
    };
  });

  // ─────── Tabella per QUARTIERE ───────
  const byQ = new Map<string, typeof enriched>();
  for (const e of enriched) {
    const key = `${e.zone}|${e.quartiere}`;
    const arr = byQ.get(key) ?? [];
    arr.push(e); byQ.set(key, arr);
  }
  const tabella_per_quartiere = [...byQ.entries()].map(([key, items]) => {
    const [omi, quartiere] = key.split("|");
    return {
      omi, quartiere,
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

  const totalCost = runResults.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  // Esempi cluster contendibili (max 10)
  const esempi_contendibili = idContendibili.slice(0, 10).map((c) => ({
    portals: [...c.portals], agencies_distinct: c.agencies.size,
    n_items: c.items.length,
    address_sample: c.items[0].address?.slice(0, 90),
    quartiere: omiDescrMap.get(c.items[0].zone) ?? c.items[0].zone,
    members: c.items.map((i) => ({
      portal: i.portal, mq: i.mq, price: i.price, agency: i.agency, url: i.url,
    })),
  }));

  return json({
    ok: true,
    geocoding: {
      candidati_senza_geo_iniziali: senzaGeoPre,
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
      nota: "Da questa run il contatore parte. giorni_online resta ~0 finché non ripassiamo a giorni di distanza.",
    },
    chunking: {
      perChunkMax,
      bands: PRICE_BANDS.map((b) => b.label),
      per_chunk: perChunkSummary,
    },
    riepilogo_per_portale: perPortalSummary,
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
  });
});
