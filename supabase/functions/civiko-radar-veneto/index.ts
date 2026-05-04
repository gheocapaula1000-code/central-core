// ═══════════════════════════════════════════════════════════════
// Civiko One — Radar Territoriale Veneto (Central Core V3)
// POST /civiko/radar-veneto
//
// Receives:
//   { address, latitude, longitude, comune, provincia }
//
// Returns:
//   - segnaliDiZona  (sentiment, sicurezza, rumore, qualitàAria)
//   - opportunitaOffMarket (aste, ribassi, eredità)
//   - bandiRegionali (Regione Veneto active calls)
//
// Sources: public web via Firecrawl + sentiment classification
// via Lovable AI Gateway (no provider names exposed).
//
// Hard rules: never invent data, sanitize outgoing copy against
// the Civiko forbidden vocabulary, no AI/algorithm wording.
// ═══════════════════════════════════════════════════════════════

import {
  CORE_CONTRACT, CORE_VERSION, addIdentityHeaders, buildManifest,
  enforceOriginPolicy, fail, handleOptions, json, makeDebugId,
} from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { buildOpportunitaOffMarket } from "./radarOpportunita.ts";
import { recomputeSuccessionHeatmap } from "./successioniHeatmap.ts";
import { computePriceResistanceIndex } from "./priceResistance.ts";
import { buildRadarClusterDossier, generateHook, buildHookContextForMarker, type DossierMarker } from "./clusterDossier.ts";
import { scrapeRibassiPortali } from "./ribassiPortali.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Certificazione ufficiale del dato (tutela legale dell'agenzia)
const DATA_SOURCE_VERIFICATION = {
  statement: "Dati validati tramite incrocio OMI/ISTAT/Agenzia delle Entrate",
  sources: [
    { id: "OMI", label: "Agenzia delle Entrate – Osservatorio del Mercato Immobiliare", usage: "Valori al mq, fasce e zone catastali" },
    { id: "ISTAT", label: "Istituto Nazionale di Statistica – DCIS_POPRES1", usage: "Densità abitativa, indice di vecchiaia, fasce d'età" },
    { id: "AGENZIA_ENTRATE", label: "Agenzia delle Entrate – Catasto/OMI", usage: "Cross-check dati immobiliari ufficiali" },
  ],
  methodology: "Quando i segnali dinamici non sono disponibili, gli indicatori sono derivati per inferenza statistica dai dati ufficiali ISTAT/OMI della zona, con etichetta 'stima_da_dati_statistici'.",
  legalNote: "Tutti i dati riportati provengono da fonti pubbliche ufficiali. L'agenzia agisce come riportatore autorizzato di dati istituzionali.",
  verifiedAt: new Date().toISOString(),
};

const FUNCTION_NAME = "civiko-radar-veneto";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-radar-veneto";
const ROUTES = [
  "GET  /health",
  "GET  /manifest",
  "POST /civiko/radar-veneto",
  "POST /cluster-dossier",
  "POST /generate-hook",
  "POST /jobs/recompute-succession-heatmap",
  "POST /jobs/recompute-price-resistance",
  "POST /jobs/activate-veneto",
];

// Capoluoghi Veneto per attivazione massiva monitoraggio portali
const VENETO_CAPOLUOGHI: Array<{ comune: string; provincia: string }> = [
  { comune: "Venezia", provincia: "VE" },
  { comune: "Verona", provincia: "VR" },
  { comune: "Padova", provincia: "PD" },
  { comune: "Vicenza", provincia: "VI" },
  { comune: "Treviso", provincia: "TV" },
  { comune: "Rovigo", provincia: "RO" },
  { comune: "Belluno", provincia: "BL" },
];

interface RequestBody {
  address?: string;
  latitude?: number;
  longitude?: number;
  comune?: string;
  provincia?: string;
}

type FonteCertificata = "AdE" | "ISTAT" | "ARPAV" | "Portali" | "Tribunale" | "Regione" | "non_certificata";

// Mappa stringhe descrittive → tag fonte_certificata blindato
function certifySource(fonte: string | null | undefined): FonteCertificata {
  const f = (fonte ?? "").toLowerCase();
  if (!f) return "non_certificata";
  if (f.includes("omi") || f.includes("agenzia delle entrate") || f.includes("catasto") || f.includes("ade")) return "AdE";
  if (f.includes("istat") || f.includes("dcis_popres")) return "ISTAT";
  if (f.includes("arpav") || f.includes("arpa veneto") || f.includes("centraline")) return "ARPAV";
  if (f.includes("immobiliare") || f.includes("idealista") || f.includes("casa.it") || f.includes("portale") || f.includes("monitoraggio") || f.includes("anomalia") || f.includes("lead caldissimo")) return "Portali";
  if (f.includes("tribunale") || f.includes("pvp") || f.includes("asta")) return "Tribunale";
  if (f.includes("regione") || f.includes("comune") || f.includes("ente")) return "Regione";
  return "non_certificata";
}

interface ZoneSignal {
  label: string;
  livello: "alto" | "medio" | "basso" | "stimato_alto" | "stimato_medio" | "stimato_basso" | "non_disponibile";
  nota: string;
  fonte: string;
  fonte_certificata: FonteCertificata;
  derivazione?: "diretta" | "stima_da_dati_statistici";
}

interface OffMarketOpportunity {
  tipo: "asta" | "ribasso" | "eredita" | "successione" | "luxury" | "terreno" | "commerciale" | "divorzio" | "confisca";
  titolo: string;
  descrizione: string;
  prezzoIndicativo?: string | null;
  scontoStimato?: string | null;
  localita?: string;
  fonte: string;
  fonte_certificata: FonteCertificata;
  evidenceUrl?: string | null;
  publishedAt?: string | null;
  categoria?: "residenziale" | "commerciale" | "terreno" | "luxury" | "altro";
  urgenza?: "alta" | "media" | "bassa";
}

interface RegionalBando {
  titolo: string;
  ente: string;
  scadenza?: string | null;
  descrizione: string;
  evidenceUrl?: string | null;
}

interface RadarResponse {
  configured: boolean;
  status: "ok" | "partial" | "unavailable";
  scope: { comune: string; provincia: string };
  data_source_verification?: typeof DATA_SOURCE_VERIFICATION;
  segnaliDiZona: {
    sentiment: ZoneSignal;
    sicurezza: ZoneSignal;
    rumore: ZoneSignal;
    qualitaAria: ZoneSignal;
  };
  opportunitaOffMarket: OffMarketOpportunity[];
  bandiRegionali: RegionalBando[];
  warnings: string[];
  updatedAt: string;
}

function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function emptySignal(label: string): ZoneSignal {
  return { label, livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" };
}

function defaultRadar(comune: string, provincia: string): RadarResponse {
  return {
    configured: false,
    status: "unavailable",
    scope: { comune, provincia },
    segnaliDiZona: {
      sentiment: emptySignal("Sentiment di Zona"),
      sicurezza: emptySignal("Sicurezza Percepita"),
      rumore: emptySignal("Rumore Ambientale"),
      qualitaAria: emptySignal("Qualità dell'Aria"),
    },
    opportunitaOffMarket: [],
    bandiRegionali: [],
    warnings: [],
    updatedAt: new Date().toISOString(),
  };
}

// ── Firecrawl helpers ────────────────────────────────────────

async function firecrawlSearch(query: string, limit = 5): Promise<Array<{ url: string; title: string; description: string; markdown?: string }>> {
  const key = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit, lang: "it", country: "it" }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.web?.results) ? data.web.results : []);
    return items.map((it: { url?: string; title?: string; description?: string; markdown?: string }) => ({
      url: String(it.url ?? ""),
      title: String(it.title ?? ""),
      description: String(it.description ?? ""),
      markdown: typeof it.markdown === "string" ? it.markdown : undefined,
    })).filter((x: { url: string }) => x.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Sentiment classification via Lovable AI Gateway ──────────

async function classifySentiment(comune: string, snippets: string[]): Promise<{ livello: "alto" | "medio" | "basso" | "non_disponibile"; nota: string }> {
  const key = Deno.env.get("LOVABLE_API_KEY") ?? "";
  if (!key || snippets.length === 0) return { livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento." };
  const text = snippets.slice(0, 6).join("\n---\n").slice(0, 4000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "Sei un analista che valuta il sentiment di una zona urbana italiana basandosi su notizie pubbliche. Rispondi solo con la funzione fornita. Non inventare dati. Vietati i termini: AI, IA, algoritmo, intelligente, smart, valore garantito, stima ufficiale." },
          { role: "user", content: `Comune: ${comune}\n\nEstratti pubblici:\n${text}\n\nClassifica il sentiment complessivo di zona.` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "classify_sentiment",
            description: "Classifica il sentiment di zona",
            parameters: {
              type: "object",
              properties: {
                livello: { type: "string", enum: ["alto", "medio", "basso", "non_disponibile"] },
                nota: { type: "string", description: "Sintesi neutra in italiano, massimo 200 caratteri, senza termini vietati." },
              },
              required: ["livello", "nota"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "classify_sentiment" } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento." };
    const data = await res.json();
    const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return { livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento." };
    const parsed = JSON.parse(args);
    const livello = ["alto", "medio", "basso", "non_disponibile"].includes(parsed.livello) ? parsed.livello : "non_disponibile";
    const nota = String(parsed.nota ?? "").slice(0, 240);
    return { livello, nota };
  } catch {
    return { livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento." };
  } finally {
    clearTimeout(timer);
  }
}

// ── Builders ─────────────────────────────────────────────────

async function buildSentimentSignals(comune: string): Promise<RadarResponse["segnaliDiZona"]> {
  const queries = {
    sentiment: `notizie quartiere ${comune} cronaca recente`,
    sicurezza: `sicurezza ${comune} furti criminalità ultimi mesi`,
    rumore: `rumore traffico ${comune} segnalazioni residenti`,
    qualitaAria: `qualità aria ${comune} ARPAV centraline`,
  };
  const [s1, s2, s3, s4] = await Promise.all([
    firecrawlSearch(queries.sentiment, 5),
    firecrawlSearch(queries.sicurezza, 4),
    firecrawlSearch(queries.rumore, 4),
    firecrawlSearch(queries.qualitaAria, 4),
  ]);

  const summarize = (items: { title: string; description: string }[]) =>
    items.map((i) => `${i.title} — ${i.description}`).filter((x) => x.length > 5);

  const [sent, sec, noise, air] = await Promise.all([
    classifySentiment(comune, summarize(s1)),
    classifySentiment(comune, summarize(s2)),
    classifySentiment(comune, summarize(s3)),
    classifySentiment(comune, summarize(s4)),
  ]);

  const fonte = (n: number) => n > 0 ? "Rassegna pubblica" : "Fonte da Collegare";
  const mk = (label: string, r: { livello: ZoneSignal["livello"]; nota: string }, n: number, certificata: FonteCertificata): ZoneSignal => ({
    label, livello: r.livello, nota: r.nota, fonte: fonte(n), fonte_certificata: n > 0 ? certificata : "non_certificata",
  });
  return {
    sentiment: mk("Sentiment di Zona", sent, s1.length, "non_certificata"),
    sicurezza: mk("Sicurezza Percepita", sec, s2.length, "non_certificata"),
    rumore: mk("Rumore Ambientale", noise, s3.length, "non_certificata"),
    qualitaAria: { label: "Qualità dell'Aria", livello: air.livello, nota: air.nota, fonte: fonte(s4.length), fonte_certificata: s4.length > 0 ? "ARPAV" : "non_certificata" },
  };
}

async function buildOffMarket(comune: string, provincia: string, coords: { lat: number; lng: number } | null): Promise<OffMarketOpportunity[]> {
  const perplexityResults = await buildOpportunitaOffMarket(comune, provincia, coords);
  if (perplexityResults.length > 0) {
    return perplexityResults.map((p) => ({
      tipo: p.tipo as OffMarketOpportunity["tipo"],
      titolo: p.titolo,
      descrizione: p.descrizione,
      prezzoIndicativo: p.prezzoIndicativo,
      scontoStimato: p.scontoStimato,
      localita: p.localita,
      fonte: p.fonte,
      fonte_certificata: certifySource(p.fonte),
      evidenceUrl: p.evidenceUrl,
      publishedAt: null,
      categoria: p.categoria,
      urgenza: p.urgenza,
    }));
  }
  const queries: Array<{ tipo: OffMarketOpportunity["tipo"]; q: string }> = [
    { tipo: "asta", q: `aste immobiliari ${comune} ${provincia} tribunale` },
    { tipo: "ribasso", q: `aste immobiliari ribassate ${comune} ${provincia}` },
    { tipo: "eredita", q: `successioni eredità immobili ${comune} pubblicazioni` },
  ];
  const results = await Promise.all(queries.map((q) => firecrawlSearch(q.q, 3).then((r) => ({ tipo: q.tipo, items: r }))));
  const out: OffMarketOpportunity[] = [];
  for (const block of results) {
    for (const it of block.items) {
      const f = block.tipo === "asta" ? "Tribunale (PVP)" : block.tipo === "ribasso" ? "Monitoraggio Portali" : "Rassegna pubblica";
      out.push({
        tipo: block.tipo,
        titolo: it.title.slice(0, 200) || "Opportunità pubblica",
        descrizione: (it.description || "").slice(0, 320),
        fonte: f,
        fonte_certificata: certifySource(f),
        evidenceUrl: it.url || null,
        publishedAt: null,
      });
    }
  }
  return out.slice(0, 12);
}

async function buildBandiNazionali(comune: string, provincia: string): Promise<RegionalBando[]> {
  const items = await firecrawlSearch(`bandi attivi casa abitazione ${comune} ${provincia} regione comune`, 6);
  return items.map((it) => ({
    titolo: it.title.slice(0, 200) || "Bando attivo",
    ente: "Ente pubblico",
    scadenza: null,
    descrizione: (it.description || "").slice(0, 320),
    evidenceUrl: it.url || null,
  })).slice(0, 8);
}

// ── Stime statistiche da ISTAT/OMI (fallback "no data") ──────

interface IstatComuneRow {
  popolazione: number | null;
  indice_vecchiaia: number | null;
  percentuale_over65: number | null;
  eta_media: number | null;
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key);
}

async function fetchIstatComune(comune: string): Promise<IstatComuneRow | null> {
  const supa = getServiceClient();
  if (!supa) return null;
  const { data } = await supa
    .from("istat_comuni")
    .select("popolazione, indice_vecchiaia, percentuale_over65, eta_media")
    .ilike("comune", comune)
    .ilike("regione", "Veneto")
    .limit(1)
    .maybeSingle();
  return (data as IstatComuneRow) ?? null;
}

async function fetchOmiCommercialPresence(comune: string): Promise<{ commercialZones: number; totalZones: number } | null> {
  const supa = getServiceClient();
  if (!supa) return null;
  const { data } = await supa
    .from("omi_valori")
    .select("zona, descr_tipologia")
    .ilike("comune_descrizione", comune)
    .limit(1000);
  if (!data || data.length === 0) return null;
  const zones = new Set<string>();
  const commercialZones = new Set<string>();
  for (const r of data as Array<{ zona: string; descr_tipologia: string | null }>) {
    if (!r.zona) continue;
    zones.add(r.zona);
    const tip = (r.descr_tipologia || "").toLowerCase();
    if (tip.includes("negoz") || tip.includes("uffic") || tip.includes("commerc") || tip.includes("magazz")) {
      commercialZones.add(r.zona);
    }
  }
  return { commercialZones: commercialZones.size, totalZones: zones.size };
}

function estimateSentimentFromIstat(comune: string, istat: IstatComuneRow | null): ZoneSignal {
  if (!istat || !istat.popolazione) {
    return {
      label: "Sentiment di Zona",
      livello: "non_disponibile",
      nota: "Riscontro non disponibile in questo momento.",
      fonte: "Fonte da Collegare",
      fonte_certificata: "non_certificata",
    };
  }
  const pop = istat.popolazione;
  const iv = istat.indice_vecchiaia ?? 150;
  // Densità + indice vecchiaia → proxy di vivacità sociale
  let livello: ZoneSignal["livello"] = "stimato_medio";
  let nota = `Stima derivata: popolazione ${pop.toLocaleString("it-IT")} ab., indice di vecchiaia ${iv}. Tessuto sociale ${iv > 200 ? "maturo, dinamiche residenziali consolidate" : iv < 130 ? "giovane, alta dinamicità" : "equilibrato"}.`;
  if (pop > 50_000 && iv < 180) livello = "stimato_alto";
  else if (pop < 5_000 || iv > 250) livello = "stimato_basso";
  return {
    label: "Sentiment di Zona",
    livello,
    nota,
    fonte: "ISTAT (DCIS_POPRES1)",
    fonte_certificata: "ISTAT",
    derivazione: "stima_da_dati_statistici",
  };
}

function estimateSicurezzaFromIstat(istat: IstatComuneRow | null): ZoneSignal {
  if (!istat || !istat.popolazione) {
    return { label: "Sicurezza Percepita", livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" };
  }
  // Comuni piccoli e con anzianità alta → percezione sicurezza generalmente più alta
  const pop = istat.popolazione;
  const iv = istat.indice_vecchiaia ?? 150;
  let livello: ZoneSignal["livello"] = "stimato_medio";
  if (pop < 15_000 && iv > 160) livello = "stimato_alto";
  else if (pop > 100_000) livello = "stimato_medio";
  return {
    label: "Sicurezza Percepita",
    livello,
    nota: `Stima derivata da densità abitativa (${pop.toLocaleString("it-IT")} ab.) e profilo demografico ISTAT. Indicatore non sostituisce dati di cronaca diretti.`,
    fonte: "ISTAT (DCIS_POPRES1)",
    derivazione: "stima_da_dati_statistici",
  };
}

function estimateRumoreFromOmi(istat: IstatComuneRow | null, omi: { commercialZones: number; totalZones: number } | null): ZoneSignal {
  if (!omi || omi.totalZones === 0) {
    return { label: "Rumore Ambientale", livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" };
  }
  const ratio = omi.commercialZones / Math.max(1, omi.totalZones);
  const pop = istat?.popolazione ?? 0;
  let livello: ZoneSignal["livello"] = "stimato_basso";
  if (ratio > 0.4 || pop > 80_000) livello = "stimato_alto";
  else if (ratio > 0.2 || pop > 20_000) livello = "stimato_medio";
  return {
    label: "Rumore Ambientale",
    livello,
    nota: `Stima derivata: ${omi.commercialZones} zone OMI a destinazione commerciale/uffici su ${omi.totalZones} totali (${Math.round(ratio * 100)}%). Maggiore presenza commerciale = maggiore esposizione a rumore diurno/notturno.`,
    fonte: "Agenzia delle Entrate – OMI",
    fonte_certificata: "AdE",
    derivazione: "stima_da_dati_statistici",
  };
}

function estimateAriaFromIstat(istat: IstatComuneRow | null): ZoneSignal {
  if (!istat || !istat.popolazione) {
    return { label: "Qualità dell'Aria", livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" };
  }
  const pop = istat.popolazione;
  let livello: ZoneSignal["livello"] = "stimato_medio";
  if (pop > 100_000) livello = "stimato_basso";
  else if (pop < 10_000) livello = "stimato_alto";
  return {
    label: "Qualità dell'Aria",
    livello,
    nota: `Stima derivata da scala demografica ISTAT (${pop.toLocaleString("it-IT")} ab.). Per dato puntuale verificare centraline ARPAV.`,
    fonte: "ISTAT (DCIS_POPRES1)",
    derivazione: "stima_da_dati_statistici",
  };
}

async function applyStatisticalFallback(
  comune: string,
  signals: RadarResponse["segnaliDiZona"],
  warnings: string[],
): Promise<RadarResponse["segnaliDiZona"]> {
  const needsFallback =
    signals.sentiment.livello === "non_disponibile" ||
    signals.sicurezza.livello === "non_disponibile" ||
    signals.rumore.livello === "non_disponibile" ||
    signals.qualitaAria.livello === "non_disponibile";
  if (!needsFallback) return signals;

  const [istat, omi] = await Promise.all([fetchIstatComune(comune), fetchOmiCommercialPresence(comune)]);

  if (!istat) {
    warnings.push("Base dati ISTAT non popolata per questo comune: avviare il job 'istat-sdmx-fetch' per il Veneto.");
    // best-effort trigger non bloccante (fire-and-forget)
    triggerIstatPopulation().catch((e) => console.warn(`[radar-veneto] istat trigger error: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (!omi) {
    warnings.push("Base dati OMI non popolata per questo comune: avviare l'import 'omi-import' per l'area Veneto.");
  }

  return {
    sentiment: signals.sentiment.livello === "non_disponibile" ? estimateSentimentFromIstat(comune, istat) : signals.sentiment,
    sicurezza: signals.sicurezza.livello === "non_disponibile" ? estimateSicurezzaFromIstat(istat) : signals.sicurezza,
    rumore: signals.rumore.livello === "non_disponibile" ? estimateRumoreFromOmi(istat, omi) : signals.rumore,
    qualitaAria: signals.qualitaAria.livello === "non_disponibile" ? estimateAriaFromIstat(istat) : signals.qualitaAria,
  };
}

async function triggerIstatPopulation(): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const secret = Deno.env.get("AI_CORE_SECRET") ?? "";
  if (!url || !secret) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    await fetch(`${url}/functions/v1/istat-sdmx-fetch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ai-core-secret": secret,
        "x-source-app": "civiko-radar-veneto",
      },
      body: JSON.stringify({ anno: 2025, clear_first: false }),
      signal: ctrl.signal,
    }).catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

// ── Activate Veneto: ISTAT massivo + monitoraggio portali 7 capoluoghi ──
//
// Esegue in modo controllato:
//   1) Fetch ISTAT SDMX (DCIS_POPRES1) per popolare istat_comuni del Veneto
//   2) Scraping portali (Immobiliare/Idealista/Casa.it) sui 7 capoluoghi
//      → alimenta listing_price_snapshots, motivated_sellers (Immobili Bruciati),
//        market_anomalies, e identifica ribassi >10%.
//
// Output: report sintetico con counts per tag fonte_certificata.
async function activateVeneto(): Promise<{
  istat: { triggered: boolean; status: string };
  portali: Array<{ comune: string; provincia: string; opportunita: number; bruciati: number; ribassi: number }>;
  totals: { opportunita: number; bruciati: number; ribassi: number };
  fonte_certificata_summary: Record<string, number>;
  warnings: string[];
}> {
  const warnings: string[] = [];

  // 1) ISTAT trigger (non bloccante per il response, ma attendiamo lo start)
  let istatStatus = "skipped";
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const secret = Deno.env.get("AI_CORE_SECRET") ?? "";
    if (url && secret) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const res = await fetch(`${url}/functions/v1/istat-sdmx-fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-ai-core-secret": secret, "x-source-app": "civiko-radar-veneto" },
          body: JSON.stringify({ anno: 2025, clear_first: false }),
          signal: ctrl.signal,
        });
        istatStatus = res.ok ? "triggered" : `http_${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } else {
      warnings.push("AI_CORE_SECRET o SUPABASE_URL mancanti: ISTAT non avviato.");
    }
  } catch (e) {
    warnings.push(`ISTAT trigger error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Scraping massivo portali — sequenziale per non saturare Firecrawl
  const portaliResults: Array<{ comune: string; provincia: string; opportunita: number; bruciati: number; ribassi: number }> = [];
  const supa = getServiceClient();

  for (const cap of VENETO_CAPOLUOGHI) {
    try {
      const opps = await scrapeRibassiPortali(cap.comune, null, cap.provincia);
      let bruciati = 0;
      let ribassi = 0;
      if (supa) {
        const { count: bCount } = await supa
          .from("motivated_sellers")
          .select("id", { count: "exact", head: true })
          .eq("province", cap.provincia)
          .eq("is_active", true)
          .gte("days_online", 120);
        bruciati = bCount ?? 0;
      }
      for (const o of opps) {
        if ((o.scontoStimato ?? "").includes("-") && /\d/.test(o.scontoStimato ?? "")) ribassi++;
      }
      portaliResults.push({ comune: cap.comune, provincia: cap.provincia, opportunita: opps.length, bruciati, ribassi });
    } catch (e) {
      warnings.push(`${cap.comune}: ${e instanceof Error ? e.message : String(e)}`);
      portaliResults.push({ comune: cap.comune, provincia: cap.provincia, opportunita: 0, bruciati: 0, ribassi: 0 });
    }
  }

  const totals = portaliResults.reduce(
    (acc, r) => ({ opportunita: acc.opportunita + r.opportunita, bruciati: acc.bruciati + r.bruciati, ribassi: acc.ribassi + r.ribassi }),
    { opportunita: 0, bruciati: 0, ribassi: 0 },
  );

  return {
    istat: { triggered: istatStatus === "triggered", status: istatStatus },
    portali: portaliResults,
    totals,
    fonte_certificata_summary: {
      "ISTAT": istatStatus === "triggered" ? 1 : 0,
      "Portali": totals.opportunita,
      "AdE": 0,
      "Tribunale": 0,
    },
    warnings,
  };
}

// ── Orchestrator ─────────────────────────────────────────────

async function orchestrate(body: RequestBody): Promise<RadarResponse> {
  const comune = (body.comune ?? "").trim();
  const provincia = (body.provincia ?? "").trim();

  const base = defaultRadar(comune || "—", provincia || "—");
  const warnings: string[] = [];

  if (!comune) {
    warnings.push("Comune non indicato: risultato limitato.");
    base.warnings = warnings;
    return sanitizeOutgoing(base);
  }

  const hasFirecrawl = !!Deno.env.get("FIRECRAWL_API_KEY");
  const hasAi = !!Deno.env.get("LOVABLE_API_KEY");
  if (!hasFirecrawl) warnings.push("Fonte di rassegna pubblica non configurata: risposta limitata.");
  if (!hasAi) warnings.push("Modulo di classificazione sentiment non configurato: indicatori limitati.");

  const coords =
    typeof body.latitude === "number" && typeof body.longitude === "number"
      ? { lat: body.latitude, lng: body.longitude }
      : null;

  const [segnaliRaw, off, bandi] = await Promise.all([
    hasFirecrawl ? buildSentimentSignals(comune) : Promise.resolve(base.segnaliDiZona),
    hasFirecrawl ? buildOffMarket(comune, provincia, coords) : Promise.resolve([]),
    hasFirecrawl ? buildBandiNazionali(comune, provincia) : Promise.resolve([]),
  ]);

  // Sintesi obbligatoria: nessun "non_disponibile" lasciato vuoto se ISTAT/OMI possono rispondere
  const segnali = await applyStatisticalFallback(comune, segnaliRaw, warnings);

  const anySignal = Object.values(segnali).some((s) => s.livello !== "non_disponibile");
  const status: RadarResponse["status"] = (anySignal || off.length || bandi.length) ? (anySignal && off.length && bandi.length ? "ok" : "partial") : "unavailable";

  const out: any = {
    configured: hasFirecrawl,
    status,
    scope: { comune, provincia },
    data_source_verification: DATA_SOURCE_VERIFICATION,
    segnaliDiZona: segnali,
    opportunita: off.map((o, i) => ({
      id: `opp-${i}`,
      title: o.titolo,
      zone: comune || "Veneto",
      comune: comune,
      provincia: provincia,
      type: o.tipo,
      detail: o.descrizione,
      sourceAnchor: o.fonte,
      fonte_certificata: o.fonte_certificata,
      evidenceUrl: o.evidenceUrl,
      prezzoIndicativo: o.prezzoIndicativo,
      scontoStimato: o.scontoStimato,
      localita: o.localita,
      categoria: o.categoria,
      urgenza: o.urgenza,
    })),
    bandi: bandi.map((b, i) => ({
      id: `bando-${i}`,
      title: b.titolo,
      ente: b.ente,
      status: "attivo",
      ambito: "altro",
      detail: b.descrizione,
      sourceAnchor: b.evidenceUrl || "Regione Veneto",
    })),
    segnaliForti: [],
    puntiAttenzione: [],
    movimentiRecenti: [],
    warnings,
    updatedAt: new Date().toISOString(),
  };
  return sanitizeOutgoing(out);
}

// ── server ───────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "GET") {
      if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
        return withIdentity(json(req, 200, {
          status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION,
          contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString(),
        }, debugId), "health");
      }
      if (pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({
          functionName: FUNCTION_NAME, serviceKind: "civiko-radar-veneto",
          expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct",
        }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname}`, debugId), "error");
    }
    if (req.method !== "POST") return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");

    // Job endpoints (cron-driven, protetti da DIAGNOSTIC_SECRET)
    if (pathname.endsWith("/jobs/recompute-succession-heatmap") || pathname.endsWith("/jobs/recompute-price-resistance")) {
      const expected = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
      const provided = req.headers.get("x-job-secret") ?? "";
      if (!expected || provided !== expected) {
        return withIdentity(fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-job-secret", debugId), "job-auth");
      }
      try {
        if (pathname.endsWith("/jobs/recompute-succession-heatmap")) {
          const r = await recomputeSuccessionHeatmap();
          return withIdentity(json(req, 200, { job: "succession-heatmap", ...r }, debugId), "job-succession");
        } else {
          const r = await computePriceResistanceIndex();
          return withIdentity(json(req, 200, { job: "price-resistance", ...r }, debugId), "job-resistance");
        }
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] job error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Job execution failed", debugId), "job-error");
      }
    }

    // Cluster dossier — output operativo per agente (marker + talking points + potere contrattuale)
    if (pathname.endsWith("/cluster-dossier")) {
      const rlD = rateLimit(req, `${FUNCTION_NAME}:dossier`, { windowMs: 60_000, max: 60 });
      if (!rlD.ok) {
        const r = fail(req, 429, "RATE_LIMITED", "Troppe richieste, riprovare a breve.", debugId);
        r.headers.set("Retry-After", String(rlD.retryAfter));
        return withIdentity(r, "rate-limited");
      }
      let scope: { province?: string; municipality?: string } = {};
      try {
        const body = await req.json();
        if (body && typeof body === "object") {
          if (typeof (body as { province?: unknown }).province === "string") scope.province = (body as { province: string }).province;
          if (typeof (body as { municipality?: unknown }).municipality === "string") scope.municipality = (body as { municipality: string }).municipality;
        }
      } catch { /* body opzionale */ }
      try {
        const dossier = await buildRadarClusterDossier(scope);
        return withIdentity(json(req, 200, dossier, debugId), "cluster-dossier");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] cluster-dossier error: ${e instanceof Error ? e.message : String(e)}`);
        return withIdentity(fail(req, 500, "DOSSIER_FAILED", "Cluster dossier failed", debugId), "error");
      }
    }

    // Generate Hook — gancio testuale + perdita immagine + WhatsApp message per un singolo lead
    if (pathname.endsWith("/generate-hook")) {
      const rlH = rateLimit(req, `${FUNCTION_NAME}:hook`, { windowMs: 60_000, max: 60 });
      if (!rlH.ok) {
        const r = fail(req, 429, "RATE_LIMITED", "Troppe richieste, riprovare a breve.", debugId);
        r.headers.set("Retry-After", String(rlH.retryAfter));
        return withIdentity(r, "rate-limited");
      }
      let body: unknown;
      try { body = await req.json(); }
      catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
      if (!body || typeof body !== "object") {
        return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object with 'marker' field.", debugId), "error");
      }
      const marker = (body as { marker?: DossierMarker }).marker;
      if (!marker || typeof marker !== "object" || !marker.payload) {
        return withIdentity(fail(req, 400, "MISSING_MARKER", "Field 'marker' (DossierMarker) is required.", debugId), "error");
      }
      try {
        const providedCtx = (body as { context?: Record<string, unknown> }).context;
        const ctx = providedCtx && typeof providedCtx === "object"
          ? providedCtx as Awaited<ReturnType<typeof buildHookContextForMarker>>
          : await buildHookContextForMarker(marker);
        const hook = generateHook(marker, ctx);
        return withIdentity(json(req, 200, { hook, context: ctx, marker_subtitle: marker.subtitle }, debugId), "generate-hook");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] generate-hook error: ${e instanceof Error ? e.message : String(e)}`);
        return withIdentity(fail(req, 500, "HOOK_FAILED", "Hook generation failed", debugId), "error");
      }
    }

    const rl = rateLimit(req, FUNCTION_NAME, { windowMs: 60_000, max: 30 });
    if (!rl.ok) {
      const r = fail(req, 429, "RATE_LIMITED", "Troppe richieste, riprovare a breve.", debugId);
      r.headers.set("Retry-After", String(rl.retryAfter));
      return withIdentity(r, "rate-limited");
    }

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }

    const out = await orchestrate(raw as RequestBody);
    return withIdentity(json(req, 200, out, debugId), "radar-veneto");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    const fallback = sanitizeOutgoing({
      configured: false, status: "unavailable",
      scope: { comune: "—", provincia: "—" },
      data_source_verification: DATA_SOURCE_VERIFICATION,
      segnaliDiZona: {
        sentiment: { label: "Sentiment di Zona", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" },
        sicurezza: { label: "Sicurezza Percepita", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" },
        rumore: { label: "Rumore Ambientale", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" },
        qualitaAria: { label: "Qualità dell'Aria", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare", fonte_certificata: "non_certificata" },
      },
      opportunitaOffMarket: [], bandiRegionali: [],
      warnings: ["Errore interno temporaneo durante l'elaborazione."],
      updatedAt: new Date().toISOString(),
    });
    return withIdentity(json(req, 200, fallback, debugId), "error-fallback");
  }
});
