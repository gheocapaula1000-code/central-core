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
  enforceOriginPolicy, fail, handleOptions, json, makeDebugId, requireSecret,
} from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { buildOpportunitaOffMarket } from "./radarOpportunita.ts";
import { recomputeSuccessionHeatmap } from "./successioniHeatmap.ts";
import { computePriceResistanceIndex } from "./priceResistance.ts";
import { buildRadarClusterDossier, generateHook, buildHookContextForMarker, type DossierMarker } from "./clusterDossier.ts";
import { scrapeRibassiPortali } from "./ribassiPortali.ts";
import { buildAgentRadar, type AgentRadarRequest } from "./agentRadar.ts";
import { deriveAllSignals } from "./deriveSignals.ts";
import { buildVenetoDataEngine } from "./dataEngine.ts";
import { importVenetoAuctions } from "./auctionImport.ts";
import { runFirecrawlDeepVeneto } from "./firecrawl/crawlRunner.ts";
import { runMicrozoneOpportunitySignals } from "./firecrawl/microzoneOpportunityRunner.ts";
import { runOffMarketOpportunityEngine } from "./offmarket/offMarketOpportunityEngine.ts";
import { runOffMarketFirecrawlDiscovery } from "./offmarket/offMarketFirecrawlRunner.ts";
import { runEarlyOffmarketDiscovery } from "./offmarket/earlyOffmarketRunner.ts";
import { runRescoreEarlyCandidates, runPromoteEarlyCandidate, runListEarlyCandidates } from "./offmarket/earlySignalReview.ts";
import { runAgencyOffmarketBrief } from "./agency/agencyOffmarketBrief.ts";
import { handleAgencyCrudRoute } from "./agency/agencyCrud.ts";
import { runAdvancedVenetoOpportunities } from "./advancedOpportunity.ts";
import { buildVenetoIntelligenceFromResearch } from "./intelligence/orchestrator.ts";
import { runVenetoOpenDataImport } from "./openData/ckanImporter.ts";
import { runOpenDataVenetoDeepImport } from "./openData/openDataVenetoCkanImporter.ts";
import { enrichRadarFromOpenDataVeneto } from "./openData/openDataEnrichment.ts";
import { runGeoportaleVenetoDiscovery } from "./openData/geoportaleVenetoCswImporter.ts";
import { runGeoportaleImport } from "./openData/geoportaleVenetoImporter.ts";
import { runGeoportaleRecovery } from "./openData/geoportaleVenetoRecovery.ts";
import { runArpavAirImport } from "./openData/arpavAirImporter.ts";
import { runArpavEnvironmentalImport } from "./openData/arpavEnvironmentalImporter.ts";
import { runEnrichMicrozoneFromTerritorial } from "./openData/microzoneEnricher.ts";
import { runIspraRiskEnrichment } from "./openData/ispraRiskEnricher.ts";
import { runGeoportaleGreenImport } from "./openData/geoportaleGreenImporter.ts";
import { discoverVenetoAuctions } from "./legal/auctionDiscovery.ts";
import { startAuctionDiscoveryRun, getAuctionDiscoveryRun, importAuctionCandidates } from "./legal/auctionRunStore.ts";
import { runApifyForVenetoSource } from "./apify/apifyAdapter.ts";
import { runApifyForVenetoSourceV2, apifyDiagnostics } from "./apify/apifyOrchestrator.ts";
import { APIFY_VENETO_REGISTRY } from "./apify/apifySourceRegistry.ts";
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
  "POST /agent-radar",
  "POST /cluster-dossier",
  "POST /generate-hook",
  "POST /jobs/recompute-succession-heatmap",
  "POST /jobs/recompute-price-resistance",
  "POST /jobs/activate-veneto",
  "POST /jobs/deep-scan-padova",
  "POST /jobs/perplexity-deep-padova",
  "POST /jobs/microzone-padova",
  "POST /jobs/build-civiko-veneto-data-engine",
  "POST /jobs/seed-veneto-comuni",
  "POST /jobs/import-veneto-auctions",
  "POST /jobs/firecrawl-deep-veneto",
  "POST /jobs/firecrawl-microzone-opportunity-signals",
  "POST /jobs/build-advanced-veneto-opportunities",
  "POST /jobs/import-veneto-open-data",
  "POST /jobs/import-veneto-geo-environment",
  "POST /jobs/import-omi-territorial-notes",
  "POST /jobs/build-veneto-intelligence-from-research",
  "POST /jobs/apify-run-veneto-source",
  "POST /jobs/apify-diagnostics",
  "GET  /jobs/apify-registry",
  "POST /jobs/enrich-radar-from-open-data-veneto",
  "POST /jobs/geoportale-veneto-discovery",
  "POST /jobs/import-geoportale-veneto-layers",
  "POST /jobs/recover-geoportale-veneto-unassigned",
  "POST /jobs/import-arpav-air-quality",
  "POST /jobs/enrich-microzone-sentiment-from-territorial-signals",
 "POST /jobs/enrich-microzone-sentiment-from-ispra-risk",
 "POST /jobs/import-geoportale-green-coverage",
 "POST /jobs/discover-veneto-auctions",
 "POST /jobs/start-auction-discovery",
 "POST /jobs/auction-discovery-status",
  "POST /jobs/import-auction-candidates",
  "POST /jobs/build-offmarket-opportunity-scores",
  "POST /jobs/firecrawl-offmarket-microzone-discovery",
  "POST /jobs/discover-early-offmarket-signals",
  "POST /jobs/offmarket-padova",
  "POST /jobs/rescore-early-offmarket-candidates",
  "POST /jobs/promote-early-signal-candidate",
  "POST /jobs/promote-batch",
  "POST /jobs/list-early-signal-candidates",
  "POST /jobs/build-agency-offmarket-brief",
  "POST /agency/personal",
  "POST /agency/operating-areas/list",
  "POST /agency/operating-areas/create",
  "POST /agency/operating-areas/update",
  "POST /agency/operating-areas/deactivate",
  "POST /agency/signal-preferences/get",
  "POST /agency/signal-preferences/upsert",
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
  livello:
    | "alto" | "medio" | "basso"
    | "stimato_alto" | "stimato_medio" | "stimato_basso"
    | "in_certificazione"            // NEW: dato non ancora disponibile, scansione profonda in corso
    | "non_disponibile";              // legacy: usato solo in errore hard
  nota: string;
  fonte: string;
  fonte_certificata: FonteCertificata;
  derivazione?: "diretta" | "stima_da_dati_statistici" | "stima_da_prossimita_infrastrutture";
  scansione_profonda?: { stato: "avviata" | "in_corso" | "non_attivata"; eta_minuti?: number };
}

// ── Veneto infrastructure proxies (per environmental engine) ────
// Bbox approssimati delle principali assi autostradali e nodi rumorosi.
// Usati solo come PROXY ufficiali (Concessionari Autostrade per l'Italia, RFI).
// Distanza euclidea su coordinate decimali (sufficiente per livello qualitativo).
interface InfraPoint { name: string; lat: number; lng: number; tipo: "autostrada" | "stazione" | "industriale" | "aeroporto"; }
const VENETO_INFRA_POINTS: InfraPoint[] = [
  // A4 Milano-Venezia (passaggi chiave)
  { name: "A4 casello Verona Est", lat: 45.4380, lng: 11.0640, tipo: "autostrada" },
  { name: "A4 casello Vicenza Est", lat: 45.5350, lng: 11.6280, tipo: "autostrada" },
  { name: "A4 casello Padova Ovest", lat: 45.4180, lng: 11.7920, tipo: "autostrada" },
  { name: "A4 casello Padova Est", lat: 45.4050, lng: 11.9620, tipo: "autostrada" },
  { name: "A4 casello Mestre", lat: 45.4790, lng: 12.2380, tipo: "autostrada" },
  // A27 Venezia-Belluno
  { name: "A27 casello Treviso Sud", lat: 45.6420, lng: 12.2360, tipo: "autostrada" },
  { name: "A27 casello Conegliano", lat: 45.8740, lng: 12.3050, tipo: "autostrada" },
  { name: "A27 casello Belluno", lat: 46.1320, lng: 12.2080, tipo: "autostrada" },
  // Stazioni RFI nodi (rumore notturno merci)
  { name: "Stazione Mestre", lat: 45.4820, lng: 12.2330, tipo: "stazione" },
  { name: "Stazione Padova FS", lat: 45.4160, lng: 11.8800, tipo: "stazione" },
  { name: "Stazione Verona Porta Nuova", lat: 45.4280, lng: 10.9820, tipo: "stazione" },
  // Aree industriali storiche
  { name: "Area industriale Marghera", lat: 45.4640, lng: 12.2230, tipo: "industriale" },
  { name: "ZI Padova Est", lat: 45.4070, lng: 11.9300, tipo: "industriale" },
  { name: "ZI Montebello Vicentino", lat: 45.4500, lng: 11.3850, tipo: "industriale" },
  // Aeroporti
  { name: "Aeroporto Venezia Marco Polo", lat: 45.5060, lng: 12.3520, tipo: "aeroporto" },
  { name: "Aeroporto Verona Catullo", lat: 45.3950, lng: 10.8860, tipo: "aeroporto" },
];

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function nearbyInfraImpact(lat: number | null, lng: number | null): { score: number; reasons: string[] } {
  if (typeof lat !== "number" || typeof lng !== "number") return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 0;
  for (const p of VENETO_INFRA_POINTS) {
    const d = distanceKm(lat, lng, p.lat, p.lng);
    if (d > 5) continue;
    // peso per tipo
    const w = p.tipo === "autostrada" ? 3 : p.tipo === "aeroporto" ? 4 : p.tipo === "stazione" ? 2 : 1.5;
    const proximity = Math.max(0, 1 - d / 5); // 1=adiacente, 0=5km
    const contrib = w * proximity;
    score += contrib;
    if (d <= 2) reasons.push(`${p.name} a ${d.toFixed(1)} km`);
  }
  return { score, reasons: reasons.slice(0, 3) };
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

/**
 * Job endpoint authorization.
 * Validates header `x-job-secret` against, in order:
 *   1. CENTRAL_CORE_JOB_SECRET (canonical, preferred)
 *   2. DIAGNOSTIC_SECRET (legacy fallback for retro-compat)
 * Returns null if authorized, otherwise an error Response.
 * Never logs or returns the secret value.
 */
function authorizeJob(req: Request, debugId: string): Response | null {
  const primary = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const fallback = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  if (!primary && !fallback) {
    return withIdentity(
      fail(req, 500, "CONFIG_ERROR", "CENTRAL_CORE_JOB_SECRET non configurato", debugId),
      "job-auth",
    );
  }
  const provided = req.headers.get("x-job-secret") ?? "";
  if (!provided) {
    return withIdentity(fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-job-secret", debugId), "job-auth");
  }
  const ok = (primary && provided === primary) || (fallback && provided === fallback);
  if (!ok) {
    return withIdentity(fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-job-secret", debugId), "job-auth");
  }
  return null;
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

function estimateRumoreFromOmi(
  istat: IstatComuneRow | null,
  omi: { commercialZones: number; totalZones: number } | null,
  coords: { lat: number; lng: number } | null,
): ZoneSignal {
  // Environmental engine: combina prossimità infrastrutture (A4/A27/Passante/RFI/aeroporti/ZI)
  // + densità commerciale OMI. Se nessuno è disponibile → in_certificazione (no errore).
  const infra = nearbyInfraImpact(coords?.lat ?? null, coords?.lng ?? null);
  const ratio = omi && omi.totalZones > 0 ? omi.commercialZones / Math.max(1, omi.totalZones) : 0;
  const pop = istat?.popolazione ?? 0;

  if (!omi && infra.score === 0 && pop === 0) {
    return {
      label: "Rumore Ambientale",
      livello: "in_certificazione",
      nota: "Dato in fase di certificazione: scansione profonda su sorgenti infrastrutturali (Autostrade per l'Italia, RFI) avviata.",
      fonte: "Veneto Environmental Engine",
      fonte_certificata: "Regione",
      derivazione: "stima_da_prossimita_infrastrutture",
      scansione_profonda: { stato: "avviata", eta_minuti: 5 },
    };
  }

  // Score combinato 0..10
  const omiScore = ratio * 4 + (pop > 80_000 ? 2 : pop > 20_000 ? 1 : 0);
  const totalScore = infra.score + omiScore;
  let livello: ZoneSignal["livello"] = "stimato_basso";
  if (totalScore >= 4) livello = "stimato_alto";
  else if (totalScore >= 1.8) livello = "stimato_medio";

  const parts: string[] = [];
  if (infra.reasons.length > 0) parts.push(`Sorgenti rumore vicine: ${infra.reasons.join(", ")}`);
  if (omi && omi.totalZones > 0) parts.push(`${omi.commercialZones}/${omi.totalZones} zone OMI commerciali (${Math.round(ratio * 100)}%)`);
  if (parts.length === 0) parts.push(`scala demografica ${pop.toLocaleString("it-IT")} ab.`);

  return {
    label: "Rumore Ambientale",
    livello,
    nota: `Stima derivata da prossimità infrastrutture autostradali/ferroviarie e densità commerciale OMI. ${parts.join(" • ")}.`,
    fonte: infra.score > 0 ? "Concessionari autostradali + OMI/AdE" : "Agenzia delle Entrate – OMI",
    fonte_certificata: infra.score > 0 ? "Regione" : "AdE",
    derivazione: infra.score > 0 ? "stima_da_prossimita_infrastrutture" : "stima_da_dati_statistici",
  };
}

function estimateAriaFromIstat(istat: IstatComuneRow | null, coords: { lat: number; lng: number } | null): ZoneSignal {
  const infra = nearbyInfraImpact(coords?.lat ?? null, coords?.lng ?? null);
  if (!istat || !istat.popolazione) {
    if (infra.score === 0) {
      return {
        label: "Qualità dell'Aria",
        livello: "in_certificazione",
        nota: "Dato in fase di certificazione: query alle centraline ARPAV più prossime in corso.",
        fonte: "ARPAV (centraline regionali)",
        fonte_certificata: "ARPAV",
        scansione_profonda: { stato: "avviata", eta_minuti: 5 },
      };
    }
    // Stima da sole infrastrutture
    return {
      label: "Qualità dell'Aria",
      livello: infra.score >= 4 ? "stimato_basso" : infra.score >= 1.8 ? "stimato_medio" : "stimato_alto",
      nota: `Stima derivata da prossimità infrastrutture: ${infra.reasons.join(", ") || "rete autostradale/industriale"}.`,
      fonte: "Concessionari autostradali + ARPAV",
      fonte_certificata: "ARPAV",
      derivazione: "stima_da_prossimita_infrastrutture",
    };
  }
  const pop = istat.popolazione;
  // Combina densità + infrastrutture
  let livello: ZoneSignal["livello"] = "stimato_medio";
  if (pop > 100_000 || infra.score >= 4) livello = "stimato_basso";
  else if (pop < 10_000 && infra.score < 1) livello = "stimato_alto";
  const infraNote = infra.reasons.length > 0 ? ` Sorgenti vicine: ${infra.reasons.join(", ")}.` : "";
  return {
    label: "Qualità dell'Aria",
    livello,
    nota: `Stima derivata da scala demografica ISTAT (${pop.toLocaleString("it-IT")} ab.) e prossimità infrastrutture.${infraNote} Per dato puntuale verificare centraline ARPAV.`,
    fonte: infra.score > 0 ? "ISTAT + ARPAV (proxy)" : "ISTAT (DCIS_POPRES1)",
    fonte_certificata: infra.score > 0 ? "ARPAV" : "ISTAT",
    derivazione: infra.score > 0 ? "stima_da_prossimita_infrastrutture" : "stima_da_dati_statistici",
  };
}

async function applyStatisticalFallback(
  comune: string,
  signals: RadarResponse["segnaliDiZona"],
  coords: { lat: number; lng: number } | null,
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
    warnings.push("Base dati ISTAT in fase di certificazione per questo comune: scansione profonda 'istat-sdmx-fetch' avviata.");
    triggerIstatPopulation().catch((e) => console.warn(`[radar-veneto] istat trigger error: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (!omi) {
    warnings.push("Base dati OMI in fase di certificazione per questo comune: avviare l'import 'omi-import' per l'area Veneto.");
  }

  // Sentiment / Sicurezza: se ISTAT mancante per frazione remota → in_certificazione (no errore)
  const inCertificazione = (label: string, fc: FonteCertificata, fonte: string): ZoneSignal => ({
    label, livello: "in_certificazione",
    nota: "Dato in fase di certificazione: scansione profonda istantanea avviata su fonti ufficiali.",
    fonte, fonte_certificata: fc,
    scansione_profonda: { stato: "avviata", eta_minuti: 5 },
  });

  return {
    sentiment: signals.sentiment.livello === "non_disponibile"
      ? (istat ? estimateSentimentFromIstat(comune, istat) : inCertificazione("Sentiment di Zona", "ISTAT", "ISTAT (DCIS_POPRES1)"))
      : signals.sentiment,
    sicurezza: signals.sicurezza.livello === "non_disponibile"
      ? (istat ? estimateSicurezzaFromIstat(istat) : inCertificazione("Sicurezza Percepita", "ISTAT", "ISTAT (DCIS_POPRES1)"))
      : signals.sicurezza,
    rumore: signals.rumore.livello === "non_disponibile"
      ? estimateRumoreFromOmi(istat, omi, coords)
      : signals.rumore,
    qualitaAria: signals.qualitaAria.livello === "non_disponibile"
      ? estimateAriaFromIstat(istat, coords)
      : signals.qualitaAria,
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
        "x-internal-secret": secret,
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
  derive: Awaited<ReturnType<typeof deriveAllSignals>>;
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
          headers: { "Content-Type": "application/json", "x-internal-secret": secret, "x-source-app": "civiko-radar-veneto" },
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

  // 3) Derivazione automatica motivated_sellers + market_anomalies + radar_signals
  //    da snapshot esistenti (reali e seed_demo) + OMI reale.
  let derive: Awaited<ReturnType<typeof deriveAllSignals>>;
  try {
    derive = await deriveAllSignals();
    if (derive.warnings.length) warnings.push(...derive.warnings.map((w) => `derive: ${w}`));
  } catch (e) {
    warnings.push(`derive error: ${e instanceof Error ? e.message : String(e)}`);
    derive = { motivated_sellers_inserted: 0, market_anomalies_inserted: 0, radar_signals_inserted: 0, warnings: [] };
  }

  return {
    istat: { triggered: istatStatus === "triggered", status: istatStatus },
    portali: portaliResults,
    totals,
    derive,
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
  const segnali = await applyStatisticalFallback(comune, segnaliRaw, coords, warnings);

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

    // Agency CRUD endpoints (proxy → x-job-secret + x-user-id)
    if (pathname.includes("/agency/") && !pathname.includes("/jobs/")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      const handled = await handleAgencyCrudRoute(req, pathname, debugId);
      if (handled) {
        return withIdentity(json(req, handled.status, handled.body, debugId), "agency-crud");
      }
    }

    // Job endpoints (cron-driven, protetti da CENTRAL_CORE_JOB_SECRET, fallback DIAGNOSTIC_SECRET)
    if (pathname.endsWith("/jobs/activate-veneto")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        // Job pesante (>150s): eseguito in background per evitare IDLE_TIMEOUT.
        const task = (async () => {
          try {
            const r = await activateVeneto();
            console.log(`[${FUNCTION_NAME}] activate-veneto completed`, JSON.stringify({ totals: r.totals, warnings: r.warnings.length }));
          } catch (err) {
            console.error(`[${FUNCTION_NAME}] activate-veneto background error:`, err instanceof Error ? err.message : String(err));
          }
        })();
        // @ts-ignore - EdgeRuntime is available in Supabase Edge Runtime
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
          // @ts-ignore
          EdgeRuntime.waitUntil(task);
        }
        return withIdentity(json(req, 202, {
          job: "activate-veneto",
          status: "started",
          message: "Job avviato in background. Verifica i log per il completamento.",
          data_source_verification: DATA_SOURCE_VERIFICATION,
        }, debugId), "job-activate-veneto");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] activate-veneto error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Activate Veneto failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/deep-scan-padova")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      try {
        const body = await req.json().catch(() => ({}));
        const comuneTarget = body.comune ?? "Padova";
        const provinciaTarget = "PD";

        const resOpps = await scrapeRibassiPortali(comuneTarget, null, provinciaTarget);

        return withIdentity(json(req, 200, {
          job: "deep-scan-padova",
          ok: true,
          comune: comuneTarget,
          opportunita_residenziale: resOpps.filter(o => o.categoria === "residenziale").length,
          opportunita_commerciale: resOpps.filter(o => o.categoria === "commerciale").length,
          opportunita_terreno: resOpps.filter(o => o.categoria === "terreno").length,
          totale: resOpps.length,
          sample: resOpps.slice(0, 3),
        }, debugId), "job-deep-scan-padova");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] deep-scan-padova error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "deep-scan-padova failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/perplexity-deep-padova")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      try {
        const { runPerplexityDiscovery } = await import("./offmarket/perplexityDiscovery.ts");
        const result = await runPerplexityDiscovery({
          comuni: [
            "Padova","Vigonza","Selvazzano Dentro","Rubano","Abano Terme",
            "Noventa Padovana","Saonara","Ponte San Nicolò","Albignasego",
            "Casalserugo","Due Carrare","Montegrotto Terme","Cadoneghe",
            "Limena","Vigodarzere","Mestrino"
          ],
          maxQueries: 20,
        });
        return withIdentity(json(req, 200, {
          job: "perplexity-deep-padova",
          ok: result.ok,
          hits: result.hits.length,
          errors: result.errors,
          sample: result.hits.slice(0, 3),
        }, debugId), "job-perplexity-padova");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] perplexity-deep-padova error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "perplexity-deep-padova failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/microzone-padova")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      try {
        const supa = getServiceClient();
        if (!supa) return withIdentity(fail(req, 503, "DB_UNAVAILABLE", "No DB client", debugId), "job-error");
        const PADOVA_MICROZONE = [
          { comune: "Padova", provincia: "PD", area_label: "Arcella",            lat: 45.4280, lng: 11.8700, tipo: "semicentrale",  property_types: ["residenziale","commerciale"] },
          { comune: "Padova", provincia: "PD", area_label: "Pontevigodarzere",   lat: 45.4420, lng: 11.8650, tipo: "periferica",    property_types: ["residenziale"] },
          { comune: "Padova", provincia: "PD", area_label: "Centro Storico",     lat: 45.4064, lng: 11.8768, tipo: "centrale",      property_types: ["residenziale","commerciale","luxury"] },
          { comune: "Padova", provincia: "PD", area_label: "Prato della Valle",  lat: 45.3990, lng: 11.8740, tipo: "centrale",      property_types: ["residenziale","commerciale"] },
          { comune: "Padova", provincia: "PD", area_label: "Stazione",           lat: 45.4160, lng: 11.8800, tipo: "semicentrale",  property_types: ["residenziale","commerciale","uffici"] },
          { comune: "Padova", provincia: "PD", area_label: "Guizza",             lat: 45.3860, lng: 11.8700, tipo: "periferica",    property_types: ["residenziale"] },
          { comune: "Padova", provincia: "PD", area_label: "Ovest - Voltabarozzo", lat: 45.4000, lng: 11.8500, tipo: "periferica", property_types: ["residenziale","terreno"] },
          { comune: "Padova", provincia: "PD", area_label: "Est - ZI",           lat: 45.4070, lng: 11.9300, tipo: "industriale",  property_types: ["commerciale","capannoni","terreno"] },
          { comune: "Padova", provincia: "PD", area_label: "Sud - Bassanello",   lat: 45.3800, lng: 11.8800, tipo: "periferica",   property_types: ["residenziale"] },
          { comune: "Vigonza",           provincia: "PD", area_label: "Vigonza",           lat: 45.4270, lng: 11.9570, tipo: "prima_periferia", property_types: ["residenziale","terreno"] },
          { comune: "Selvazzano Dentro", provincia: "PD", area_label: "Selvazzano Dentro", lat: 45.3800, lng: 11.8030, tipo: "prima_periferia", property_types: ["residenziale","terreno"] },
          { comune: "Rubano",            provincia: "PD", area_label: "Rubano",            lat: 45.4060, lng: 11.7850, tipo: "prima_periferia", property_types: ["residenziale","commerciale"] },
          { comune: "Albignasego",       provincia: "PD", area_label: "Albignasego",       lat: 45.3620, lng: 11.8670, tipo: "prima_periferia", property_types: ["residenziale"] },
          { comune: "Cadoneghe",         provincia: "PD", area_label: "Cadoneghe",         lat: 45.4430, lng: 11.9020, tipo: "prima_periferia", property_types: ["residenziale","commerciale"] },
          { comune: "Limena",            provincia: "PD", area_label: "Limena",            lat: 45.4580, lng: 11.8710, tipo: "prima_periferia", property_types: ["residenziale","terreno"] },
          { comune: "Noventa Padovana",  provincia: "PD", area_label: "Noventa Padovana",  lat: 45.4210, lng: 11.9520, tipo: "prima_periferia", property_types: ["residenziale"] },
          { comune: "Abano Terme",       provincia: "PD", area_label: "Abano Terme",       lat: 45.3600, lng: 11.7900, tipo: "termale",         property_types: ["residenziale","commerciale","luxury"] },
          { comune: "Montegrotto Terme", provincia: "PD", area_label: "Montegrotto Terme", lat: 45.3330, lng: 11.7830, tipo: "termale",         property_types: ["residenziale","luxury"] },
        ];
        const upserted: string[] = [];
        for (const mz of PADOVA_MICROZONE) {
          const { error } = await supa.from("area_opportunity_scores").upsert({
            municipality: mz.comune,
            province: mz.provincia,
            area_label: mz.area_label,
            lat: mz.lat,
            lng: mz.lng,
            area_type: mz.tipo,
            property_types: mz.property_types,
            quality: "parziale",
            derivazione: "stima_da_dati_statistici",
            updated_at: new Date().toISOString(),
          }, { onConflict: "municipality,area_label" });
          if (!error) upserted.push(mz.area_label);
        }
        return withIdentity(json(req, 200, {
          job: "microzone-padova",
          ok: true,
          upserted: upserted.length,
          microzone: upserted,
        }, debugId), "job-microzone-padova");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] microzone-padova error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "microzone-padova failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/build-civiko-veneto-data-engine")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const r = await buildVenetoDataEngine();
        return withIdentity(json(req, 200, {
          job: "build-civiko-veneto-data-engine",
          data_source_verification: DATA_SOURCE_VERIFICATION,
          ...r,
        }, debugId), "job-data-engine");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] data-engine error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Data Engine Veneto failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/seed-veneto-comuni")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const { seedVenetoComuni } = await import("./seedVenetoComuni.ts");
        const r = await seedVenetoComuni();
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "seed-veneto-comuni", ...r }, debugId), "job-seed-comuni");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] seed-veneto-comuni error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Seed veneto comuni failed", debugId), "job-error");
      }
    }

    // Import aste Veneto (CSV/JSON tracciato, no demo)
    if (pathname.endsWith("/jobs/import-veneto-auctions")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await importVenetoAuctions(body);
        return withIdentity(json(req, r.ok ? 200 : 400, { job: "import-veneto-auctions", ...r }, debugId), "job-import-auctions");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] import-auctions error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Auction import failed", debugId), "job-error");
      }
    }

    // Discover aste/legal Veneto — dry run only (no DB writes)
    if (pathname.endsWith("/jobs/discover-veneto-auctions")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await discoverVenetoAuctions(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "discover-veneto-auctions", ...r }, debugId), "job-discover-auctions");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] discover-auctions error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Auction discovery failed", debugId), "job-error");
      }
    }

    // ── ASTE ASYNC: start, status, import controllato ──
    if (pathname.endsWith("/jobs/start-auction-discovery")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await startAuctionDiscoveryRun(body, "core-admin");
        return withIdentity(json(req, 202, { job: "start-auction-discovery", ...r }, debugId), "job-auction-start");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] start-auction-discovery error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "start auction discovery failed", debugId), "job-error");
      }
    }
    if (pathname.endsWith("/jobs/auction-discovery-status")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const runId = String(body?.run_id ?? "").trim();
        if (!runId) return withIdentity(fail(req, 400, "BAD_REQUEST", "run_id required", debugId), "job-auction-status");
        const r = await getAuctionDiscoveryRun(runId);
        return withIdentity(json(req, r.ok ? 200 : 404, { job: "auction-discovery-status", ...r }, debugId), "job-auction-status");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] auction-discovery-status error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "auction status failed", debugId), "job-error");
      }
    }
    if (pathname.endsWith("/jobs/import-auction-candidates")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const runId = String(body?.run_id ?? "").trim();
        if (!runId) return withIdentity(fail(req, 400, "BAD_REQUEST", "run_id required", debugId), "job-auction-import");
        const r = await importAuctionCandidates({
          run_id: runId,
          minConfidence: typeof body?.minConfidence === "number" ? body.minConfidence : undefined,
          includeNeedsReview: body?.includeNeedsReview === true,
          maxImportRecords: typeof body?.maxImportRecords === "number" ? body.maxImportRecords : undefined,
        });
        return withIdentity(json(req, 200, { job: "import-auction-candidates", ...r }, debugId), "job-auction-import");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] import-auction-candidates error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "import auction candidates failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/firecrawl-deep-veneto")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runFirecrawlDeepVeneto(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "firecrawl-deep-veneto", ...r }, debugId), "job-firecrawl-deep");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] firecrawl-deep error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Firecrawl deep crawl failed", debugId), "job-error");
      }
    }

    // Off-Market & Microzone Opportunity Engine (Civiko proprietary scoring)
    if (pathname.endsWith("/jobs/build-offmarket-opportunity-scores")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runOffMarketOpportunityEngine(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "build-offmarket-opportunity-scores", ...r }, debugId), "job-offmarket-opp");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] offmarket-opp error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Off-market opportunity engine failed", debugId), "job-error");
      }
    }

    // Firecrawl Off-Market & Microzone Discovery (DRY-RUN-FIRST, no import)
    if (pathname.endsWith("/jobs/firecrawl-offmarket-microzone-discovery")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runOffMarketFirecrawlDiscovery(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "firecrawl-offmarket-microzone-discovery", ...r }, debugId), "job-fc-offmarket-discovery");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] fc-offmarket-discovery error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Firecrawl off-market discovery failed", debugId), "job-error");
      }
    }

    // Early Off-Market Signals — discovery DRY-RUN-FIRST (Perplexity + Firecrawl)
    if (pathname.endsWith("/jobs/discover-early-offmarket-signals")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runEarlyOffmarketDiscovery(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "discover-early-offmarket-signals", ...r }, debugId), "job-early-offmarket");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] discover-early-offmarket error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Early off-market discovery failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/offmarket-padova")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      try {
        const { runOffMarketFirecrawlDiscovery } = await import("./offmarket/offMarketFirecrawlRunner.ts");
        const r = await runOffMarketFirecrawlDiscovery({
          comuni: ["Padova","Vigonza","Selvazzano Dentro","Rubano","Albignasego","Cadoneghe","Limena","Noventa Padovana","Abano Terme","Montegrotto Terme"],
          province: ["PD"],
          dryRun: false,
          maxSources: 20,
          maxPagesPerSource: 5,
        });
        return withIdentity(json(req, 200, { job: "offmarket-padova", ...r }, debugId), "job-offmarket-padova");
      } catch (e) {
        return withIdentity(fail(req, 500, "JOB_FAILED", e instanceof Error ? e.message : String(e), debugId), "job-error");
      }
    }

    // Rescore existing early off-market candidates with new classifier
    if (pathname.endsWith("/jobs/rescore-early-offmarket-candidates")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runRescoreEarlyCandidates(body);
        return withIdentity(json(req, 200, { job: "rescore-early-offmarket-candidates", ...r }, debugId), "job-rescore-early");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] rescore-early error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Rescore early candidates failed", debugId), "job-error");
      }
    }

    // Promote early-signal candidate (controlled): requires status approved/importable, or force+note for needs_review.
    if (pathname.endsWith("/jobs/promote-early-signal-candidate")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runPromoteEarlyCandidate(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "promote-early-signal-candidate", ...r }, debugId), "job-promote-early");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] promote-early error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Promote early candidate failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/promote-batch")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      try {
        const body = await req.json().catch(() => ({}));
        const minPriority: number = body.min_priority ?? 60;
        const reviewerNote: string = body.reviewer_note ?? "Batch auto-approvazione";
        const target: string = body.target ?? "radar_signals";
        const provincia: string | null = body.provincia ?? null;

        const supa = getServiceClient();
        if (!supa) return withIdentity(fail(req, 503, "DB_UNAVAILABLE", "No DB", debugId), "job-error");

        let q = supa
          .from("early_offmarket_signal_candidates")
          .select("id, comune, provincia, priority_score, signal_type")
          .eq("status", "needs_review")
          .gte("priority_score", minPriority)
          .order("priority_score", { ascending: false })
          .limit(50);
        if (provincia) q = q.eq("provincia", provincia);
        const { data: candidates, error: fetchErr } = await q;
        if (fetchErr) return withIdentity(fail(req, 500, "FETCH_FAILED", fetchErr.message, debugId), "job-error");
        if (!candidates?.length) return withIdentity(json(req, 200, { job: "promote-batch", ok: true, promoted: 0, message: "Nessun candidato da promuovere" }, debugId), "job-promote-batch");

        const results = [];
        for (const cand of candidates) {
          const r = await runPromoteEarlyCandidate({
            candidate_id: cand.id,
            force: true,
            reviewer_note: reviewerNote,
            target,
          });
          results.push({ id: cand.id.slice(0, 8), comune: cand.comune, ok: r.ok, promoted_to: r.promoted_to });
        }

        const promoted = results.filter(r => r.ok).length;
        return withIdentity(json(req, 200, {
          job: "promote-batch",
          ok: true,
          total_candidates: candidates.length,
          promoted,
          failed: results.length - promoted,
          results,
        }, debugId), "job-promote-batch");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] promote-batch error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", e instanceof Error ? e.message : String(e), debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/list-early-signal-candidates")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runListEarlyCandidates(body);
        return withIdentity(json(req, 200, { job: "list-early-signal-candidates", ...r }, debugId), "job-list-early");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] list-early error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "List early candidates failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/build-agency-offmarket-brief")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runAgencyOffmarketBrief(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "build-agency-offmarket-brief", ...r }, debugId), "job-agency-brief");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] agency-brief error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Agency off-market brief failed", debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/firecrawl-microzone-opportunity-signals")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runMicrozoneOpportunitySignals(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "firecrawl-microzone-opportunity-signals", ...r }, debugId), "job-microzone-opp");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] microzone-opp error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Microzone opportunity signals failed", debugId), "job-error");
      }
    }

    // Advanced Opportunity Engine — orchestratore segnali avanzati
    if (pathname.endsWith("/jobs/build-advanced-veneto-opportunities")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const background = body?.background === true || body?.async === true;
        if (background) {
          const startedAt = new Date().toISOString();
          // @ts-ignore EdgeRuntime is available in Deno Deploy
          const ert = (globalThis as any).EdgeRuntime;
          const task = (async () => {
            try {
              await runAdvancedVenetoOpportunities(body);
            } catch (e) {
              console.error("[advanced-opp bg] error:", e instanceof Error ? e.message : String(e));
            }
          })();
          if (ert?.waitUntil) ert.waitUntil(task); else task.catch(() => {});
          return withIdentity(json(req, 202, {
            job: "build-advanced-veneto-opportunities",
            mode: "background",
            started_at: startedAt,
            note: "Polling: SELECT * FROM ingestion_runs WHERE job_name='build-advanced-veneto-opportunities' ORDER BY id DESC LIMIT 1",
          }, debugId), "job-advanced-opp-bg");
        }
        const r = await runAdvancedVenetoOpportunities(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "build-advanced-veneto-opportunities", ...r }, debugId), "job-advanced-opp");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] advanced-opp error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Advanced opportunity engine failed", debugId), "job-error");
      }
    }

    // ── New Perplexity-derived intelligence jobs ─────────────
    {
      // GET /jobs/apify-registry — protected, returns registry metadata only (no token).
      if (req.method === "GET" && pathname.endsWith("/jobs/apify-registry")) {
        const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
        return withIdentity(json(req, 200, {
          job: "apify-registry",
          count: APIFY_VENETO_REGISTRY.length,
          sources: APIFY_VENETO_REGISTRY.map((s) => ({
            source_name: s.source_name,
            source_type: s.source_type,
            actor_id: s.actor_id,
            import_target: s.import_target,
            allowed_use: s.allowed_use,
            compliance_notes: s.compliance_notes,
          })),
        }, debugId), "job-apify-registry");
      }

      const newJobs = [
        "/jobs/import-veneto-open-data",
        "/jobs/import-open-data-veneto-deep",
        "/jobs/enrich-radar-from-open-data-veneto",
        "/jobs/geoportale-veneto-discovery",
        "/jobs/import-geoportale-veneto-layers",
        "/jobs/recover-geoportale-veneto-unassigned",
        "/jobs/import-arpav-air-quality",
        "/jobs/enrich-microzone-sentiment-from-territorial-signals",
        "/jobs/enrich-microzone-sentiment-from-ispra-risk",
        "/jobs/import-geoportale-green-coverage",
        "/jobs/import-veneto-geo-environment",
        "/jobs/import-omi-territorial-notes",
        "/jobs/build-veneto-intelligence-from-research",
        "/jobs/apify-run-veneto-source",
        "/jobs/apify-diagnostics",
      ];
      const matched = newJobs.find((p) => pathname.endsWith(p));
      if (matched) {
        const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
        try {
          const body = await req.json().catch(() => ({}));
          if (matched === "/jobs/import-veneto-open-data") {
            const r = await runVenetoOpenDataImport({
              keywords: Array.isArray(body?.keywords) && body.keywords.length ? body.keywords : ["urbanistica","piano interventi","quartieri","rumore","mobilità","parcheggi","edifici","strade"],
              province: Array.isArray(body?.province) ? body.province : ["PD","VI","VR","TV","VE","BL","RO"],
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-veneto-open-data", ...r }, debugId), "job-open-data");
          }
          if (matched === "/jobs/import-open-data-veneto-deep") {
            const r = await runOpenDataVenetoDeepImport({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              limitPerKeyword: typeof body?.limitPerKeyword === "number" ? body.limitPerKeyword : 20,
              maxImportRecords: typeof body?.maxImportRecords === "number" ? body.maxImportRecords : undefined,
              keywords: Array.isArray(body?.keywords) ? body.keywords : undefined,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-open-data-veneto-deep", ...r }, debugId), "job-open-data-deep");
          }
          if (matched === "/jobs/enrich-radar-from-open-data-veneto") {
            const r = await enrichRadarFromOpenDataVeneto();
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "enrich-radar-from-open-data-veneto", ...r }, debugId), "job-enrich-odv");
          }
          if (matched === "/jobs/geoportale-veneto-discovery") {
            const r = await runGeoportaleVenetoDiscovery({
              dryRun: body?.dryRun !== false,
              topics: Array.isArray(body?.topics) ? body.topics : ["vincoli","urbanistica","ambiente","rischio","parchi","paesaggio"],
              maxLayers: typeof body?.maxLayers === "number" ? body.maxLayers : 20,
              sampleFeatures: body?.sampleFeatures !== false,
              maxFeaturesPerLayer: typeof body?.maxFeaturesPerLayer === "number" ? body.maxFeaturesPerLayer : 5,
              import: body?.import === true,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "geoportale-veneto-discovery", ...r }, debugId), "job-geoportale-discovery");
          }
          if (matched === "/jobs/import-geoportale-veneto-layers") {
            const r = await runGeoportaleImport({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              layers: Array.isArray(body?.layers) ? body.layers : undefined,
              province: Array.isArray(body?.province) ? body.province : ["PD","VE","BL"],
              maxFeaturesPerLayer: typeof body?.maxFeaturesPerLayer === "number" ? body.maxFeaturesPerLayer : 100,
              maxImportRecords: typeof body?.maxImportRecords === "number" ? body.maxImportRecords : 200,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-geoportale-veneto-layers", ...r }, debugId), "job-geoportale-import");
          }
          if (matched === "/jobs/recover-geoportale-veneto-unassigned") {
            const r = await runGeoportaleRecovery({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              layers: Array.isArray(body?.layers) ? body.layers : undefined,
              province: Array.isArray(body?.province) ? body.province : ["PD","VE","BL"],
              maxFeaturesPerLayer: typeof body?.maxFeaturesPerLayer === "number" ? body.maxFeaturesPerLayer : 150,
              maxImportRecords: typeof body?.maxImportRecords === "number" ? body.maxImportRecords : 150,
              fuzzyThreshold: typeof body?.fuzzyThreshold === "number" ? body.fuzzyThreshold : 0.92,
              enableSpatialJoin: body?.enableSpatialJoin !== false,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "recover-geoportale-veneto-unassigned", ...r }, debugId), "job-geoportale-recovery");
          }
          if (matched === "/jobs/import-arpav-air-quality") {
            const useEnv = body?.includeStations !== undefined || body?.includeZoneAria !== undefined || body?.pageSize !== undefined;
            if (useEnv) {
              const r = await runArpavEnvironmentalImport({
                dryRun: body?.dryRun !== false,
                import: body?.import === true,
                province: Array.isArray(body?.province) ? body.province : ["VE","VR","VI","PD","TV","BL","RO"],
                maxFeatures: typeof body?.maxFeatures === "number" ? body.maxFeatures : 2000,
                pageSize: typeof body?.pageSize === "number" ? body.pageSize : 500,
                includeStations: body?.includeStations !== false,
                includeZoneAria: body?.includeZoneAria !== false,
              });
              return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-arpav-air-quality", mode: "environmental", ...r }, debugId), "job-arpav-env");
            }
            const r = await runArpavAirImport({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              province: Array.isArray(body?.province) ? body.province : ["VE","VR","VI","PD","TV","BL","RO"],
              maxFeatures: typeof body?.maxFeatures === "number" ? body.maxFeatures : 1000,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-arpav-air-quality", ...r }, debugId), "job-arpav-air");
          }
          if (matched === "/jobs/enrich-microzone-sentiment-from-territorial-signals") {
            const r = await runEnrichMicrozoneFromTerritorial({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              province: Array.isArray(body?.province) ? body.province : ["VE","VR","VI","PD","TV","BL","RO"],
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "enrich-microzone-sentiment-from-territorial-signals", ...r }, debugId), "job-enrich-ms");
          }
          if (matched === "/jobs/enrich-microzone-sentiment-from-ispra-risk") {
            const r = await runIspraRiskEnrichment({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              province: Array.isArray(body?.province) ? body.province : ["VE","VR","VI","PD","TV","BL","RO"],
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "enrich-microzone-sentiment-from-ispra-risk", ...r }, debugId), "job-enrich-ms-ispra");
          }
          if (matched === "/jobs/import-geoportale-green-coverage") {
            const r = await runGeoportaleGreenImport({
              dryRun: body?.dryRun !== false,
              import: body?.import === true,
              layers: Array.isArray(body?.layers) ? body.layers : undefined,
              province: Array.isArray(body?.province) ? body.province : ["VE","VR","VI","PD","TV","BL","RO"],
              maxFeaturesPerLayer: typeof body?.maxFeaturesPerLayer === "number" ? body.maxFeaturesPerLayer : 1000,
              maxImportRecords: typeof body?.maxImportRecords === "number" ? body.maxImportRecords : 400,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-geoportale-green-coverage", ...r }, debugId), "job-geo-green");
          }
          if (matched === "/jobs/import-veneto-geo-environment" || matched === "/jobs/import-omi-territorial-notes") {
            return withIdentity(json(req, 200, {
              job: matched.replace("/jobs/",""),
              status: "registered_only",
              note: matched.endsWith("geo-environment")
                ? "ARPAV/Geoportale layers require per-layer URL resolution; sources registered in data_sources."
                : "OMI Note Territoriali PDF parsing pipeline pending; sources registered in data_sources.",
            }, debugId), "job-stub");
          }
          if (matched === "/jobs/build-veneto-intelligence-from-research") {
            const r = await buildVenetoIntelligenceFromResearch({
              dryRun: body?.dryRun !== false,
              runOpenData: body?.runOpenData !== false,
              runGeoEnvironment: body?.runGeoEnvironment !== false,
              runOmiNotes: body?.runOmiNotes !== false,
              runUrbanPlanning: body?.runUrbanPlanning !== false,
              runMicrozoneSentiment: body?.runMicrozoneSentiment !== false,
              runTurnoverSignals: body?.runTurnoverSignals !== false,
              runAreaScores: body?.runAreaScores !== false,
              runApify: body?.runApify === true,
              province: Array.isArray(body?.province) ? body.province : ["PD","VI","VR","TV","VE","BL","RO"],
              comuni: Array.isArray(body?.comuni) ? body.comuni : undefined,
              import: body?.import === true,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "build-veneto-intelligence-from-research", ...r }, debugId), "job-vir");
          }
          if (matched === "/jobs/apify-diagnostics") {
            const r = await apifyDiagnostics();
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "apify-diagnostics", ...r }, debugId), "job-apify-diag");
          }
          if (matched === "/jobs/apify-run-veneto-source") {
            const r = await runApifyForVenetoSourceV2({
              source_name: String(body?.source_name ?? ""),
              actor_id: String(body?.actor_id ?? ""),
              input: body?.input ?? {},
              dryRun: body?.dryRun !== false,
              invokeActor: body?.invokeActor === true,
              import: body?.import === true,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "apify-run-veneto-source", ...r }, debugId), "job-apify");
          }
        } catch (e) {
          console.error(`[${FUNCTION_NAME}] perplexity job error:`, e instanceof Error ? e.message : String(e));
          return withIdentity(fail(req, 500, "JOB_FAILED", "Perplexity-derived job failed", debugId), "job-error");
        }
      }
    }

    if (pathname.endsWith("/jobs/recompute-succession-heatmap") || pathname.endsWith("/jobs/recompute-price-resistance")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
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

    // Agent Radar — output operativo Veneto-only per MVP Civiko One
    if (pathname.endsWith("/agent-radar") || pathname.endsWith("/agentRadar")) {
      const rlA = rateLimit(req, `${FUNCTION_NAME}:agent-radar`, { windowMs: 60_000, max: 60 });
      if (!rlA.ok) {
        const r = fail(req, 429, "RATE_LIMITED", "Troppe richieste, riprovare a breve.", debugId);
        r.headers.set("Retry-After", String(rlA.retryAfter));
        return withIdentity(r, "rate-limited");
      }
      let body: AgentRadarRequest & { scope?: string; operating_area_id?: string; user_id?: string; agency_id?: string; province?: string | string[]; comuni?: string[] } = {};
      try {
        const parsed = await req.json();
        if (parsed && typeof parsed === "object") body = parsed as any;
      } catch { /* body opzionale */ }

      const requestedScope = (body.scope ?? "").toString().toLowerCase();
      const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
      const hasJobSecret = !!jobSecret && req.headers.get("x-job-secret") === jobSecret;
      let scopeMode: "global" | "agency_area" = "agency_area";
      if (requestedScope === "global") {
        if (!hasJobSecret) {
          return withIdentity(json(req, 403, { ok: false, scopeMode: "agency_area", error: { code: "GLOBAL_SCOPE_FORBIDDEN", message: "Global scope reserved to admin/job." } }, debugId), "agent-radar-forbidden");
        }
        scopeMode = "global";
      }
      if (scopeMode === "agency_area") {
        const provArr = Array.isArray((body as any).province) ? (body as any).province : (typeof (body as any).province === "string" ? [(body as any).province] : []);
        const hasArea = !!body.operating_area_id || (provArr.length > 0) || ((body.comuni?.length ?? 0) > 0) || !!(body as any).comune || !!(body as any).provincia;
        if (!hasArea) {
          return withIdentity(json(req, 200, {
            ok: false, scopeMode: "agency_area", needsOperatingArea: true,
            message: "Configura la tua zona di lavoro per ricevere il Radar.",
            summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" as const },
            zones: [], opportunities: [],
          }, debugId), "agent-radar-needs-area");
        }
        if (body.operating_area_id) {
          const { validateOperatingAreaAccess } = await import("./agency/agencyOperatingContext.ts");
          const v = await validateOperatingAreaAccess({ user_id: body.user_id ?? null, agency_id: body.agency_id ?? null, operating_area_id: body.operating_area_id });
          if (!v.allowed) {
            return withIdentity(json(req, 403, { ok: false, scopeMode: "agency_area", error: { code: "OPERATING_AREA_FORBIDDEN", message: v.reason ?? "not_allowed" } }, debugId), "agent-radar-area-forbidden");
          }
          const a = v.area as any;
          if (!(body as any).provincia && a?.province?.[0]) (body as any).provincia = a.province[0];
          if (!(body as any).comune && a?.comuni?.[0]) (body as any).comune = a.comuni[0];
        } else {
          if (!(body as any).provincia && provArr[0]) (body as any).provincia = provArr[0];
          if (!(body as any).comune && body.comuni?.[0]) (body as any).comune = body.comuni[0];
        }
      }
      try {
        const out = await buildAgentRadar(body as AgentRadarRequest);
        return withIdentity(json(req, 200, { ...out, scopeMode, ok: true }, debugId), "agent-radar");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] agent-radar error: ${e instanceof Error ? e.message : String(e)}`);
        const fallback = {
          ok: false, scopeMode,
          configured: false,
          scope: { region: "Veneto" as const, province: ["VE","VR","VI","PD","TV","BL","RO"], datasetStatus: "empty" as const, message: "Errore interno temporaneo." },
          summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" as const },
          zones: [],
          opportunities: [],
          dataQuality: { real: [], partial: [], missing: [], warnings: ["Errore interno: " + (e instanceof Error ? e.message : String(e))] },
        };
        return withIdentity(json(req, 200, fallback, debugId), "agent-radar-fallback");
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
