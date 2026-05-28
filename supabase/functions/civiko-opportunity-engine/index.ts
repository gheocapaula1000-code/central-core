// civiko-opportunity-engine
// GET /functions/v1/civiko-opportunity-engine
// Aggrega 3 fonti reali per Padova (Apify/Firecrawl listings + ISTAT demografico
// + PNRR/Tram) e produce OpportunityEnhanced con scoring incrociato.
// PRINCIPIO: se le API non rispondono, restituisce []. Nessun mock.
// Auth: Bearer JWT obbligatorio. Ruolo: admin | owner | agency_user.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getApifyToken } from "../_shared/apify.ts";

// ─── CORS ────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://civikoone.com",
  "https://www.civikoone.com",
];
const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];

function corsFor(origin: string | null): Record<string, string> {
  let allow = "https://civikoone.com";
  if (origin) {
    const o = origin.toLowerCase();
    try {
      const u = new URL(o);
      if (ALLOWED_ORIGINS.includes(o)) allow = o;
      else if (LOVABLE_SUFFIXES.some((s) => u.hostname.endsWith(s))) allow = o;
      else if (u.hostname === "localhost" || u.hostname.startsWith("127.")) allow = o;
    } catch { /* ignore */ }
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResp(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, ...extra, "Content-Type": "application/json" },
  });
}

const OWNER_EMAILS = (Deno.env.get("OWNER_EMAILS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// ─── Types ───────────────────────────────────────────────────────────────
interface OpportunityEnhanced {
  id: string;
  title: string;
  territory: string;
  microzona: string | null;
  property_type: "residenziale" | "commerciale" | "terreno";
  temperature: "caldo" | "tiepido" | "freddo";
  priority: "alta" | "media" | "bassa";
  assignment_probability: number;
  estimated_value: number;
  omi_value_mq: number | null;
  price_gap_pct: number | null;
  price_gap_label: string | null;
  commission_potential: number;
  window_label: string;
  commercial_reason: string;
  next_action: string;
  dossier_status: "pronto" | "in_preparazione";
  signals: string[];
  visible_to_agency: true;
}

const PADOVA_ZONES = [
  "Arcella", "Portello", "Centro Storico", "Forcellini", "Guizza",
  "Sacra Famiglia", "Camin", "Stanga", "Zona Industriale", "Voltabarozzo",
  "Pontevigodarzere", "Mortise", "Altichiero", "Mandria", "Brusegana",
  "Brentelle", "Chiesanuova", "Salboro", "Ponte di Brenta", "Stazione",
  "Fiera", "Santo", "Prato della Valle",
];

function findZone(text: string): string | null {
  const lower = (text ?? "").toLowerCase();
  for (const z of PADOVA_ZONES) {
    if (lower.includes(z.toLowerCase())) return z;
  }
  return null;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function shortId(prefix: string, seed: string, len = 16): string {
  const b64 = btoa(unescape(encodeURIComponent(seed))).slice(0, len).replace(/[^a-z0-9]/gi, "");
  return `${prefix}-${b64}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractPrice(raw: string): number {
  if (!raw) return 0;
  const patterns = [/€\s*([\d\.]+(?:[.,]\d+)?)/, /([\d\.]+(?:[.,]\d+)?)\s*€/, /([\d][\d\.]{4,})/];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return 0;
}

function extractDays(block: string): number {
  if (!block) return 0;
  const mDays = block.match(/(\d+)\s*(giorni?|days?)/i);
  if (mDays) return parseInt(mDays[1], 10);
  const mWeeks = block.match(/(\d+)\s*(settiman[ae]|weeks?)/i);
  if (mWeeks) return parseInt(mWeeks[1], 10) * 7;
  const mMonths = block.match(/(\d+)\s*(mes[ei]|months?)/i);
  if (mMonths) return parseInt(mMonths[1], 10) * 30;
  return 0;
}

// ─── OMI lookup (chiamata interna) ───────────────────────────────────────
async function fetchOmiValueMq(zona: string, supabaseUrl: string, anonKey: string, auth: string): Promise<number | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const url = `${supabaseUrl}/functions/v1/civiko-omi-padova-zone?zona=${encodeURIComponent(zona)}&tipo=residenziale`;
    const res = await fetch(url, {
      headers: { "apikey": anonKey, "Authorization": auth },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    // formati possibili: { valore_medio_mq } | { data: { quotazioniRange: { min, max } } } | { zona: { quotazioniRange: ... } }
    const direct = Number(data?.valore_medio_mq ?? data?.data?.valore_medio_mq);
    if (!isNaN(direct) && direct > 0) return direct;
    const range = data?.zona?.quotazioniRange ?? data?.data?.zona?.quotazioniRange ?? data?.quotazioniRange;
    if (range && typeof range.min === "number" && typeof range.max === "number") {
      const avg = (range.min + range.max) / 2;
      if (avg > 0) return avg;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── FONTE 1: Apify (immobiliare.it) + fallback Firecrawl ────────────────
interface RawListing {
  rawId?: string;
  title: string;
  priceText: string;
  zoneText: string;
  daysText: string;
}

async function fetchApifyListings(): Promise<RawListing[]> {
  const key = getApifyToken();
  if (!key) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const body = {
      startUrls: [
        { url: "https://www.immobiliare.it/vendita-case/padova/?criterio=dataModifica&ordine=asc&pag=1" },
        { url: "https://www.immobiliare.it/vendita-case/padova/?criterio=dataModifica&ordine=asc&pag=2" },
      ],
      maxRequestsPerCrawl: 40,
      pageFunction:
        "async function pageFunction(context) { const $ = context.$; const results = []; $('[data-item-id]').each((i, el) => { const $el = $(el); results.push({ id: $el.attr('data-item-id'), title: $el.find('h2').text().trim(), price: $el.find('[class*=price]').text().trim(), zone: $el.find('[class*=location]').text().trim(), daysOnMarket: $el.find('[class*=date]').text().trim() }); }); return results; }",
    };
    const res = await fetch("https://api.apify.com/v2/acts/apify~web-scraper/run-sync-get-dataset-items", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    const out: RawListing[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const title = String(e.title ?? "").trim();
      if (!title) continue;
      out.push({
        rawId: typeof e.id === "string" ? e.id : undefined,
        title,
        priceText: String(e.price ?? ""),
        zoneText: String(e.zone ?? ""),
        daysText: String(e.daysOnMarket ?? ""),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function fetchFirecrawlFallback(): Promise<RawListing[]> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://www.immobiliare.it/vendita-case/padova/?criterio=dataModifica&ordine=asc",
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const md: string | undefined = data?.data?.markdown ?? data?.markdown;
    if (!md || md.length < 100) return [];
    const truncated = md.slice(0, 8000);
    const out: RawListing[] = [];
    const blocks: string[] = [];
    for (let i = 0; i < truncated.length; i += 500) blocks.push(truncated.slice(i, i + 500));
    for (const block of blocks) {
      if (!/€|euro/i.test(block)) continue;
      const firstLine = block.split("\n").map((l) => l.trim()).find((l) => l.length > 5) ?? "";
      const title = firstLine.replace(/[#*_>`-]/g, "").trim().slice(0, 90);
      if (title.length < 8) continue;
      out.push({ title, priceText: block, zoneText: block, daysText: block });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function inferPropertyType(title: string): OpportunityEnhanced["property_type"] {
  const t = title.toLowerCase();
  if (/(capannone|ufficio|negozio|locale commerciale)/.test(t)) return "commerciale";
  if (/terreno/.test(t)) return "terreno";
  return "residenziale";
}

async function buildListingOpportunities(
  raws: RawListing[],
  supabaseUrl: string,
  anonKey: string,
  auth: string,
): Promise<OpportunityEnhanced[]> {
  // Cache OMI per zona per evitare chiamate ripetute
  const omiCache = new Map<string, number | null>();

  const out: OpportunityEnhanced[] = [];
  for (const r of raws) {
    const prezzo = extractPrice(r.priceText) || extractPrice(r.title);
    const giorni = extractDays(r.daysText) || extractDays(r.priceText);
    if (!prezzo || prezzo < 50_000) continue;
    if (giorni === 0) continue;

    const zona = findZone(r.zoneText) ?? findZone(r.title);
    const territory = zona ? `Padova - ${zona}` : "Padova";
    const property_type = inferPropertyType(r.title);

    // OMI
    let omi_value_mq: number | null = null;
    let price_gap_pct: number | null = null;
    let price_gap_label: string | null = null;
    if (zona) {
      if (!omiCache.has(zona)) {
        omiCache.set(zona, await fetchOmiValueMq(zona, supabaseUrl, anonKey, auth));
      }
      omi_value_mq = omiCache.get(zona) ?? null;
      if (omi_value_mq && omi_value_mq > 0) {
        const superficie_stimata = prezzo / (omi_value_mq * 1.15);
        const prezzo_stimato_omi = omi_value_mq * superficie_stimata;
        if (prezzo_stimato_omi > 0) {
          price_gap_pct = Math.round((prezzo - prezzo_stimato_omi) / prezzo_stimato_omi * 100);
          if (price_gap_pct > 20) {
            price_gap_label = `Prezzo oltre mercato del ${price_gap_pct}% — proprietario in stallo`;
          } else if (price_gap_pct > 10) {
            price_gap_label = "Prezzo leggermente sopra mercato — margine di negoziazione";
          } else if (price_gap_pct < -10) {
            price_gap_label = "Prezzo sotto mercato — opportunità da cogliere subito";
          }
        }
      }
    }

    // Scoring base dai giorni
    let temperature: OpportunityEnhanced["temperature"] = "freddo";
    let priority: OpportunityEnhanced["priority"] = "bassa";
    let assignment_probability = 45;
    let window_label = "Da qualificare";
    let commercial_reason = "Annuncio in monitoraggio. Da qualificare con primo contatto.";
    let next_action = "Avvia monitoraggio e qualifica";

    if (giorni > 180) {
      temperature = "caldo"; priority = "alta"; assignment_probability = 78;
      window_label = "Finestra utile: presente da oltre 6 mesi";
      commercial_reason = "Immobile presente sul mercato da un periodo prolungato. Il proprietario potrebbe apprezzare una proposta strutturata con piano di valorizzazione.";
      next_action = "Prepara dossier e primo contatto entro 48 ore";
    } else if (giorni > 90) {
      temperature = "tiepido"; priority = "media"; assignment_probability = 62;
      window_label = "Finestra in apertura: oltre 3 mesi sul mercato";
      commercial_reason = "L'immobile mostra una permanenza sul mercato superiore alla media della zona. Momento favorevole per una proposta con metodo.";
      next_action = "Invia presentazione personalizzata";
    }

    // Boost da price gap
    if (price_gap_pct !== null && price_gap_pct > 15 && giorni > 90) {
      assignment_probability = Math.min(92, assignment_probability + 8);
    }

    // Signals
    const signals: string[] = [];
    if (giorni > 180) signals.push("Presente da oltre 6 mesi");
    else if (giorni > 90) signals.push("Oltre 3 mesi sul mercato");
    if (price_gap_pct !== null) {
      if (price_gap_pct > 15) signals.push("Prezzo sopra mercato: pronto a trattare");
      if (price_gap_pct < -10) signals.push("Prezzo conveniente: acquirenti interessati");
    }

    if (price_gap_label) {
      commercial_reason = `${commercial_reason} ${price_gap_label}.`;
    }

    const estimated_value = Math.round(prezzo / 1000) * 1000;
    const seed = r.rawId ?? (r.title + territory + String(prezzo));

    out.push({
      id: shortId("opp-lst", seed),
      title: r.title.slice(0, 90),
      territory,
      microzona: zona,
      property_type,
      temperature,
      priority,
      assignment_probability,
      estimated_value,
      omi_value_mq,
      price_gap_pct,
      price_gap_label,
      commission_potential: Math.round(estimated_value * 0.03),
      window_label,
      commercial_reason,
      next_action,
      dossier_status: assignment_probability >= 70 ? "pronto" : "in_preparazione",
      signals,
      visible_to_agency: true,
    });
  }
  return out;
}

// ─── FONTE 2: ISTAT demografico ──────────────────────────────────────────
async function fetchIstatOpportunities(supabaseUrl: string, anonKey: string, auth: string): Promise<OpportunityEnhanced[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const url = `${supabaseUrl}/functions/v1/connector-istat-demografia?comune=Padova`;
    const res = await fetch(url, {
      headers: { "apikey": anonKey, "Authorization": auth },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const zones: unknown[] =
      (Array.isArray(data?.zones) && data.zones) ||
      (Array.isArray(data?.data?.zones) && data.data.zones) ||
      (Array.isArray(data?.data) && data.data) ||
      [];
    const out: OpportunityEnhanced[] = [];
    for (const z of zones) {
      if (!z || typeof z !== "object") continue;
      const e = z as Record<string, unknown>;
      const label = String(e.label ?? e.zona ?? e.nome ?? "").trim();
      const pct = Number(e.percentuale_anziani_soli ?? e.percentualeAnzianiSoli ?? e.anziani_soli_pct);
      if (!label || isNaN(pct) || pct <= 18) continue;
      const slug = typeof e.slug === "string" && e.slug ? e.slug : slugify(label);
      const isCaldo = pct > 25;
      const pctRounded = Math.round(pct * 10) / 10;
      out.push({
        id: `istat-${slug}`,
        title: `Zona ${label} · pressione successoria elevata`,
        territory: `Padova - ${label}`,
        microzona: label,
        property_type: "residenziale",
        temperature: isCaldo ? "caldo" : "tiepido",
        priority: isCaldo ? "alta" : "media",
        assignment_probability: Math.min(78, Math.round(pct * 2.8)),
        estimated_value: 0,
        omi_value_mq: null,
        price_gap_pct: null,
        price_gap_label: null,
        commission_potential: 0,
        window_label: "Finestra successoria: 2-4 anni",
        commercial_reason: `La zona ${label} ha una concentrazione di residenti anziani che vivono soli superiore alla media. Patrimoni immobiliari che nei prossimi anni entreranno in successione. Contatto anticipato ora.`,
        next_action: "Identifica proprietari anziani nella zona e pianifica primo contatto informale",
        dossier_status: "in_preparazione",
        signals: [`Concentrazione anziani soli: ${pctRounded}%`, "Pressione successoria potenziale"],
        visible_to_agency: true,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ─── FONTE 3: PNRR + Tram ────────────────────────────────────────────────
async function fetchPublicInvestmentJSON(url: string, anonKey: string, auth: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { "apikey": anonKey, "Authorization": auth },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function buildPublicInvestmentOpportunity(zona: string, signal: string): OpportunityEnhanced {
  return {
    id: shortId("opp-pub", zona + signal, 14),
    title: `Zona ${zona} · rivalutazione da investimento pubblico`,
    territory: `Padova - ${zona}`,
    microzona: zona,
    property_type: "residenziale",
    temperature: "tiepido",
    priority: "media",
    assignment_probability: 62,
    estimated_value: 0,
    omi_value_mq: null,
    price_gap_pct: null,
    price_gap_label: null,
    commission_potential: 0,
    window_label: "Finestra di rivalutazione: 12-24 mesi",
    commercial_reason: "Questa zona riceverà investimenti pubblici significativi nei prossimi 24 mesi. I proprietari attuali non conoscono ancora l'impatto sul valore. Prima di vendere ora, è il momento giusto per presentare un'analisi aggiornata.",
    next_action: "Prepara dossier con dati investimento pubblico e presenta al proprietario",
    dossier_status: "in_preparazione",
    signals: [signal],
    visible_to_agency: true,
  };
}

async function fetchPublicInvestmentOpportunities(supabaseUrl: string, anonKey: string, auth: string): Promise<OpportunityEnhanced[]> {
  const [pnrr, tram] = await Promise.all([
    fetchPublicInvestmentJSON(`${supabaseUrl}/functions/v1/civiko-pnrr-padova`, anonKey, auth),
    fetchPublicInvestmentJSON(`${supabaseUrl}/functions/v1/civiko-tram-padova`, anonKey, auth),
  ]);

  const seen = new Set<string>();
  const out: OpportunityEnhanced[] = [];

  // PNRR: cerca interventi con importo > 5M€ e zona riconoscibile
  const pnrrItems: unknown[] =
    (Array.isArray((pnrr as Record<string, unknown>)?.items) && ((pnrr as Record<string, unknown>).items as unknown[])) ||
    (Array.isArray((pnrr as Record<string, unknown>)?.data) && ((pnrr as Record<string, unknown>).data as unknown[])) ||
    (Array.isArray((pnrr as Record<string, unknown>)?.interventi) && ((pnrr as Record<string, unknown>).interventi as unknown[])) ||
    [];
  for (const it of pnrrItems) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    const importo = Number(e.importo ?? e.amount ?? e.valore ?? 0);
    if (!isFinite(importo) || importo <= 5_000_000) continue;
    const text = String(e.zona ?? e.area ?? e.titolo ?? e.descrizione ?? e.title ?? "");
    const zona = findZone(text);
    if (!zona || seen.has(`pnrr:${zona}`)) continue;
    seen.add(`pnrr:${zona}`);
    out.push(buildPublicInvestmentOpportunity(zona, "Investimento PNRR programmato"));
  }

  // Tram: nuove fermate (status in_costruzione | pre_esercizio | programmata)
  const tramRoot = tram as Record<string, unknown> | null;
  const tramStops: unknown[] =
    (Array.isArray(tramRoot?.nearestStops) && (tramRoot!.nearestStops as unknown[])) ||
    (Array.isArray(tramRoot?.data?.nearestStops) && ((tramRoot!.data as Record<string, unknown>).nearestStops as unknown[])) ||
    (Array.isArray(tramRoot?.stops) && (tramRoot!.stops as unknown[])) ||
    [];
  for (const it of tramStops) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    const status = String(e.status ?? "");
    if (status !== "in_costruzione" && status !== "pre_esercizio" && status !== "programmata") continue;
    const stopName = String(e.stopName ?? e.name ?? "");
    const zona = findZone(stopName);
    if (!zona || seen.has(`tram:${zona}`)) continue;
    seen.add(`tram:${zona}`);
    out.push(buildPublicInvestmentOpportunity(zona, "Nuova fermata tram"));
  }

  return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsFor(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return jsonResp({ error: "method_not_allowed" }, 405, cors);

  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return jsonResp({ error: "unauthorized" }, 401, cors);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey) return jsonResp({ error: "config_error" }, 500, cors);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResp({ error: "unauthorized" }, 401, cors);
  const user = userData.user;
  const email = (user.email ?? "").toLowerCase();

  // Role check
  let allowed = false;
  if (OWNER_EMAILS.includes(email)) allowed = true;
  if (!allowed && serviceKey) {
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const set = new Set((roles ?? []).map((r: { role: string }) => r.role));
    if (set.has("admin") || set.has("owner") || set.has("agency_user")) allowed = true;
  }
  if (!allowed) return jsonResp({ error: "forbidden" }, 403, cors);

  // ─── FONTE 1: Apify con fallback Firecrawl
  let raws = await fetchApifyListings();
  if (raws.length === 0) raws = await fetchFirecrawlFallback();
  const listingsP = buildListingOpportunities(raws, supabaseUrl, anonKey, auth);

  // ─── FONTE 2 + 3 in parallelo
  const [listings, istatRes, publicRes] = await Promise.allSettled([
    listingsP,
    fetchIstatOpportunities(supabaseUrl, anonKey, auth),
    fetchPublicInvestmentOpportunities(supabaseUrl, anonKey, auth),
  ]);

  const all: OpportunityEnhanced[] = [];
  if (listings.status === "fulfilled") all.push(...listings.value);
  if (istatRes.status === "fulfilled") all.push(...istatRes.value);
  if (publicRes.status === "fulfilled") all.push(...publicRes.value);

  all.sort((a, b) => b.assignment_probability - a.assignment_probability);
  const limited = all.slice(0, 20);

  return jsonResp(limited, 200, cors, {
    "X-Source": limited.length > 0 ? "live" : "empty",
    "X-Engine": "opportunity-engine-v1",
  });
});
