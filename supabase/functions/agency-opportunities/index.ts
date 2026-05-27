// agency-opportunities
// GET /functions/v1/agency-opportunities
// Returns real commercial opportunities aggregated from Firecrawl (listings
// long on the market) and Perplexity (territorial intelligence).
// PRINCIPLE: if APIs return nothing, response is []. No mocks, no invented data.
// Auth: Bearer JWT required. Role: agency_user | admin | owner.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

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

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const OWNER_EMAILS = (Deno.env.get("OWNER_EMAILS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// ─── Types ───────────────────────────────────────────────────────────────
interface Opportunity {
  id: string;
  title: string;
  territory: string;
  property_type: "residenziale" | "commerciale" | "terreno";
  temperature: "caldo" | "tiepido" | "freddo";
  priority: "alta" | "media" | "bassa";
  assignment_probability: number;
  estimated_value: number;
  commission_potential: number;
  window_label: string;
  commercial_reason: string;
  next_action: string;
  dossier_status: "pronto" | "in_preparazione";
  visible_to_agency: boolean;
  fonte_tipo?: string;
}

const PADOVA_ZONES = [
  "Arcella","Portello","Centro Storico","Forcellini","Guizza","Sacra Famiglia",
  "Camin","Stanga","Albignasego","Selvazzano Dentro","Abano Terme","Cadoneghe",
  "Limena","Vigodarzere","Rubano","Vigonza","Noventa Padovana","Montegrotto Terme",
  "Zona Industriale","Voltabarozzo","Pontevigodarzere","Mortise","Santo",
];

function findZone(text: string): string | null {
  const lower = text.toLowerCase();
  for (const z of PADOVA_ZONES) {
    if (lower.includes(z.toLowerCase())) return z;
  }
  return null;
}

function shortId(prefix: string, seed: string, len = 16): string {
  const b64 = btoa(unescape(encodeURIComponent(seed))).slice(0, len).replace(/[^a-z0-9]/gi, "");
  return `${prefix}-${b64}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── FONTE A: Firecrawl listings ─────────────────────────────────────────
async function firecrawlScrape(url: string, apiKey: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 14_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const md: string | undefined = data?.data?.markdown ?? data?.markdown;
    if (!md || md.length < 100) return null;
    return md.slice(0, 8000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const TYPOLOGIES = [
  "appartamento","villa","trilocale","bilocale","quadrilocale",
  "capannone","locale","negozio","ufficio","terreno",
];

function extractValue(block: string): number {
  // Patterns: €  150.000  /  150.000 €  /  € 150.000,00
  const patterns = [
    /€\s*([\d\.]+(?:[.,]\d+)?)/,
    /([\d\.]+(?:[.,]\d+)?)\s*€/,
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m) {
      const raw = m[1].replace(/\./g, "").replace(",", ".");
      const n = parseFloat(raw);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return 0;
}

function extractDays(block: string): number {
  const mDays = block.match(/(\d+)\s*(giorni?|days?)/i);
  if (mDays) return parseInt(mDays[1], 10);
  const mWeeks = block.match(/(\d+)\s*(settiman[ae]|weeks?)/i);
  if (mWeeks) return parseInt(mWeeks[1], 10) * 7;
  const mMonths = block.match(/(\d+)\s*(mes[ei]|months?)/i);
  if (mMonths) return parseInt(mMonths[1], 10) * 30;
  return 0;
}

function buildListingOpportunity(tipologia: string, zona: string | null, giorni: number, valore: number): Opportunity {
  const territory = zona ? `Padova - ${zona}` : "Padova";
  const propertyType: Opportunity["property_type"] =
    ["capannone","ufficio","negozio","locale"].includes(tipologia) ? "commerciale"
    : tipologia === "terreno" ? "terreno"
    : "residenziale";

  let temperature: Opportunity["temperature"] = "freddo";
  let priority: Opportunity["priority"] = "bassa";
  let assignment_probability = 45;
  let window_label = "Da qualificare";
  let commercial_reason = "Opportunità in monitoraggio. Da qualificare con primo contatto.";
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

  const estimated_value = Math.round(valore / 1000) * 1000;
  const commission_potential = Math.round(estimated_value * 0.03);

  return {
    id: shortId("fc-lst", territory + tipologia + String(valore)),
    title: `${capitalize(tipologia)} · ${territory.replace("Padova - ", "")}`,
    territory,
    property_type: propertyType,
    temperature,
    priority,
    assignment_probability,
    estimated_value,
    commission_potential,
    window_label,
    commercial_reason,
    next_action,
    dossier_status: assignment_probability >= 70 ? "pronto" : "in_preparazione",
    visible_to_agency: true,
  };
}

function parseListingsMarkdown(md: string, _sourceLabel: string): Opportunity[] {
  const out: Opportunity[] = [];
  const blocks: string[] = [];
  for (let i = 0; i < md.length; i += 500) blocks.push(md.slice(i, i + 500));

  for (const block of blocks) {
    const lower = block.toLowerCase();
    const hasTimeWord = /giorni|settiman|mes[ei]|days|weeks|months/i.test(block);
    if (!hasTimeWord) continue;

    const tipologia = TYPOLOGIES.find((t) => lower.includes(t));
    if (!tipologia) continue;

    const valore = extractValue(block);
    if (!valore || valore < 50_000) continue;

    const zona = findZone(block);
    const giorni = extractDays(block);

    out.push(buildListingOpportunity(tipologia, zona, giorni, valore));
  }
  return out;
}

async function fetchFirecrawlListings(): Promise<Opportunity[]> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return [];
  const sources: Array<{ url: string; label: string }> = [
    { url: "https://www.immobiliare.it/vendita-case/padova/?criterio=dataModifica&ordine=asc", label: "immobiliare.it" },
    { url: "https://www.idealista.it/vendita-immobili/padova-provincia/?ordine=publicazione-asc", label: "idealista.it" },
    { url: "https://www.casa.it/vendita/residenziale/padova-pd/?order=date_asc", label: "casa.it" },
  ];
  const settled = await Promise.allSettled(sources.map((s) => firecrawlScrape(s.url, key)));
  const all: Opportunity[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      all.push(...parseListingsMarkdown(r.value, sources[i].label));
    }
  });
  return all;
}

// ─── FONTE B: Perplexity ─────────────────────────────────────────────────
const VALID_PERP_TYPES = new Set(["residenziale", "commerciale", "industriale"]);

async function fetchPerplexityOpportunities(): Promise<Opportunity[]> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [{
          role: "user",
          content: "Cerca su fonti pubbliche italiane recenti (ultimi 6 mesi) notizie concrete su:\n\n1. Aziende con sede a Padova che hanno dichiarato fallimento, concordato preventivo o liquidazione volontaria nel 2024-2025 con asset immobiliari\n\n2. Aste giudiziarie immobiliari programmate nel Tribunale di Padova nel 2025\n\n3. Immobili industriali o commerciali a Padova rimasti invenduti oltre 12 mesi su portali pubblici\n\n4. Operazioni di dismissione immobiliare da enti pubblici o aziende sanitarie a Padova\n\nPer ogni notizia concreta trovata con fonte verificabile, restituisci JSON:\n[{\"titolo\":\"descrizione anonima max 60 chars\",\"zona\":\"microzona Padova\",\"tipo\":\"residenziale|commerciale|industriale\",\"motivo\":\"perché rilevante per incarico esclusiva max 80 chars\",\"probabilita\":65,\"valore\":300000,\"fonte_tipo\":\"asta|fallimento|dismissione|invenduto\"}]\n\nSe non hai notizie concrete e recenti verificabili, restituisci [].",
        }],
        temperature: 0.1,
        max_tokens: 1000,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    let content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return [];
    content = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return []; }
    if (!Array.isArray(parsed)) return [];

    const out: Opportunity[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const titolo = typeof e.titolo === "string" ? e.titolo : "";
      const zona = typeof e.zona === "string" ? e.zona : "";
      const tipo = typeof e.tipo === "string" ? e.tipo : "";
      const motivo = typeof e.motivo === "string" ? e.motivo : "";
      const probabilita = typeof e.probabilita === "number" ? e.probabilita : 0;
      const valore = typeof e.valore === "number" ? e.valore : 0;
      const fonte_tipo = typeof e.fonte_tipo === "string" ? e.fonte_tipo : "";
      if (!titolo || !zona || !tipo || !motivo) continue;
      if (titolo.length < 8) continue;
      if (probabilita < 40) continue;
      if (valore < 50_000) continue;
      if (!VALID_PERP_TYPES.has(tipo)) continue;

      let temperature: Opportunity["temperature"];
      let priority: Opportunity["priority"];
      let assignment_probability: number;

      switch (fonte_tipo) {
        case "asta":
          temperature = "caldo"; priority = "alta"; assignment_probability = 82; break;
        case "fallimento":
          temperature = "caldo"; priority = "alta"; assignment_probability = 75; break;
        case "dismissione":
          temperature = "tiepido"; priority = "media"; assignment_probability = 64; break;
        case "invenduto":
          temperature = "tiepido"; priority = "media"; assignment_probability = 58; break;
        default:
          assignment_probability = Math.min(88, Math.max(40, probabilita));
          temperature = assignment_probability >= 72 ? "caldo" : assignment_probability >= 55 ? "tiepido" : "freddo";
          priority = assignment_probability >= 72 ? "alta" : assignment_probability >= 55 ? "media" : "bassa";
      }

      const estimated_value = Math.round(valore / 1000) * 1000;
      const property_type: Opportunity["property_type"] =
        tipo === "industriale" ? "commerciale" : (tipo as "residenziale" | "commerciale");

      out.push({
        id: shortId("perp-opp", titolo + zona, 14),
        title: titolo,
        territory: `Padova - ${zona}`,
        property_type,
        temperature,
        priority,
        assignment_probability,
        estimated_value,
        commission_potential: Math.round(estimated_value * 0.03),
        window_label: "Finestra utile identificata",
        commercial_reason: motivo,
        next_action: "Prepara dossier e primo contatto",
        dossier_status: assignment_probability >= 65 ? "pronto" : "in_preparazione",
        visible_to_agency: true,
        fonte_tipo: fonte_tipo || undefined,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ─── Dedup ───────────────────────────────────────────────────────────────
function dedupe(records: Opportunity[]): Opportunity[] {
  const kept: Opportunity[] = [];
  for (const r of records) {
    const dupIdx = kept.findIndex((k) =>
      k.territory === r.territory &&
      k.property_type === r.property_type &&
      Math.abs(k.estimated_value - r.estimated_value) <= k.estimated_value * 0.15,
    );
    if (dupIdx === -1) {
      kept.push(r);
    } else if (r.assignment_probability > kept[dupIdx].assignment_probability) {
      kept[dupIdx] = r;
    }
  }
  return kept;
}

// ─── Handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsFor(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401, cors);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Unauthorized" }, 401, cors);
  }
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
    if (set.has("admin") || set.has("owner") || set.has("agency_user")) {
      allowed = true;
    }
  }

  if (!allowed) {
    return json({ error: "Forbidden" }, 403, cors);
  }

  const url = new URL(req.url);
  const agencyId = url.searchParams.get("agency_id");

  // Parallel data collection
  const [fcRes, ppRes] = await Promise.allSettled([
    fetchFirecrawlListings(),
    fetchPerplexityOpportunities(),
  ]);
  const all: Opportunity[] = [];
  if (fcRes.status === "fulfilled") all.push(...fcRes.value);
  if (ppRes.status === "fulfilled") all.push(...ppRes.value);

  // Fonte C: territory-records (segnali territoriali interni)
  const territoryOpps: Opportunity[] = [];
  try {
    const tUrl = new URL(req.url);
    tUrl.pathname = tUrl.pathname.replace("agency-opportunities", "territory-records");
    tUrl.search = "?city=Padova";
    const tRes = await fetch(tUrl.toString(), {
      headers: {
        "Authorization": req.headers.get("Authorization") ?? "",
        "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (tRes.ok) {
      const records: any[] = await tRes.json();
      for (const r of records) {
        if (r.priority_score < 65) continue;
        territoryOpps.push({
          id: "tr-" + r.id,
          title: r.title,
          territory: r.municipality + (r.area_label ? " - " + r.area_label : ""),
          property_type: (r.category === "brownfield" || r.category === "area_trasformazione")
            ? "commerciale" : "residenziale",
          temperature: r.priority_score >= 80 ? "caldo" : "tiepido",
          priority: r.priority_score >= 80 ? "alta" : "media",
          assignment_probability: Math.min(78, Math.round(r.priority_score * 0.88)),
          estimated_value: 0,
          commission_potential: 0,
          window_label: "Segnale territoriale attivo",
          commercial_reason: r.reason_short ?? r.scoring_reason,
          next_action: "Verifica immobili in questa zona e prepara primo contatto",
          dossier_status: "in_preparazione",
          visible_to_agency: true,
        });
      }
    }
  } catch { /* fonte fallita silenziosamente */ }
  all.push(...territoryOpps);


  const items = dedupe(all)
    .filter((o) => o.visible_to_agency)
    .sort((a, b) => b.assignment_probability - a.assignment_probability)
    .slice(0, 15);

  return new Response(JSON.stringify(items), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Core-Version": "v3.5.0",
      "X-Function": "agency-opportunities",
      "X-Agency-Filter": agencyId ?? "none",
      "X-Source": items.length > 0 ? "live" : "empty",
      "X-Record-Count": String(items.length),
    },
  });
});
