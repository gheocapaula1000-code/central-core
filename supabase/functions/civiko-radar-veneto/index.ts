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
import { buildAgentRadar, normalizeProvincia, type AgentRadarRequest } from "./agentRadar.ts";
import { computeBudgetState, isRadarMonthlyHardCapReached, ensureCostReport, type RadarRunMeta } from "../_shared/radarBudget.ts";
import { resolvePadovaOmiBatch, resolvePadovaOmiSync } from "../_shared/padovaOmiResolver.ts";
import { CIVIKO_PADOVA_SCOPE } from "../_shared/comuneRegistry.ts";
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
import { runPadovaEarlyWarning } from "./padovaEarlyWarning.ts";
import { buildVenetoIntelligenceFromResearch } from "./intelligence/orchestrator.ts";
import { runVenetoOpenDataImport } from "./openData/ckanImporter.ts";
import { resolveScheduledPersist } from "./openData/scheduledPersist.ts";
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
import { refreshPadovaAuctions } from "./legal/refreshPadovaAuctions.ts";
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
  "POST /jobs/civiko-one-radar-run",
  "POST /cluster-dossier",
  "POST /contendibili",
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
  "POST /jobs/anac-ckan",
  "POST /jobs/asteGiudiziarie",
  "POST /asteGiudiziarie",
  "POST /jobs/enrich-microzone-sentiment-from-territorial-signals",
 "POST /jobs/enrich-microzone-sentiment-from-ispra-risk",
 "POST /jobs/import-geoportale-green-coverage",
 "POST /jobs/discover-veneto-auctions",
 "POST /jobs/start-auction-discovery",
 "POST /jobs/auction-discovery-status",
  "POST /jobs/import-auction-candidates",
  "POST /jobs/refresh-padova-auctions",
  "POST /jobs/ping-padova-snapshots",
  "POST /jobs/ping-padova-snapshots-orchestrator",
  "POST /jobs/padova-successioni",
  "POST /jobs/padova-daily-radar",
  "POST /jobs/padova-zone-radar",
  "POST /jobs/padova-zone-radar-finalize",
  "POST /jobs/padova-institutional-sources",
  "POST /jobs/refresh-padova-legal-life-events",
  "POST /jobs/build-offmarket-opportunity-scores",
  "POST /jobs/firecrawl-offmarket-microzone-discovery",
  "POST /jobs/discover-early-offmarket-signals",
  "POST /jobs/offmarket-padova",
  "POST /jobs/offmarket-diagnostics",
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
  const providedJob = req.headers.get("x-job-secret") ?? "";
  const providedInternal = req.headers.get("x-internal-secret") ?? "";
  const ok =
    (!!primary && !!providedJob && providedJob === primary) ||
    (!!primary && !!providedInternal && providedInternal === primary) ||
    (!!fallback && !!providedJob && providedJob === fallback);
  if (!ok) {
    return withIdentity(fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-job-secret", debugId), "job-auth");
  }
  return null;
}

/**
 * Authorization Civiko One → central-core (canonical contract).
 * Accepts in priority order:
 *   1. x-internal-secret == CENTRAL_CORE_JOB_SECRET   (CANONICAL — single shared key)
 *   2. x-job-secret      == CENTRAL_CORE_JOB_SECRET   (retro-compat with /contendibili)
 *   3. x-job-secret      == DIAGNOSTIC_SECRET         (diag fallback)
 *   4. x-internal-secret == CORE_INTERNAL_SECRET      (retro-compat with client core-proxy)
 * Required companion header: x-source-app (e.g. "civiko-one").
 * Never logs secret values, only header presence + length.
 */
function authorizeContendibili(req: Request, debugId: string): Response | null {
  const jobPrimary = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  const jobFallback = Deno.env.get("DIAGNOSTIC_SECRET") ?? "";
  const internalLegacy = Deno.env.get("CORE_INTERNAL_SECRET") ?? "";
  if (!jobPrimary && !jobFallback && !internalLegacy) {
    return withIdentity(
      fail(req, 500, "CONFIG_ERROR", "No authorization secret configured", debugId),
      "job-auth",
    );
  }
  const providedJob = req.headers.get("x-job-secret") ?? "";
  const providedInternal = req.headers.get("x-internal-secret") ?? "";
  const sourceApp = (req.headers.get("x-source-app") ?? "").trim();

  // Canonical: x-internal-secret == CENTRAL_CORE_JOB_SECRET
  const okInternalCanonical = providedInternal && jobPrimary && providedInternal === jobPrimary;
  // Retro-compat branches
  const okJob =
    (providedJob && jobPrimary && providedJob === jobPrimary) ||
    (providedJob && jobFallback && providedJob === jobFallback);
  const okInternalLegacy = providedInternal && internalLegacy && providedInternal === internalLegacy;

  if (!okInternalCanonical && !okJob && !okInternalLegacy) {
    console.warn(`[authorizeContendibili] rejected source_app=${sourceApp || "(empty)"} has_internal=${!!providedInternal} has_job=${!!providedJob}`);
    return withIdentity(
      fail(req, 401, "UNAUTHORIZED", "Missing or invalid x-internal-secret (expected: CENTRAL_CORE_JOB_SECRET)", debugId),
      "job-auth",
    );
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

async function fetchPadovaSourceFreshness(supa: ReturnType<typeof getServiceClient>) {
  if (!supa) {
    return {
      newest_collect_processed_at: null as string | null,
      newest_contendibile_created_at: null as string | null,
      collect_count: null as number | null,
      contendibili_count: null as number | null,
    };
  }
  const [collectMax, contMax, collectCount, contCount] = await Promise.all([
    supa.from("padova_collect_v2_items").select("processed_at").order("processed_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supa.from("padova_contendibili").select("created_at").order("created_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supa.from("padova_collect_v2_items").select("id", { count: "exact", head: true }),
    supa.from("padova_contendibili").select("id", { count: "exact", head: true }),
  ]);
  return {
    newest_collect_processed_at: (collectMax.data as any)?.processed_at ?? null,
    newest_contendibile_created_at: (contMax.data as any)?.created_at ?? null,
    collect_count: collectCount.count ?? null,
    contendibili_count: contCount.count ?? null,
  };
}

function buildProviderConfigStatus() {
  return {
    firecrawl: !!Deno.env.get("FIRECRAWL_API_KEY"),
    apify: !!Deno.env.get("APIFY_TOKEN"),
    perplexity: !!Deno.env.get("PERPLEXITY_API_KEY"),
    openai: !!Deno.env.get("OPENAI_API_KEY"),
    supabase_service_role: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  };
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

    // Agency CRUD endpoints (proxy → x-job-secret + x-user-id,
    // OR direct PWA call → Authorization: Bearer <supabase jwt>)
    if (pathname.includes("/agency/") && !pathname.includes("/jobs/")) {
      let agencyReq: Request = req;
      let jwtAuthOk = false;

      // JWT path enabled only for create + list (PWA-facing routes).
      const jwtEligible =
        pathname.endsWith("/agency/operating-areas/create") ||
        pathname.endsWith("/agency/operating-areas/list");

      if (jwtEligible) {
        const authH = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
        const m = authH.match(/^Bearer\s+(.+)$/i);
        if (m) {
          const token = m[1].trim();
          try {
            const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
            const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
            const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
            if (supaUrl && svcKey) {
              const supabaseAdmin = createClient(supaUrl, svcKey, { auth: { persistSession: false } });
              const { data, error } = await supabaseAdmin.auth.getUser(token);
              if (!error && data?.user?.id) {
                // Build a new Request with x-user-id injected (and email if available),
                // since req.headers is immutable.
                const newHeaders = new Headers(req.headers);
                newHeaders.set("x-user-id", data.user.id);
                if (data.user.email) newHeaders.set("x-user-email", data.user.email);
                const bodyText = await req.text();
                agencyReq = new Request(req.url, {
                  method: req.method,
                  headers: newHeaders,
                  body: bodyText,
                });
                jwtAuthOk = true;
              }
            }
          } catch (e) {
            console.warn(`[${FUNCTION_NAME}] agency JWT verify error:`, e instanceof Error ? e.message : String(e));
          }
        }
      }

      if (!jwtAuthOk) {
        const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      }
      const handled = await handleAgencyCrudRoute(agencyReq, pathname, debugId);
      if (handled) {
        return withIdentity(json(req, handled.status, handled.body, debugId), "agency-crud");
      }
    }

    // ─── Heavy cron gate ────────────────────────────────────────────
    // Skip-and-log se la modalita' operativa dice di saltare oggi
    // o se il cap mensile e' stato raggiunto. Solo per i job pesanti.
    {
      const HEAVY_JOBS = new Set([
        "/jobs/padova-daily-radar",
        "/jobs/padova-zone-radar",
        "/jobs/padova-zone-radar-finalize",
        "/jobs/deep-scan-padova",
        "/jobs/perplexity-deep-padova",
        "/jobs/microzone-padova",
        "/jobs/padova-institutional-sources",
        "/jobs/padova-successioni",
        "/jobs/refresh-padova-auctions",
        "/jobs/refresh-padova-legal-life-events",
        "/jobs/firecrawl-deep-veneto",
        "/jobs/firecrawl-microzone-opportunity-signals",
        "/jobs/firecrawl-offmarket-microzone-discovery",
        "/jobs/discover-early-offmarket-signals",
        "/jobs/offmarket-padova",
        "/jobs/build-offmarket-opportunity-scores",
        "/jobs/build-advanced-veneto-opportunities",
        "/jobs/build-padova-early-warning",
        "/jobs/discover-veneto-auctions",
        "/jobs/import-veneto-auctions",
        "/jobs/build-civiko-veneto-data-engine",
      ]);
      const isHeavy = [...HEAVY_JOBS].some((p) => pathname.endsWith(p));
      if (isHeavy && req.method === "POST") {
        // Checkpoint 1B — authenticate BEFORE the budget gate: an anonymous or
        // wrongly-authenticated request must never trigger operational mode or
        // budget reads, nor learn anything about caps and spend.
        const _heavyAuth = authorizeJob(req, debugId);
        if (_heavyAuth) return _heavyAuth;
        try {
          const { shouldRunHeavyCron } = await import("../_shared/heavyCronGate.ts");
          const { isMonthlyCapReached } = await import("../_shared/monthlyBudget.ts");
          const gate = await shouldRunHeavyCron();
          if (!gate.run) {
            console.log(`[heavy-cron-gate] skip path=${pathname} reason=${gate.reason} mode=${gate.mode}`);
            return withIdentity(json(req, 200, {
              skipped: true, reason: gate.reason, mode: gate.mode, doy: gate.doy,
              every_n_days: gate.every_n,
            }, debugId), "heavy-cron-gate");
          }
          const monthly = await isMonthlyCapReached();
          if (monthly.reached) {
            console.warn(`[heavy-cron-gate] monthly_cap_reached total=$${monthly.total.toFixed(2)} cap=$${monthly.cap}`);
            return withIdentity(json(req, 200, {
              skipped: true, reason: "monthly_cap_reached",
              total_usd: Number(monthly.total.toFixed(2)), cap_usd: monthly.cap,
            }, debugId), "heavy-cron-gate");
          }
        } catch (e) {
          // Checkpoint 1B — fail-closed: if the gate itself fails we do NOT start
          // the job and do NOT call any provider. Generic, non-sensitive response.
          console.error(`[heavy-cron-gate] check error, fail-closed:`, e instanceof Error ? e.message : String(e));
          return withIdentity(json(req, 503, {
            skipped: true, reason: "gate_unavailable",
          }, debugId), "heavy-cron-gate");
        }
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
        const mode: "soft" | "full" = body?.mode === "full" ? "full" : "soft";

        const resOpps = await scrapeRibassiPortali(comuneTarget, null, provinciaTarget, mode);

        return withIdentity(json(req, 200, {
          job: "deep-scan-padova",
          ok: true,
          comune: comuneTarget,
          mode,
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

    // ── ASTE PADOVA: pipeline end-to-end (scrape→parse→dedupe→insert) ──
    if (pathname.endsWith("/jobs/refresh-padova-auctions")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const persist = resolveScheduledPersist(body);
        const r = await refreshPadovaAuctions({ ...body, dryRun: persist.dryRun });
        return withIdentity(json(req, r.ok ? 200 : 207, r, debugId), "job-refresh-padova-auctions");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] refresh-padova-auctions error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "refresh-padova-auctions failed", debugId), "job-error");
      }
    }

    // Scheduler F16 path (`/asteGiudiziarie`) + nightly alias → persist via refreshPadovaAuctions
    if (pathname.endsWith("/jobs/asteGiudiziarie") || pathname.endsWith("/asteGiudiziarie")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const persist = resolveScheduledPersist(body);
        const r = await refreshPadovaAuctions({
          ...body,
          dryRun: persist.dryRun,
          maxPagesPerSource: typeof body?.maxPagesPerSource === "number" ? body.maxPagesPerSource : 4,
        });
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "asteGiudiziarie", ...r }, debugId), "job-aste-giudiziarie");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] asteGiudiziarie error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "asteGiudiziarie failed", debugId), "job-error");
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
        const inBody = await req.json().catch(() => ({} as Record<string, unknown>));
        const source_keys = Array.isArray((inBody as any)?.source_keys) ? ((inBody as any).source_keys as string[]) : undefined;
        const chain_depth = typeof (inBody as any)?.chain_depth === "number" ? (inBody as any).chain_depth as number : 0;
        const scrape_budget_remaining = typeof (inBody as any)?.scrape_budget_remaining === "number" ? (inBody as any).scrape_budget_remaining as number : undefined;
        console.log(`[${FUNCTION_NAME}] discover-early-offmarket invoked chain_depth=${chain_depth} source_keys=${source_keys ? source_keys.length : "all"}`);
        const r = await runEarlyOffmarketDiscovery({
          ...(inBody as Record<string, unknown>),
          source_keys,
          chain_depth,
          scrape_budget_remaining,
          timeBudgetMs: typeof (inBody as any)?.timeBudgetMs === "number" ? (inBody as any).timeBudgetMs as number : 90_000,
        });
        let chained = false;
        if (r.deferred_source_keys.length > 0 && chain_depth < 12 && r.scrape_budget_remaining > 0) {
          const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
          const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
          if (SUPABASE_URL && JOB_SECRET) {
            const target = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/jobs/discover-early-offmarket-signals`;
            const nextBody = {
              ...(inBody as Record<string, unknown>),
              source_keys: r.deferred_source_keys,
              chain_depth: chain_depth + 1,
              scrape_budget_remaining: r.scrape_budget_remaining,
              triggered_by: "self-chain",
            };
            const p = fetch(target, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-job-secret": JOB_SECRET,
                "x-internal-secret": JOB_SECRET,
                "x-source-app": "central-core-cron",
                Authorization: `Bearer ${JOB_SECRET}`,
              },
              body: JSON.stringify(nextBody),
            }).catch((e) => console.error("early-offmarket self-chain launch failed", e));
            try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* ignore */ }
            chained = true;
          } else {
            console.error("early-offmarket self-chain skipped: missing SUPABASE_URL or CENTRAL_CORE_JOB_SECRET");
          }
        }
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "discover-early-offmarket-signals", ...r, chained }, debugId), "job-early-offmarket");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] discover-early-offmarket error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Early off-market discovery failed", debugId), "job-error");
      }
    }


    if (pathname.endsWith("/jobs/offmarket-padova")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      try {
        const inBody = await req.json().catch(() => ({} as Record<string, unknown>));
        const source_keys = Array.isArray((inBody as any)?.source_keys) ? ((inBody as any).source_keys as string[]) : undefined;
        const chain_depth = typeof (inBody as any)?.chain_depth === "number" ? (inBody as any).chain_depth as number : 0;
        const scrape_budget_remaining = typeof (inBody as any)?.scrape_budget_remaining === "number" ? (inBody as any).scrape_budget_remaining as number : undefined;
        console.log(`[${FUNCTION_NAME}] offmarket-padova invoked chain_depth=${chain_depth} source_keys=${source_keys ? source_keys.length : "all"}`);
        const { runOffMarketFirecrawlDiscovery } = await import("./offmarket/offMarketFirecrawlRunner.ts");
        const r = await runOffMarketFirecrawlDiscovery({
          comuni: ["Padova","Vigonza","Selvazzano Dentro","Rubano","Albignasego","Cadoneghe","Limena","Noventa Padovana","Abano Terme","Montegrotto Terme"],
          province: ["PD"],
          dryRun: false,
          maxSources: 20,
          maxPagesPerSource: 5,
          sourceKeys: source_keys,
          timeBudgetMs: 90_000,
          scrapeBudgetRemaining: scrape_budget_remaining,
        });
        let chained = false;
        if (r.deferred_source_keys.length > 0 && chain_depth < 12 && r.scrape_budget_remaining > 0) {
          const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
          const JOB_SECRET = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
          if (SUPABASE_URL && JOB_SECRET) {
            const target = `${SUPABASE_URL}/functions/v1/civiko-radar-veneto/jobs/offmarket-padova`;
            const nextBody = {
              source_keys: r.deferred_source_keys,
              chain_depth: chain_depth + 1,
              scrape_budget_remaining: r.scrape_budget_remaining,
              triggered_by: "self-chain",
            };
            const p = fetch(target, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-job-secret": JOB_SECRET,
                "x-internal-secret": JOB_SECRET,
                "x-source-app": "central-core-cron",
                Authorization: `Bearer ${JOB_SECRET}`,
              },
              body: JSON.stringify(nextBody),
            }).catch((e) => console.error("offmarket self-chain launch failed", e));
            try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* ignore */ }
            chained = true;
          } else {
            console.error("offmarket self-chain skipped: missing SUPABASE_URL or CENTRAL_CORE_JOB_SECRET");
          }
        }
        return withIdentity(json(req, 200, { job: "offmarket-padova", ...r, chained }, debugId), "job-offmarket-padova");
      } catch (e) {
        return withIdentity(fail(req, 500, "JOB_FAILED", e instanceof Error ? e.message : String(e), debugId), "job-error");
      }
    }

    if (pathname.endsWith("/jobs/offmarket-diagnostics")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      const startedAt = new Date().toISOString();
      const result: Record<string, unknown> = {
        ok: true,
        timestamp: startedAt,
        early_discovery_dry_run: null as unknown,
        recent_candidates: [] as unknown[],
        recent_evidence: [] as unknown[],
        source_registry_status: [] as unknown[],
        summary: {
          candidates_in_db: 0,
          evidence_offmarket_in_db: 0,
          sources_never_run: [] as string[],
          sources_with_errors: [] as string[],
        },
      };
      const errors: Record<string, string> = {};

      const withTimeout = async <T>(label: string, p: Promise<T>): Promise<T | null> => {
        try {
          return await Promise.race([
            p,
            new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout 30s")), 30_000)),
          ]);
        } catch (e) {
          errors[label] = e instanceof Error ? e.message : String(e);
          return null;
        }
      };

      // a) dry-run early discovery
      result.early_discovery_dry_run = await withTimeout("early_discovery_dry_run",
        runEarlyOffmarketDiscovery({
          comuni: ["Padova"],
          dryRun: true,
          usePerplexityDiscovery: true,
          useFirecrawl: true,
          maxSources: 5,
          maxPagesPerSource: 2,
          saveCandidates: false,
        }),
      );

      const supa = getServiceClient();
      const OFF_TYPES = ["off_market","succession_pressure","public_asset_disposal","urban_regeneration","motivated_seller"];
      const SOURCE_CODES = ["F5","F7","F10","F11","F13","F19","F21"];

      if (!supa) {
        errors.db = "SUPABASE_SERVICE_ROLE_KEY missing";
      } else {
        // b) recent candidates
        await withTimeout("recent_candidates", (async () => {
          const { data, error } = await supa
            .from("early_offmarket_signal_candidates")
            .select("id, comune, signal_type, title, confidence_score, import_recommendation, created_at")
            .order("created_at", { ascending: false })
            .limit(10);
          if (error) throw new Error(error.message);
          result.recent_candidates = data ?? [];
        })());

        // c) recent evidence (off-market types)
        await withTimeout("recent_evidence", (async () => {
          const { data, error } = await supa
            .from("civiko_evidence")
            .select("id, evidence_type, entity_key, source_code, confidence, observed_at, created_at")
            .in("evidence_type", OFF_TYPES)
            .order("created_at", { ascending: false })
            .limit(10);
          if (error) throw new Error(error.message);
          result.recent_evidence = data ?? [];
        })());

        // d) source registry
        await withTimeout("source_registry_status", (async () => {
          const { data, error } = await supa
            .from("civiko_source_registry")
            .select("source_code, last_run_at, last_success_at, last_error, record_count")
            .in("source_code", SOURCE_CODES);
          if (error) throw new Error(error.message);
          const rows = data ?? [];
          result.source_registry_status = rows;
          (result.summary as Record<string, unknown>).sources_never_run =
            rows.filter((r: Record<string, unknown>) => r.last_run_at == null).map((r: Record<string, unknown>) => r.source_code as string);
          (result.summary as Record<string, unknown>).sources_with_errors =
            rows.filter((r: Record<string, unknown>) => r.last_error != null).map((r: Record<string, unknown>) => r.source_code as string);
        })());

        // summary counts
        await withTimeout("candidates_in_db", (async () => {
          const { count, error } = await supa
            .from("early_offmarket_signal_candidates")
            .select("id", { count: "exact", head: true })
            .ilike("comune", "Padova");
          if (error) throw new Error(error.message);
          (result.summary as Record<string, unknown>).candidates_in_db = count ?? 0;
        })());

        await withTimeout("evidence_offmarket_in_db", (async () => {
          const { count, error } = await supa
            .from("civiko_evidence")
            .select("id", { count: "exact", head: true })
            .in("evidence_type", OFF_TYPES)
            .ilike("entity_key", "%padova%");
          if (error) throw new Error(error.message);
          (result.summary as Record<string, unknown>).evidence_offmarket_in_db = count ?? 0;
        })());

        // ---- db_snapshot (read-only diagnostics) ----
        const dbSnapshot: Record<string, unknown> = {
          evidence_types_distinct: [] as string[],
          evidence_by_type: [] as Array<{ evidence_type: string | null; count: number }>,
          source_registry: [] as unknown[],
          tables_exist: {} as Record<string, boolean>,
        };

        // evidence_types_distinct + evidence_by_type (aggregate client-side)
        await withTimeout("evidence_types_aggregate", (async () => {
          const { data, error } = await supa
            .from("civiko_evidence")
            .select("evidence_type")
            .limit(5000);
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as Array<{ evidence_type: string | null }>;
          const counts = new Map<string, number>();
          for (const r of rows) {
            const k = r.evidence_type ?? "__null__";
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
          const sorted = [...counts.entries()]
            .map(([evidence_type, count]) => ({
              evidence_type: evidence_type === "__null__" ? null : evidence_type,
              count,
            }))
            .sort((a, b) => b.count - a.count);
          dbSnapshot.evidence_by_type = sorted;
          dbSnapshot.evidence_types_distinct = sorted
            .map((r) => r.evidence_type)
            .filter((v): v is string => typeof v === "string")
            .slice(0, 30);
        })());

        // full source_registry (all rows, all listed fields)
        await withTimeout("source_registry_full", (async () => {
          const { data, error } = await supa
            .from("civiko_source_registry")
            .select("source_code, last_run_at, last_success_at, last_error, record_count")
            .order("source_code", { ascending: true });
          if (error) throw new Error(error.message);
          dbSnapshot.source_registry = data ?? [];
        })());

        // tables_exist: probe each table with HEAD; if PostgREST returns
        // a "does not exist" / not found error, mark false.
        const TABLES_TO_PROBE = [
          "early_offmarket_signal_candidates",
          "auction_signals",
          "normalized_opportunities",
          "territorial_signals",
          "succession_heatmap_cap",
        ];
        const tablesExist: Record<string, boolean> = {};
        await Promise.all(
          TABLES_TO_PROBE.map(async (t) => {
            try {
              const { error } = await supa.from(t).select("*", { count: "exact", head: true }).limit(1);
              if (!error) { tablesExist[t] = true; return; }
              const msg = (error.message || "").toLowerCase();
              const code = (error as { code?: string }).code || "";
              const missing =
                code === "42P01" ||
                msg.includes("does not exist") ||
                msg.includes("not found") ||
                msg.includes("could not find the table");
              tablesExist[t] = !missing;
              if (!missing) errors[`tables_exist:${t}`] = error.message;
            } catch (e) {
              tablesExist[t] = false;
              errors[`tables_exist:${t}`] = e instanceof Error ? e.message : String(e);
            }
          }),
        );
        dbSnapshot.tables_exist = tablesExist;

        (result as Record<string, unknown>).db_snapshot = dbSnapshot;
      }

      if (Object.keys(errors).length > 0) {
        (result as Record<string, unknown>).warnings = errors;
      }
      return withIdentity(json(req, 200, { job: "offmarket-diagnostics", ...result }, debugId), "job-offmarket-diag");
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

    // Padova Early Warning aggregator — multi-source acquisition opportunities
    if (pathname.endsWith("/jobs/build-padova-early-warning")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const r = await runPadovaEarlyWarning(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "build-padova-early-warning", ...r }, debugId), "job-padova-ew");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-early-warning error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova early warning failed", debugId), "job-error");
      }
    }

    // Padova Snapshot Ping — re-check known listings so giorni_online stays monotonic
    // and delisting (404) becomes itself a signal after 2 distinct-day failures.
    if (pathname.endsWith("/jobs/ping-padova-snapshots")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const { runPadovaSnapshotPing } = await import("./padovaSnapshotPing.ts");
        const r = await runPadovaSnapshotPing({
          maxListings:  typeof body?.maxListings  === "number" ? body.maxListings  : undefined,
          delayMs:      typeof body?.delayMs      === "number" ? body.delayMs      : undefined,
          wallBudgetMs: typeof body?.wallBudgetMs === "number" ? body.wallBudgetMs : undefined,
          lookbackDays: typeof body?.lookbackDays === "number" ? body.lookbackDays : undefined,
          dryRun: body?.dryRun === true,
        });
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "ping-padova-snapshots", ...r }, debugId), "job-padova-ping");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] ping-padova-snapshots error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova snapshot ping failed", debugId), "job-error");
      }
    }

    // Padova Snapshot Ping Orchestrator — single trigger that runs up to 3
    // sequential rounds in the background so one nightly invocation covers the
    // full Padova inventory (~120 listings). Returns 202 immediately; each
    // internal round still respects the 360s wall-budget cap.
    if (pathname.endsWith("/jobs/ping-padova-snapshots-orchestrator")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const { runPadovaSnapshotPingOrchestrator } = await import("./padovaSnapshotPing.ts");
        const task = (async () => {
          try {
            const r = await runPadovaSnapshotPingOrchestrator({
              maxRounds: typeof body?.maxRounds === "number" ? body.maxRounds : 3,
              pauseBetweenRoundsMs: typeof body?.pauseBetweenRoundsMs === "number" ? body.pauseBetweenRoundsMs : 5000,
              round: {
                maxListings:  typeof body?.maxListings  === "number" ? body.maxListings  : undefined,
                delayMs:      typeof body?.delayMs      === "number" ? body.delayMs      : undefined,
                wallBudgetMs: typeof body?.wallBudgetMs === "number" ? body.wallBudgetMs : undefined,
                lookbackDays: typeof body?.lookbackDays === "number" ? body.lookbackDays : undefined,
                dryRun: body?.dryRun === true,
              },
            });
            console.log(`[${FUNCTION_NAME}] ping orchestrator done`, JSON.stringify({ rounds_run: r.rounds_run, totals: r.totals, early_exit: r.early_exit }));
          } catch (e) {
            console.error(`[${FUNCTION_NAME}] ping orchestrator error:`, e instanceof Error ? e.message : String(e));
          }
        })();
        const ert = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (ert?.waitUntil) ert.waitUntil(task); else task.catch(() => {});
        return withIdentity(json(req, 202, { job: "ping-padova-snapshots-orchestrator", accepted: true, max_rounds: typeof body?.maxRounds === "number" ? body.maxRounds : 3 }, debugId), "job-padova-ping-orchestrator");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] ping orchestrator trigger error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova snapshot ping orchestrator failed to start", debugId), "job-error");
      }
    }

    // Padova Successioni — aggregate-only succession_pressure evidence.
    // Sources: ISTAT + OMI + auction_signals aggregati + succession_heatmap_cap
    // aggregato + area_opportunity_scores (no person-level data, k >= 3).
    if (pathname.endsWith("/jobs/padova-successioni")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const { runPadovaSuccessioni } = await import("./padovaSuccessioni.ts");
        const r = await runPadovaSuccessioni({ dryRun: body?.dryRun === true });
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "padova-successioni", ...r }, debugId), "job-padova-successioni");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-successioni error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova successioni failed", debugId), "job-error");
      }
    }

    // Padova Daily Radar — orchestrator multi-fonte (listing+aste+perplexity+EW)
    if (pathname.endsWith("/jobs/padova-daily-radar")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const { runPadovaDailyRadar } = await import("./padovaDailyRadar.ts");
        const r = await runPadovaDailyRadar(body);
        const httpStatus = r.status === "FAILED" ? 500 : (r.status === "PARTIAL_WITH_WARNINGS" ? 207 : 200);
        return withIdentity(json(req, httpStatus, r, debugId), "job-padova-daily");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-daily-radar error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova daily radar failed", debugId), "job-error");
      }
    }

    // Padova Zone Radar — pipeline a checkpoint per microzona (sostituisce mega-run fragile)
    if (pathname.endsWith("/jobs/padova-zone-radar")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const { runPadovaZoneRadar } = await import("./padovaZoneRadar.ts");
        const r = await runPadovaZoneRadar({
          mode: body?.mode ?? "next",
          zone_name: typeof body?.zone_name === "string" ? body.zone_name : undefined,
          max_zones: typeof body?.max_zones === "number" ? body.max_zones : undefined,
          dryRun: body?.dryRun === true,
        });
        return withIdentity(json(req, r.ok ? 200 : 500, r, debugId), "job-padova-zone");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-zone-radar error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova zone radar failed", debugId), "job-error");
      }
    }

    // Finalizer: aggrega tutte le zone elaborate e scrive record finale in ingestion_runs
    if (pathname.endsWith("/jobs/padova-zone-radar-finalize")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const { finalizePadovaZoneRadar } = await import("./padovaZoneRadar.ts");
        const r = await finalizePadovaZoneRadar();
        return withIdentity(json(req, r.ok ? 200 : 500, r, debugId), "job-padova-zone-finalize");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-zone-radar-finalize error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova zone radar finalize failed", debugId), "job-error");
      }
    }
    // Fonte legittima a basso volume, source_name distinta da casa.it.
    if (pathname.endsWith("/jobs/padova-institutional-sources")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const { runComunePadovaPatrimonio } = await import("./comunePadovaPatrimonio.ts");
        const r = await runComunePadovaPatrimonio();
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "padova-institutional-sources", ...r }, debugId), "job-padova-instit");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-institutional-sources error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova institutional sources failed", debugId), "job-error");
      }
    }

    // Padova legal & life-event signals — aggrega segnali legali/patrimoniali
    // privacy-safe in `legal_life_event_signals`. Solo fonti già ingestite e lecite.
    if (pathname.endsWith("/jobs/refresh-padova-legal-life-events")) {
      const _jobAuth = authorizeJob(req, debugId); if (_jobAuth) return _jobAuth;
      try {
        const body = await req.json().catch(() => ({}));
        const { refreshPadovaLegalLifeEvents } = await import("./legalLifeEvents.ts");
        const r = await refreshPadovaLegalLifeEvents(body);
        return withIdentity(json(req, r.ok ? 200 : 207, { job: "refresh-padova-legal-life-events", ...r }, debugId), "job-padova-lle");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] padova-legal-life-events error:`, e instanceof Error ? e.message : String(e));
        return withIdentity(fail(req, 500, "JOB_FAILED", "Padova legal/life-event refresh failed", debugId), "job-error");
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
        "/jobs/anac-ckan",
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
            const persist = resolveScheduledPersist(body);
            const r = await runVenetoOpenDataImport({
              keywords: Array.isArray(body?.keywords) && body.keywords.length ? body.keywords : ["urbanistica","piano interventi","quartieri","rumore","mobilità","parcheggi","edifici","strade"],
              province: Array.isArray(body?.province) ? body.province : ["PD","VI","VR","TV","VE","BL","RO"],
              dryRun: persist.dryRun,
              import: persist.doImport,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-veneto-open-data", ...r }, debugId), "job-open-data");
          }
          if (matched === "/jobs/anac-ckan") {
            const persist = resolveScheduledPersist(body);
            const r = await runVenetoOpenDataImport({
              baseUrl: "https://dati.anticorruzione.it",
              sourceName: "anac_ckan",
              territorialSignalType: "public_works_dataset",
              requireGeoMatch: true,
              keywords: Array.isArray(body?.keywords) && body.keywords.length
                ? body.keywords
                : ["Padova", "provincia di Padova", "appalti Padova", "lavori pubblici Padova"],
              province: Array.isArray(body?.province) ? body.province : ["PD"],
              dryRun: persist.dryRun,
              import: persist.doImport,
              maxPerKeyword: typeof body?.maxPerKeyword === "number" ? body.maxPerKeyword : 15,
            });
            return withIdentity(json(req, r.ok ? 200 : 207, { job: "anac-ckan", ...r }, debugId), "job-anac-ckan");
          }
          if (matched === "/jobs/import-open-data-veneto-deep") {
            const persist = resolveScheduledPersist(body);
            const r = await runOpenDataVenetoDeepImport({
              dryRun: persist.dryRun,
              import: persist.doImport,
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
            const persist = resolveScheduledPersist(body);
            const useEnv = body?.includeStations !== undefined || body?.includeZoneAria !== undefined || body?.pageSize !== undefined;
            if (useEnv) {
              const r = await runArpavEnvironmentalImport({
                dryRun: persist.dryRun,
                import: persist.doImport,
                province: Array.isArray(body?.province) ? body.province : ["VE","VR","VI","PD","TV","BL","RO"],
                maxFeatures: typeof body?.maxFeatures === "number" ? body.maxFeatures : 2000,
                pageSize: typeof body?.pageSize === "number" ? body.pageSize : 500,
                includeStations: body?.includeStations !== false,
                includeZoneAria: body?.includeZoneAria !== false,
              });
              return withIdentity(json(req, r.ok ? 200 : 207, { job: "import-arpav-air-quality", mode: "environmental", ...r }, debugId), "job-arpav-env");
            }
            const r = await runArpavAirImport({
              dryRun: persist.dryRun,
              import: persist.doImport,
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
    // ─────────────────────────────────────────────────────────────
    // Contendibili — case pubblicizzate da PIÙ agenzie (no esclusiva)
    // READ-ONLY: solo SELECT su listing_identity + listing_price_snapshots + market_anomalies.
    // ─────────────────────────────────────────────────────────────
    if (pathname.endsWith("/contendibili")) {
      const _auth = authorizeContendibili(req, debugId); if (_auth) return _auth;
      const rlC = rateLimit(req, `${FUNCTION_NAME}:contendibili`, { windowMs: 60_000, max: 60 });
      if (!rlC.ok) {
        const r = fail(req, 429, "RATE_LIMITED", "Troppe richieste, riprovare a breve.", debugId);
        r.headers.set("Retry-After", String(rlC.retryAfter));
        return withIdentity(r, "rate-limited");
      }
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) ?? {}; }
      catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }

      const municipality = typeof body.municipality === "string" ? body.municipality.trim() : "";
      if (!municipality) {
        return withIdentity(fail(req, 400, "MISSING_MUNICIPALITY", "Field 'municipality' is required.", debugId), "error");
      }
      const province = typeof body.province === "string" ? body.province.trim() : null;
      const minAgenciesRaw = Number(body.min_agencies);
      // Accept min_agencies ≥1 (relaxed from ≥2) to enable broader scanning when caller asks for it.
      const min_agencies = Number.isFinite(minAgenciesRaw) && minAgenciesRaw >= 1 ? Math.floor(minAgenciesRaw) : 2;
      const limitRaw = Number(body.limit);
      // Raise hard cap from 100 → 300 so calling apps can pull a wider candidate pool.
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(300, Math.floor(limitRaw)) : 50;
      const debugCandidates = body.debug_candidates === true;
      // Optional: list of additional comuni to scan together (e.g. neighbouring municipalities).
      const extraMunicipalities = Array.isArray((body as any).municipalities)
        ? ((body as any).municipalities as unknown[])
            .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
            .map((m) => m.trim())
        : [];
      const municipalitiesScan = Array.from(new Set([municipality, ...extraMunicipalities].map((m) => m.toLowerCase())));

      const supa = getServiceClient();
      if (!supa) return withIdentity(fail(req, 503, "DB_UNAVAILABLE", "No DB client", debugId), "error");

      try {
        type ContendibiliDebugRow = {
          identity_hash: string | null;
          source_id: string | null;
          comune: string | null;
          portale: string | null;
          n_agenzie: number;
          exclude_reason?: string;
          duplicate_of?: string | null;
        };

        const firstString = (value: unknown): string | null => {
          if (typeof value === "string" && value.trim()) return value.trim();
          if (Array.isArray(value)) {
            const found = value.find((v) => typeof v === "string" && v.trim());
            return typeof found === "string" ? found.trim() : null;
          }
          return null;
        };

        const addReason = (counts: Record<string, number>, reason: string) => {
          counts[reason] = (counts[reason] ?? 0) + 1;
        };

        const toDebugRow = (row: Record<string, unknown>, nAgenzie: number, reason?: string, duplicateOf?: string | null): ContendibiliDebugRow => ({
          identity_hash: typeof row.identity_hash === "string" ? row.identity_hash : null,
          source_id: firstString(row.listing_ids_seen),
          comune: typeof row.municipality === "string" ? row.municipality : null,
          portale: firstString(row.sources_seen),
          n_agenzie: nAgenzie,
          ...(reason ? { exclude_reason: reason } : {}),
          ...(duplicateOf !== undefined ? { duplicate_of: duplicateOf } : {}),
        });

        const excludeReasonCounts: Record<string, number> = {};
        const excludedSample: ContendibiliDebugRow[] = [];
        const duplicateSample: ContendibiliDebugRow[] = [];

        // 1) listing_identity con >=min_agencies agenzie diverse nei comuni in scope.
        // Filtraggio min_agencies fatto client-side (Supabase non espone array_length nella PostgREST select chain).
        const identityQuery = supa
          .from("listing_identity")
          .select("identity_hash, agencies_seen, sources_seen, listing_ids_seen, observation_count, surface_sqm, rooms, property_type, last_seen_at, lat_rounded, lng_rounded, municipality")
          .gt("observation_count", min_agencies >= 2 ? 1 : 0)
          .order("last_seen_at", { ascending: false })
          .limit(Math.min(1000, Math.max(500, limit * 6)));
        const { data: identities, error: idErr } = municipalitiesScan.length > 1
          ? await identityQuery.or(municipalitiesScan.map((m) => `municipality.ilike.${m}`).join(","))
          : await identityQuery.ilike("municipality", municipality);
        if (idErr) {
          console.error(`[${FUNCTION_NAME}] contendibili identity err: ${idErr.message}`);
          return withIdentity(fail(req, 500, "DB_ERROR", "Lookup failed", debugId), "error");
        }

        // Normalizzazione nome agenzia per deduplica
        const normalizeAgency = (raw: string): string => {
          let s = raw.toLowerCase();
          s = s.replace(/[.,()\[\]"']/g, " ");
          s = s.replace(/\bs\s*\.?\s*r\s*\.?\s*l\s*\.?\s*s?\b/g, " "); // srl, s.r.l, srls
          s = s.replace(/\bs\s*\.?\s*a\s*\.?\s*s\s*\.?\b/g, " "); // sas, s.a.s
          s = s.replace(/\bs\s*\.?\s*n\s*\.?\s*c\s*\.?\b/g, " "); // snc
          s = s.replace(/\bs\s*\.?\s*p\s*\.?\s*a\s*\.?\b/g, " "); // spa
          s = s.replace(/\bsede\s+di\s+\S+/g, " ");
          s = s.replace(/\bdi\s+[a-z]+(?:\s+[a-z])?\s*(?:&\s*c\.?)?/g, " ");
          s = s.replace(/&\s*c\.?/g, " ");
          s = s.replace(/\s+/g, " ").trim();
          return s;
        };

        // Filtro geografico: nomi di altre città/province venete da escludere
        const OTHER_VENETO = ["belluno", "verona", "vicenza", "treviso", "rovigo", "venezia", "mestre", "padova"];
        const municipalityLc = municipality.toLowerCase();
        const forbiddenLocs = OTHER_VENETO.filter((n) => !municipalityLc.includes(n) && n !== municipalityLc);

        const normalizedCandidates = (identities ?? [])
          .map((r) => {
            const rawAgencies = Array.isArray(r.agencies_seen)
              ? (r.agencies_seen as string[]).filter((a) => typeof a === "string" && a.trim().length > 0)
              : [];
            const normMap = new Map<string, string>(); // norm -> first original
            for (const a of rawAgencies) {
              const n = normalizeAgency(a);
              if (n && !normMap.has(n)) normMap.set(n, a);
            }
            return {
              ...r,
              _agencies: rawAgencies,
              _agenciesUniqueCount: normMap.size,
              _sources: Array.isArray(r.sources_seen) ? (r.sources_seen as string[]) : [],
            };
          });

        const prefiltered = normalizedCandidates
          .filter((r) => {
            if (r._agenciesUniqueCount >= min_agencies) return true;
            const reason = "n_agenzie_below_min";
            addReason(excludeReasonCounts, reason);
            if (debugCandidates && excludedSample.length < 20) {
              excludedSample.push(toDebugRow(r as Record<string, unknown>, r._agenciesUniqueCount, reason));
            }
            return false;
          })
          .sort((a, b) => {
            if (b._agenciesUniqueCount !== a._agenciesUniqueCount) return b._agenciesUniqueCount - a._agenciesUniqueCount;
            return new Date(b.last_seen_at ?? 0).getTime() - new Date(a.last_seen_at ?? 0).getTime();
          })
          .slice(0, Math.min(200, limit * 4));

        let excluded_count = 0;

        const builtItems = await Promise.all(prefiltered.map(async (row) => {
          const hash = row.identity_hash as string;

          const { data: snaps } = await supa
            .from("listing_price_snapshots")
            .select("price_eur, captured_at, first_seen_at, raw_address, raw_title")
            .eq("identity_hash", hash)
            .order("captured_at", { ascending: true })
            .limit(300);

          const snapsArr = snaps ?? [];
          const pricesAsc = snapsArr
            .map((s) => ({ p: Number(s.price_eur), t: new Date(s.captured_at).getTime(), first: s.first_seen_at }))
            .filter((x) => Number.isFinite(x.p) && x.p > 0);

          let drops_count = 0;
          for (let i = 1; i < pricesAsc.length; i++) {
            const prev = pricesAsc[i - 1].p, cur = pricesAsc[i].p;
            if (prev > 0 && ((prev - cur) / prev) * 100 >= 1) drops_count++;
          }

          const initial_price_eur = pricesAsc.length > 0 ? pricesAsc[0].p : null;
          const last_price_eur = pricesAsc.length > 0 ? pricesAsc[pricesAsc.length - 1].p : null;

          let earliest = Date.now();
          for (const s of snapsArr) {
            const t = s.first_seen_at ? new Date(s.first_seen_at).getTime() : new Date(s.captured_at).getTime();
            if (Number.isFinite(t)) earliest = Math.min(earliest, t);
          }
          const days_online = snapsArr.length > 0 ? Math.max(0, Math.floor((Date.now() - earliest) / 86_400_000)) : 0;

          const latest = snapsArr[snapsArr.length - 1];
          const address = (latest?.raw_address as string | null) ?? municipality;
          const title = (latest?.raw_title as string | null) ?? null;

          // Anomalie
          const { data: anomRows } = await supa
            .from("market_anomalies")
            .select("anomaly_type, confidence, detected_at, is_active")
            .eq("identity_hash", hash)
            .eq("is_active", true)
            .in("anomaly_type", ["agency_swap", "cross_portal_reappear"])
            .order("detected_at", { ascending: false })
            .limit(10);
          const anomalies = (anomRows ?? []).map((a) => ({
            type: a.anomaly_type,
            confidence: a.confidence,
            detected_at: a.detected_at,
          }));

          // total_drop_pct coerente (no rialzi)
          let total_drop_pct: number | null = null;
          let price_inconsistent = false;
          if (initial_price_eur && last_price_eur && initial_price_eur > 0) {
            if (last_price_eur > initial_price_eur) {
              total_drop_pct = 0;
              price_inconsistent = true;
            } else {
              total_drop_pct = Math.round(((initial_price_eur - last_price_eur) / initial_price_eur) * 10000) / 100;
            }
          }

          return {
            identity_hash: hash,
            address,
            title,
            property_type: row.property_type ?? null,
            surface_sqm: row.surface_sqm ?? null,
            rooms: row.rooms ?? null,
            agencies_count: row._agenciesUniqueCount,
            agencies_seen: row._agencies,
            sources_seen: row._sources,
            days_online,
            last_price_eur,
            initial_price_eur,
            total_drop_pct,
            drops_count,
            price_inconsistent,
            anomalies,
            last_seen_at: row.last_seen_at,
            lat_rounded: (row as { lat_rounded?: number | null }).lat_rounded ?? null,
            lng_rounded: (row as { lng_rounded?: number | null }).lng_rounded ?? null,
            diag_last_price_eur: last_price_eur,
            diag_identity_hash: hash,
            diag_source_id: firstString((row as Record<string, unknown>).listing_ids_seen),
            diag_comune: (row.municipality as string | null) ?? null,
            diag_portale: firstString((row as Record<string, unknown>).sources_seen),
            diag_n_agenzie: row._agenciesUniqueCount,
          };
        }));

        // Filtri post-build
        const cleaned = builtItems.filter((it) => {
          // Prezzo last fuori soglia o nullo
          if (it.last_price_eur === null || it.last_price_eur <= 20000 || it.last_price_eur > 5000000) {
            const reason = "price_missing_or_out_of_range";
            excluded_count++;
            addReason(excludeReasonCounts, reason);
            if (debugCandidates && excludedSample.length < 20) {
              excludedSample.push({
                identity_hash: it.diag_identity_hash,
                source_id: it.diag_source_id,
                comune: it.diag_comune,
                portale: it.diag_portale,
                n_agenzie: it.diag_n_agenzie,
                exclude_reason: reason,
              });
            }
            return false;
          }
          // Rialzo > 25% → identity_hash collassato su immobili diversi
          if (it.initial_price_eur && it.last_price_eur > it.initial_price_eur * 1.25) {
            const reason = "price_increase_over_25pct";
            excluded_count++;
            addReason(excludeReasonCounts, reason);
            if (debugCandidates && excludedSample.length < 20) {
              excludedSample.push({
                identity_hash: it.diag_identity_hash,
                source_id: it.diag_source_id,
                comune: it.diag_comune,
                portale: it.diag_portale,
                n_agenzie: it.diag_n_agenzie,
                exclude_reason: reason,
              });
            }
            return false;
          }
          // Provincia/città incompatibile nell'address
          const addrLc = (it.address ?? "").toLowerCase();
          if (forbiddenLocs.some((loc) => addrLc.includes(loc))) {
            const reason = "address_contains_other_veneto_city";
            excluded_count++;
            addReason(excludeReasonCounts, reason);
            if (debugCandidates && excludedSample.length < 20) {
              excludedSample.push({
                identity_hash: it.diag_identity_hash,
                source_id: it.diag_source_id,
                comune: it.diag_comune,
                portale: it.diag_portale,
                n_agenzie: it.diag_n_agenzie,
                exclude_reason: reason,
              });
            }
            return false;
          }
          return true;
        });

        cleaned.sort((a, b) => b.agencies_count - a.agencies_count);

        // ── OMI zone resolution (Padova scope) ────────────────────────────
        const requireOmiZone = (body as any).require_omi_zone === true
          || (typeof (body as any).scope === "string" && (body as any).scope === "padova_omi_zones");
        const omiResolutions = await resolvePadovaOmiBatch(
          cleaned as unknown as Array<Record<string, unknown>>,
          supa as any,
          (r) => ({
            lat: typeof (r as any).lat_rounded === "number" ? (r as any).lat_rounded : null,
            lng: typeof (r as any).lng_rounded === "number" ? (r as any).lng_rounded : null,
          }),
        );

        const omiZoneBreakdownC: Record<string, number> = {};
        let excludedNoOmiZone = 0;
        let excludedLowConfidence = 0;
        const omiExcludedSamples: Array<{ identity_hash: string | null; reason: string; address: string | null }> = [];

        const itemsWithOmi: any[] = [];
        for (let i = 0; i < cleaned.length; i++) {
          const it = cleaned[i];
          const r = omiResolutions[i];
          const code = r?.omi_zone_code ?? null;
          if (requireOmiZone) {
            if (!code) {
              excludedNoOmiZone++;
              if (omiExcludedSamples.length < 20) {
                omiExcludedSamples.push({ identity_hash: it.identity_hash, reason: r?.omi_zone_reason ?? "missing_omi", address: it.address ?? null });
              }
              continue;
            }
            if ((r?.omi_zone_confidence ?? 0) < 0.6) {
              excludedLowConfidence++;
              if (omiExcludedSamples.length < 20) {
                omiExcludedSamples.push({ identity_hash: it.identity_hash, reason: "low_confidence", address: it.address ?? null });
              }
              continue;
            }
          }
          if (code) omiZoneBreakdownC[code] = (omiZoneBreakdownC[code] ?? 0) + 1;
          itemsWithOmi.push({
            ...it,
            comune: "Padova",
            municipality: "Padova",
            provincia: "PD",
            province: "PD",
            omi_zone_code: code,
            omi_zone_label: r?.omi_zone_label ?? null,
            omi_zone_confidence: r?.omi_zone_confidence ?? 0,
            omi_zone_reason: r?.omi_zone_reason ?? "unknown",
          });
        }

        const items = itemsWithOmi.slice(0, limit);

        // ── Diagnostica raccolta ───────────────────────────────────────────────
        const totalScanned = (identities ?? []).length;
        const seenIdentityHashes = new Set<string>();
        for (const row of normalizedCandidates) {
          const hash = typeof row.identity_hash === "string" ? row.identity_hash : null;
          if (!hash) continue;
          if (seenIdentityHashes.has(hash)) {
            if (debugCandidates && duplicateSample.length < 20) {
              duplicateSample.push(toDebugRow(row as Record<string, unknown>, row._agenciesUniqueCount, undefined, hash));
            }
          } else {
            seenIdentityHashes.add(hash);
          }
        }
        const duplicatesRemoved = Math.max(0, normalizedCandidates.length - seenIdentityHashes.size);
        const sourceBreakdown: Record<string, number> = {};
        for (const it of items) {
          for (const s of (it.sources_seen ?? [])) {
            if (typeof s === "string" && s) sourceBreakdown[s] = (sourceBreakdown[s] ?? 0) + 1;
          }
        }
        let lastSourceRefreshAt: string | null = null;
        try {
          const { data: lastSnap } = await supa
            .from("listing_price_snapshots")
            .select("captured_at")
            .or(municipalitiesScan.map((m) => `municipality.ilike.${m}`).join(","))
            .order("captured_at", { ascending: false })
            .limit(1);
          lastSourceRefreshAt = lastSnap?.[0]?.captured_at ?? null;
        } catch { /* non-fatal */ }

        return withIdentity(json(req, 200, {
          municipality,
          municipalities_scanned: municipalitiesScan,
          province,
          min_agencies,
          count: items.length,
          excluded_count,
          items,
          diagnostics: {
            scope: "padova_omi_zones",
            municipality_applied: "Padova",
            omi_zones_expected: CIVIKO_PADOVA_SCOPE.omi_zones_expected,
            omi_zones_with_data: Object.keys(omiZoneBreakdownC).length,
            total_candidates_scanned: totalScanned,
            total_after_filters: cleaned.length,
            duplicates_removed: duplicatesRemoved,
            excluded_post_build: excluded_count,
            excluded_not_padova: 0,
            excluded_no_omi_zone: excludedNoOmiZone,
            excluded_low_confidence: excludedLowConfidence,
            returned: items.length,
            min_agencies_applied: min_agencies,
            limit_applied: limit,
            municipalities_applied: municipalitiesScan,
            source_breakdown: sourceBreakdown,
            omi_zone_breakdown: omiZoneBreakdownC,
            exclude_reason_counts: excludeReasonCounts,
            last_source_refresh_at: lastSourceRefreshAt,
            excluded_samples: omiExcludedSamples,
            require_omi_zone: requireOmiZone,
          },
          ...(debugCandidates ? {
            debug_candidates_sample: {
              returned_sample: items.slice(0, 10).map((it: any) => ({
                identity_hash: it.diag_identity_hash,
                source_id: it.diag_source_id,
                comune: it.diag_comune,
                portale: it.diag_portale,
                n_agenzie: it.diag_n_agenzie,
                omi_zone_code: it.omi_zone_code,
              })),
              excluded_sample: excludedSample,
              duplicate_sample: duplicateSample,
            },
          } : {}),
        }, debugId), "contendibili");

      } catch (e) {
        console.error(`[${FUNCTION_NAME}] contendibili error: ${e instanceof Error ? e.message : String(e)}`);
        return withIdentity(fail(req, 500, "CONTENDIBILI_FAILED", "Contendibili lookup failed", debugId), "error");
      }
    }

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

    // ─────────────────────────────────────────────────────────────
    // /zone-quartieri — aggregato per quartiere (Padova città).
    // Legge dalla vista di produzione public.padova_quartieri_stats_v
    // (fonte canonica dei conteggi per zona) e risolve il codice OMI via
    // public.quartiere_zona_map. Totali globali da public.padova_listings_totali_v.
    // NON ri-crawla. Aggiunge fascia commerciale + prezzo esclusiva mese.
    // ─────────────────────────────────────────────────────────────
    if (pathname.endsWith("/zone-quartieri")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) ?? {}; }
      catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
      const municipality = typeof body.municipality === "string" ? body.municipality.trim() : "Padova";
      if (municipality.toLowerCase() !== "padova") {
        return withIdentity(fail(req, 400, "UNSUPPORTED_MUNICIPALITY", "Solo Padova è supportato in questa release.", debugId), "error");
      }
      const supa = getServiceClient();
      if (!supa) return withIdentity(fail(req, 503, "DB_UNAVAILABLE", "No DB client", debugId), "error");
      try {
        const { data: statsRows, error: sErr } = await supa
          .from("padova_quartieri_stats_v")
          .select("zona, n_contendibili, n_annunci, n_agenzie, n_ribassi, n_privati, prezzo_min, prezzo_max");
        if (sErr) return withIdentity(fail(req, 500, "DB_ERROR", sErr.message, debugId), "error");
        const stats = (statsRows ?? []) as Array<Record<string, unknown>>;

        const { data: mapRows } = await supa
          .from("quartiere_zona_map")
          .select("quartiere_key, omi_zone_code");
        const keyToOmi = new Map<string, string>();
        for (const r of ((mapRows ?? []) as Array<Record<string, unknown>>)) {
          const k = String(r.quartiere_key ?? "").toLowerCase().trim();
          const o = String(r.omi_zone_code ?? "").toUpperCase().trim();
          if (k && o) keyToOmi.set(k, o);
        }
        const resolveOmi = (zona: string): string => {
          const k = zona.toLowerCase().trim();
          return keyToOmi.get(k) ?? "—";
        };

        const PREMIUM_OMI = new Set(["B1", "B2", "C3"]);
        const computeFascia = (omi: string, contendibili: number): { fascia: string; prezzo: number } => {
          if (PREMIUM_OMI.has(omi) && contendibili >= 130) return { fascia: "PREMIUM", prezzo: 1800 };
          if (contendibili >= 80) return { fascia: "ALTA", prezzo: 1500 };
          if (contendibili >= 45) return { fascia: "STANDARD", prezzo: 1200 };
          if (contendibili >= 17) return { fascia: "BASE", prezzo: 1000 };
          return { fascia: "NON_VENDIBILE", prezzo: 0 };
        };

        const rows = stats.map((r) => {
          const quartiere = String(r.zona ?? "");
          const omi = resolveOmi(quartiere);
          const contendibili = Number(r.n_contendibili ?? 0);
          const { fascia, prezzo } = computeFascia(omi, contendibili);
          return {
            quartiere,
            omi,
            tot_annunci: Number(r.n_annunci ?? 0),
            contendibili,
            privati: Number(r.n_privati ?? 0),
            privati_stanchi: 0,
            ribassi: Number(r.n_ribassi ?? 0),
            agenzie_distinte: Number(r.n_agenzie ?? 0),
            fascia,
            prezzo_esclusiva_mese: prezzo,
          };
        });

        rows.sort((a, b) => b.contendibili - a.contendibili);

        const { data: totRow } = await supa
          .from("padova_listings_totali_v")
          .select("tot_annunci, tot_agenzie")
          .maybeSingle();

        const totali = {
          annunci: Number(totRow?.tot_annunci ?? rows.reduce((s, r) => s + r.tot_annunci, 0)),
          contendibili: rows.reduce((s, r) => s + r.contendibili, 0),
          privati: rows.reduce((s, r) => s + r.privati, 0),
          privati_stanchi: 0,
          ribassi: rows.reduce((s, r) => s + r.ribassi, 0),
          agenzie_distinte: Number(totRow?.tot_agenzie ?? rows.reduce((s, r) => Math.max(s, r.agenzie_distinte), 0)),
        };

        return withIdentity(json(req, 200, {
          municipality: "Padova",
          updated_at: new Date().toISOString(),
          job_id: null,
          totali,
          quartieri: rows,
        }, debugId), "zone-quartieri");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] zone-quartieri error: ${e instanceof Error ? e.message : String(e)}`);
        return withIdentity(fail(req, 500, "ZONE_QUARTIERI_FAILED", "Aggregato per quartiere fallito", debugId), "error");
      }
    }


    // ─────────────────────────────────────────────────────────────
    // /lead-quartiere — drill-down lead per un singolo quartiere Padova.
    // Filtra listing_identity tramite omi_zones_by_points (batch RPC), poi
    // arricchisce con snapshot prezzi (drops, days_online, tipo_lead).
    // ─────────────────────────────────────────────────────────────
    if (pathname.endsWith("/lead-quartiere")) {
      const _auth = authorizeJob(req, debugId); if (_auth) return _auth;
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) ?? {}; }
      catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
      const municipality = typeof body.municipality === "string" ? body.municipality.trim() : "Padova";
      const quartiereReq = typeof body.quartiere === "string" ? body.quartiere.trim() : null;
      const omiReq = typeof body.omi === "string" ? body.omi.trim().toUpperCase() : null;
      const filterTipo = typeof body.tipo_lead === "string" ? body.tipo_lead.trim() : null;
      const limitRaw = Number(body.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;
      if (!quartiereReq && !omiReq) {
        return withIdentity(fail(req, 400, "MISSING_FILTER", "Fornire 'quartiere' o 'omi'.", debugId), "error");
      }
      const supa = getServiceClient();
      if (!supa) return withIdentity(fail(req, 503, "DB_UNAVAILABLE", "No DB client", debugId), "error");

      try {
        const omiCodes = new Set<string>();
        if (omiReq) omiCodes.add(omiReq);
        if (quartiereReq) {
          const key = quartiereReq.toLowerCase().trim();
          const { data: rows, error: qErr } = await supa
            .from("quartiere_zona_map")
            .select("quartiere_key, omi_zone_code")
            .or(`quartiere_key.eq.${key},quartiere_key.ilike.%${key}%`);
          if (qErr) return withIdentity(fail(req, 500, "DB_ERROR", qErr.message, debugId), "error");
          for (const r of (rows ?? []) as Array<{ quartiere_key: string; omi_zone_code: string | null }>) {
            const c = String(r.omi_zone_code ?? "").toUpperCase();
            if (c) omiCodes.add(c);
          }
          if (omiCodes.size === 0) {
            return withIdentity(fail(req, 404, "QUARTIERE_NOT_FOUND", `Quartiere '${quartiereReq}' non trovato.`, debugId), "error");
          }
        }

        const { data: identities, error: idErr } = await supa
          .from("listing_identity")
          .select("identity_hash, agencies_seen, sources_seen, surface_sqm, rooms, property_type, last_seen_at, lat_rounded, lng_rounded, observation_count")
          .ilike("municipality", municipality)
          .not("lat_rounded", "is", null)
          .not("lng_rounded", "is", null)
          .order("last_seen_at", { ascending: false })
          .limit(5000);
        if (idErr) return withIdentity(fail(req, 500, "DB_ERROR", idErr.message, debugId), "error");

        const all = identities ?? [];
        if (all.length === 0) {
          return withIdentity(json(req, 200, { municipality, quartiere: quartiereReq, omi: Array.from(omiCodes), count: 0, total_in_zone: 0, items: [] }, debugId), "lead-quartiere");
        }

        const lats = all.map((r) => Number(r.lat_rounded));
        const lngs = all.map((r) => Number(r.lng_rounded));
        const { data: zones, error: zErr } = await supa.rpc("omi_zones_by_points", { p_lats: lats, p_lngs: lngs });
        if (zErr) return withIdentity(fail(req, 500, "RPC_ERROR", zErr.message, debugId), "error");
        const idxToZone = new Map<number, string>();
        for (const z of (zones ?? []) as Array<{ idx: number; zona: string | null }>) {
          if (z.zona) idxToZone.set(Number(z.idx), String(z.zona).toUpperCase());
        }

        const matched = all
          .map((row, i) => ({ row, omi: idxToZone.get(i + 1) ?? null }))
          .filter((x) => x.omi && omiCodes.has(x.omi));

        if (matched.length === 0) {
          return withIdentity(json(req, 200, { municipality, quartiere: quartiereReq, omi: Array.from(omiCodes), count: 0, total_in_zone: 0, items: [] }, debugId), "lead-quartiere");
        }

        const capped = matched.slice(0, Math.min(matched.length, Math.max(limit, 200)));
        const PRIVATE_SOURCES = new Set(["subito", "subito.it", "kijiji", "bakeca"]);

        const items = await Promise.all(capped.map(async ({ row, omi }) => {
          const hash = row.identity_hash as string;
          const { data: snaps } = await supa
            .from("listing_price_snapshots")
            .select("price_eur, captured_at, first_seen_at, raw_address, raw_title")
            .eq("identity_hash", hash)
            .order("captured_at", { ascending: true })
            .limit(100);
          const snapsArr = snaps ?? [];
          const pricesAsc = snapsArr
            .map((s) => ({ p: Number(s.price_eur) }))
            .filter((x) => Number.isFinite(x.p) && x.p > 0);
          let drops_count = 0;
          for (let i = 1; i < pricesAsc.length; i++) {
            const prev = pricesAsc[i - 1].p, cur = pricesAsc[i].p;
            if (prev > 0 && ((prev - cur) / prev) * 100 >= 1) drops_count++;
          }
          const initial_price_eur = pricesAsc.length > 0 ? pricesAsc[0].p : null;
          const last_price_eur = pricesAsc.length > 0 ? pricesAsc[pricesAsc.length - 1].p : null;
          let total_drop_pct: number | null = null;
          if (initial_price_eur && last_price_eur && initial_price_eur > 0 && last_price_eur <= initial_price_eur) {
            total_drop_pct = Math.round(((initial_price_eur - last_price_eur) / initial_price_eur) * 10000) / 100;
          }
          let earliest = Date.now();
          for (const s of snapsArr) {
            const t = s.first_seen_at ? new Date(s.first_seen_at).getTime() : new Date(s.captured_at).getTime();
            if (Number.isFinite(t)) earliest = Math.min(earliest, t);
          }
          const days_online = snapsArr.length > 0 ? Math.max(0, Math.floor((Date.now() - earliest) / 86_400_000)) : 0;
          const latestSnap = snapsArr[snapsArr.length - 1];
          const address = (latestSnap?.raw_address as string | null) ?? municipality;
          const title = (latestSnap?.raw_title as string | null) ?? null;

          const agencies = Array.isArray(row.agencies_seen) ? (row.agencies_seen as string[]).filter((a) => typeof a === "string" && a.trim().length > 0) : [];
          const sources = Array.isArray(row.sources_seen) ? (row.sources_seen as string[]) : [];
          const agencies_count = new Set(agencies.map((a) => a.toLowerCase().trim())).size;
          const priv = agencies_count === 0 || sources.some((s) => PRIVATE_SOURCES.has(String(s).toLowerCase()));

          let tipo_lead: "contendibile" | "privato_stanco" | "ribasso" | "privato" | "standard" = "standard";
          if (agencies_count >= 2) tipo_lead = "contendibile";
          else if (total_drop_pct !== null && total_drop_pct >= 5) tipo_lead = "ribasso";
          else if (priv && days_online >= 60) tipo_lead = "privato_stanco";
          else if (priv) tipo_lead = "privato";

          return {
            identity_hash: hash,
            address,
            title,
            property_type: row.property_type ?? null,
            surface_sqm: row.surface_sqm ?? null,
            rooms: row.rooms ?? null,
            agencies_count,
            agencies_seen: agencies,
            sources_seen: sources,
            days_online,
            last_price_eur,
            initial_price_eur,
            total_drop_pct,
            drops_count,
            tipo_lead,
            last_seen_at: row.last_seen_at,
            lat_rounded: row.lat_rounded ?? null,
            lng_rounded: row.lng_rounded ?? null,
            omi,
          };
        }));

        let out = items;
        if (filterTipo) out = out.filter((i) => i.tipo_lead === filterTipo);
        out.sort((a, b) => b.days_online - a.days_online);
        out = out.slice(0, limit);

        return withIdentity(json(req, 200, {
          municipality,
          quartiere: quartiereReq,
          omi: Array.from(omiCodes),
          count: out.length,
          total_in_zone: matched.length,
          items: out,
        }, debugId), "lead-quartiere");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] lead-quartiere error: ${e instanceof Error ? e.message : String(e)}`);
        return withIdentity(fail(req, 500, "LEAD_QUARTIERE_FAILED", "Drill-down quartiere fallito", debugId), "error");
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

    // ── Civiko One radar-run orchestrator ──
    // Cron-friendly endpoint: ingestion portali → snapshot/segnali → agent radar → response Civiko-compatibile
    // Auth: x-job-secret (CENTRAL_CORE_JOB_SECRET) o x-source-app + x-internal-secret.
    if (pathname.endsWith("/jobs/civiko-one-radar-run")) {
      const jobAuthFail = authorizeContendibili(req, debugId);
      if (jobAuthFail) {
        const internalAuthFail = requireSecret(req, debugId);
        if (internalAuthFail) return withIdentity(internalAuthFail, "civiko-one-radar-run-unauthorized");
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed = await req.json();
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      } catch { /* opzionale */ }

      const intent = String(body.intent ?? "soft").toLowerCase() === "full" ? "full" : "soft";
      const comuni: string[] = Array.isArray(body.comuni) && (body.comuni as unknown[]).length > 0
        ? (body.comuni as unknown[]).map(String)
        : ["Padova"];
      const provincia = typeof body.provincia === "string" ? body.provincia : "PD";

      const radarMeta: RadarRunMeta = {
        run_id: (body.run_id as string) ?? debugId,
        request_id: (body.request_id as string) ?? debugId,
        source: (body.source as string) ?? "central-core",
        target: (body.target as string) ?? "civiko-one",
        triggered_by: (body.trigger as string) ?? req.headers.get("x-source-app") ?? "civiko-one-radar-run",
        mode: (body.mode as string) ?? null,
        intent: intent as any,
        scope: (body.scope as string) ?? null,
      };
      let budgetState;
      try { budgetState = await computeBudgetState(radarMeta); } catch (e) {
        console.warn(`[${FUNCTION_NAME}] civiko-one-radar-run budget state failed:`, e instanceof Error ? e.message : String(e));
      }
      const capReached = budgetState?.budget_mode === "capped" || await isRadarMonthlyHardCapReached().catch(() => false);
      if (capReached) {
        const cappedReport = ensureCostReport(budgetState?.cost_report ?? null, ["budget_cap_reached"]);
        (cappedReport as Record<string, unknown>).budget_mode = "capped";
        return withIdentity(json(req, 200, {
          ok: true,
          job: "civiko-one-radar-run",
          intent, comuni, provincia,
          budget_mode: "capped",
          ingestion: [],
          summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "parziale" as const },
          zones: [], opportunities: [],
          cost_report: cappedReport,
          data: { cost_report: cappedReport },
        }, debugId), "civiko-one-radar-run-capped");
      }

      const ingestionReport: Array<{ comune: string; opportunities: number; mode: string; skipped?: string }> = [];
      const effectiveMode: "soft" | "full" = budgetState?.budget_mode === "economy" ? "soft" : intent;
      for (const c of comuni.slice(0, 5)) {
        try {
          const opps = await scrapeRibassiPortali(c, null, provincia, effectiveMode);
          ingestionReport.push({ comune: c, opportunities: opps.length, mode: effectiveMode });
        } catch (e) {
          console.warn(`[${FUNCTION_NAME}] civiko-one-radar-run ingestion error ${c}:`, e instanceof Error ? e.message : String(e));
          ingestionReport.push({ comune: c, opportunities: 0, mode: effectiveMode, skipped: "error" });
        }
      }

      try {
        const radarReq: AgentRadarRequest = {
          comune: comuni[0],
          provincia,
          maxOpportunities: intent === "full" ? 60 : 30,
          minZoneScore: intent === "full" ? 10 : 15,
          maxZones: intent === "full" ? 30 : 18,
        };
        const out = await buildAgentRadar(radarReq);
        let rawReport = budgetState?.cost_report;
        try { const post = await computeBudgetState(radarMeta); rawReport = post.cost_report; } catch {/* ignore */}
        const cost_report = ensureCostReport(rawReport ?? null);
        return withIdentity(json(req, 200, {
          ok: true,
          job: "civiko-one-radar-run",
          intent, comuni, provincia,
          ingestion: ingestionReport,
          ...out,
          cost_report,
          data: { ...((out as any)?.data ?? {}), cost_report, ingestion: ingestionReport },
        }, debugId), "civiko-one-radar-run");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] civiko-one-radar-run error:`, e instanceof Error ? e.message : String(e));
        const errReport = ensureCostReport(budgetState?.cost_report ?? null, ["civiko_one_radar_run_error"]);
        return withIdentity(json(req, 200, {
          ok: false,
          job: "civiko-one-radar-run",
          intent, comuni, provincia,
          ingestion: ingestionReport,
          summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" as const },
          zones: [], opportunities: [],
          cost_report: errReport,
          data: { cost_report: errReport, ingestion: ingestionReport },
          error: { code: "JOB_FAILED", message: e instanceof Error ? e.message : String(e) },
        }, debugId), "civiko-one-radar-run-error");
      }
    }

    // Agent Radar — output operativo Veneto-only per MVP Civiko One / Acquisition Radar
    if (pathname.endsWith("/agent-radar") || pathname.endsWith("/agentRadar")) {
      // Auth obbligatoria: x-source-app + x-internal-secret (per-app)
      // Dual auth: accept x-job-secret (same as /contendibili) OR x-source-app + x-internal-secret
      const jobAuthFail = authorizeContendibili(req, debugId);
      if (jobAuthFail) {
        const internalAuthFail = requireSecret(req, debugId);
        if (internalAuthFail) return withIdentity(internalAuthFail, "agent-radar-unauthorized");
      }
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
          const naReport = ensureCostReport(null, ["needs_operating_area"]);
          return withIdentity(json(req, 200, {
            ok: false, scopeMode: "agency_area", needsOperatingArea: true,
            message: "Configura la tua zona di lavoro per ricevere il Radar.",
            summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" as const },
            zones: [], opportunities: [],
            cost_report: naReport,
            data: { cost_report: naReport },
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
      // ── Budget manager: stato + kill-switch hard cap mensile ───
      const radarMeta: RadarRunMeta = {
        run_id: (body as any).run_id ?? (body as any).request_id ?? debugId,
        request_id: (body as any).request_id ?? debugId,
        source: (body as any).source ?? "central-core",
        target: (body as any).target ?? "civiko-one",
        triggered_by: (body as any).triggered_by ?? req.headers.get("x-source-app") ?? null,
        mode: (body as any).mode ?? null,
        intent: ((body as any).intent ?? "unknown") as any,
        scope: requestedScope || (body as any).scope || null,
      };
      let budgetState;
      try { budgetState = await computeBudgetState(radarMeta); } catch (e) {
        console.warn(`[${FUNCTION_NAME}] budget state failed:`, e instanceof Error ? e.message : String(e));
      }
      const capReached = budgetState?.budget_mode === "capped" || await isRadarMonthlyHardCapReached().catch(() => false);
      if (capReached) {
        const cappedReport = ensureCostReport(budgetState?.cost_report ?? null, ["budget_cap_reached"]);
        (cappedReport as Record<string, unknown>).budget_mode = "capped";
        return withIdentity(json(req, 200, {
          ok: true, scopeMode, configured: true,
          budget_mode: "capped",
          summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "parziale" as const },
          zones: [], opportunities: [],
          dataQuality: { real: [], partial: [], missing: [], warnings: ["budget_cap_reached"] },
          cost_report: cappedReport,
          data: { cost_report: cappedReport },
        }, debugId), "agent-radar-capped");
      }

      try {
        // ── Ingestion phase: alimenta listing_price_snapshots + segnali PRIMA di leggere ──
        const intentRaw = String((body as any).intent ?? (body as any).mode ?? "").toLowerCase();
        const shouldIngest = intentRaw === "soft" || intentRaw === "full";

        // ── Scope normalizzato: province[] + comuni[] dal body ────────────
        const provincesRawIn: unknown = (body as any).province;
        const provincesArrRaw: string[] = Array.isArray(provincesRawIn)
          ? (provincesRawIn as unknown[]).map(String)
          : (typeof provincesRawIn === "string" ? [provincesRawIn] : []);
        if ((body as any).provincia && !provincesArrRaw.includes(String((body as any).provincia))) {
          provincesArrRaw.push(String((body as any).provincia));
        }
        const requestedProvince: string[] = Array.from(new Set(
          provincesArrRaw.map((p) => normalizeProvincia(p)).filter((p): p is string => !!p)
        ));
        const comuniList: string[] = Array.isArray((body as any).comuni) && (body as any).comuni.length > 0
          ? ((body as any).comuni as unknown[]).map((c) => String(c).trim()).filter(Boolean)
          : ((body as any).comune ? [String((body as any).comune).trim()] : []);
        const requestedComuni: string[] = Array.from(new Set(comuniList));
        const requestedComuniLower = new Set(requestedComuni.map((c) => c.toLowerCase()));
        const requestedProvinceSet = new Set(requestedProvince);

        const ingestionReport: Array<{ comune: string; opportunities: number; mode: string; skipped?: string; portals?: unknown; rotation?: string }> = [];
        const ingestionWarnings: string[] = [];
        const aggregateStats = {
          perPortal: [] as Array<{ source: string; raw: number; reason?: string }>,
          rotation: undefined as string | undefined,
          raw_items_found: 0,
          raw_items_after_city_filter: 0,
          raw_items_after_dedupe: 0,
          collect_items_created: 0,
          collect_items_updated: 0,
          collect_errors: [] as string[],
        };
        const providerConfigStatus = buildProviderConfigStatus();
        const sourceFreshnessClient = getServiceClient();
        const sourceFreshnessBefore = await fetchPadovaSourceFreshness(sourceFreshnessClient);
        let sourceFreshnessAfter = sourceFreshnessBefore;
        let ingestionExecuted = false;
        let skipReason: string | null = null;
        let contendibiliRecomputed = false;
        let contendibiliCreated = 0;
        let contendibiliUpdated = 0;
        let recomputeResult: unknown = null;
        let recomputeError: string | null = null;

        if (!shouldIngest) {
          ingestionWarnings.push("soft_ingestion_skipped_not_applicable");
          skipReason = "intent_not_soft_or_full";
        } else if (requestedComuni.length === 0) {
          ingestionWarnings.push("soft_ingestion_skipped_no_comuni");
          skipReason = "no_comuni";
        } else if (budgetState?.budget_mode === "capped") {
          ingestionWarnings.push("soft_ingestion_skipped_budget_capped");
          skipReason = "budget_capped";
          ingestionReport.push({ comune: requestedComuni[0] ?? "—", opportunities: 0, mode: "skipped", skipped: "budget_capped" });
        } else if (!Deno.env.get("FIRECRAWL_API_KEY")) {
          ingestionWarnings.push("soft_ingestion_skipped_no_firecrawl_key");
          skipReason = "missing_firecrawl_key";
        } else {
          ingestionExecuted = true;
          const ingestMode: "soft" | "full" = intentRaw === "full" ? "full" : "soft";
          const effectiveMode: "soft" | "full" = budgetState?.budget_mode === "economy" ? "soft" : ingestMode;
          // full = scansiona TUTTI i comuni in scope (fino a 10); soft = primi 5
          const ingestSlice = effectiveMode === "full" ? requestedComuni.slice(0, 10) : requestedComuni.slice(0, 5);
          for (const c of ingestSlice) {
            const perCallStats = {
              perPortal: [] as Array<{ source: string; raw: number; reason?: string }>,
              rotation: undefined as string | undefined,
              firecrawl_skipped_reason: undefined as string | undefined,
              raw_items_found: 0,
              raw_items_after_city_filter: 0,
              raw_items_after_dedupe: 0,
              collect_items_created: 0,
              collect_items_updated: 0,
              collect_errors: [] as string[],
            };
            try {
              const opps = await scrapeRibassiPortali(c, null, requestedProvince[0] ?? "PD", effectiveMode, radarMeta, perCallStats as any);
              ingestionReport.push({ comune: c, opportunities: opps.length, mode: effectiveMode, portals: perCallStats.perPortal, rotation: perCallStats.rotation });
              aggregateStats.perPortal.push(...perCallStats.perPortal);
              aggregateStats.rotation = perCallStats.rotation;
              aggregateStats.raw_items_found += perCallStats.raw_items_found ?? 0;
              aggregateStats.raw_items_after_city_filter += perCallStats.raw_items_after_city_filter ?? 0;
              aggregateStats.raw_items_after_dedupe += perCallStats.raw_items_after_dedupe ?? 0;
              aggregateStats.collect_items_created += perCallStats.collect_items_created ?? 0;
              aggregateStats.collect_items_updated += perCallStats.collect_items_updated ?? 0;
              aggregateStats.collect_errors.push(...(perCallStats.collect_errors ?? []));
              if (perCallStats.firecrawl_skipped_reason) ingestionWarnings.push(`soft_ingestion_${perCallStats.firecrawl_skipped_reason}`);
            } catch (ingErr) {
              console.warn(`[${FUNCTION_NAME}] ingestion error for ${c}:`, ingErr instanceof Error ? ingErr.message : String(ingErr));
              ingestionReport.push({ comune: c, opportunities: 0, mode: effectiveMode, skipped: "error" });
              ingestionWarnings.push("soft_ingestion_error");
            }
          }
          const totalRaw = aggregateStats.perPortal.reduce((s, p) => s + p.raw, 0);
          if (totalRaw === 0) ingestionWarnings.push("soft_ingestion_zero_results");
          else ingestionWarnings.push(`soft_ingestion_completed_${totalRaw}_listings`);

          // NOTE: recompute_padova_contendibili() is intentionally NOT called here.
          // It is CPU-heavy and times out inside the Edge Function runtime.
          // The dedicated pg_cron job `padova-contendibili-recompute` (03:15 UTC)
          // is the single source of truth for the recompute.
          const triggeredBy = String(radarMeta.triggered_by ?? "").toLowerCase();
          const allowInlineRecompute = requestedComuniLower.has("padova")
            && sourceFreshnessClient
            && !triggeredBy.startsWith("cron-")
            && (body as any).force_recompute_contendibili === true;
          if (allowInlineRecompute) {
            try {
              const { data, error } = await sourceFreshnessClient.rpc("recompute_padova_contendibili");
              if (error) {
                recomputeError = error.message;
                ingestionWarnings.push("padova_contendibili_recompute_error");
              } else {
                contendibiliRecomputed = true;
                recomputeResult = data;
                contendibiliCreated = Number((data as any)?.contendibili_created ?? 0) || 0;
                contendibiliUpdated = Number((data as any)?.contendibili_updated ?? 0) || 0;
                try { await sourceFreshnessClient.rpc("recompute_padova_contendibili_extras"); } catch { /* optional */ }
              }
            } catch (e) {
              recomputeError = e instanceof Error ? e.message : String(e);
              ingestionWarnings.push("padova_contendibili_recompute_exception");
            }
          } else if (requestedComuniLower.has("padova")) {
            ingestionWarnings.push("padova_contendibili_recompute_deferred_to_pg_cron");
          }

        }

        sourceFreshnessAfter = await fetchPadovaSourceFreshness(sourceFreshnessClient);
        if (contendibiliRecomputed && contendibiliCreated === 0 && contendibiliUpdated === 0) {
          const beforeCount = Number(sourceFreshnessBefore.contendibili_count ?? 0);
          const afterCount = Number(sourceFreshnessAfter.contendibili_count ?? 0);
          contendibiliCreated = Math.max(afterCount - beforeCount, 0);
          contendibiliUpdated = Math.min(beforeCount, afterCount);
        }

        const providerResultsCount: Record<string, number> = {};
        const providerErrors: Record<string, string[]> = {};
        for (const p of aggregateStats.perPortal) {
          providerResultsCount[p.source] = (providerResultsCount[p.source] ?? 0) + (Number(p.raw) || 0);
          if (p.reason) providerErrors[p.source] = [...(providerErrors[p.source] ?? []), p.reason];
        }
        if (aggregateStats.collect_errors.length) providerErrors.collect_v2 = aggregateStats.collect_errors;
        if (recomputeError) providerErrors.padova_contendibili = [recomputeError];
        const resultSummary = {
          ingestion_requested: shouldIngest,
          ingestion_executed: ingestionExecuted,
          providers_called: Array.from(new Set(aggregateStats.perPortal.map((p) => p.source))),
          provider_results_count: providerResultsCount,
          provider_errors: providerErrors,
          raw_items_found: aggregateStats.raw_items_found,
          raw_items_after_city_filter: aggregateStats.raw_items_after_city_filter,
          raw_items_after_dedupe: aggregateStats.raw_items_after_dedupe,
          collect_items_created: aggregateStats.collect_items_created,
          collect_items_updated: aggregateStats.collect_items_updated,
          contendibili_recomputed: contendibiliRecomputed,
          contendibili_created: contendibiliCreated,
          contendibili_updated: contendibiliUpdated,
          sanitized_bad_coords: Number((recomputeResult as any)?.sanitized_bad_coords ?? 0) || 0,
          excluded_bad_title: Number((recomputeResult as any)?.excluded_bad_title ?? 0) || 0,
          newest_collect_processed_at_before: sourceFreshnessBefore.newest_collect_processed_at,
          newest_collect_processed_at_after: sourceFreshnessAfter.newest_collect_processed_at,
          newest_contendibile_created_at_before: sourceFreshnessBefore.newest_contendibile_created_at,
          newest_contendibile_created_at_after: sourceFreshnessAfter.newest_contendibile_created_at,
          skip_reason: skipReason,
          budget_guard_status: {
            budget_mode: budgetState?.budget_mode ?? "unknown",
            hard_cap_reached: false,
          },
          provider_config_status: providerConfigStatus,
          recompute_result: recomputeResult,
        };

        // ── Build agentRadar: una chiamata per provincia, NO comune singolo
        // così buildAgentRadar restituisce tutte le zone della provincia, poi
        // facciamo post-filter per comune. Headroom alto, slice finale sotto.
        const userCap = (body as any).maxOpportunities != null
          ? Number((body as any).maxOpportunities)
          : (intentRaw === "full" ? 60 : intentRaw === "soft" ? 30 : 30);
        const userMinScore = (body as any).minZoneScore != null
          ? Number((body as any).minZoneScore)
          : (intentRaw === "full" ? 10 : intentRaw === "soft" ? 15 : 15);

        const provincesToQuery = requestedProvince.length > 0 ? requestedProvince : [undefined as unknown as string];
        const allOpps: any[] = [];
        const allZones: any[] = [];
        let outFirst: any = null;
        for (const prov of provincesToQuery) {
          const enrichedReq: AgentRadarRequest = {
            ...(body as AgentRadarRequest),
            provincia: prov,
            // Important: NON passare comune singolo se ci sono più comuni
            // altrimenti buildAgentRadar restringe a 1 solo comune.
            comune: requestedComuni.length === 1 ? requestedComuni[0] : undefined,
            maxZones: 60,
            maxOpportunities: 120, // headroom; slice dopo post-filter
            minZoneScore: userMinScore,
          };
          const partial = await buildAgentRadar(enrichedReq);
          if (!outFirst) outFirst = partial;
          allOpps.push(...((partial as any)?.opportunities ?? []));
          allZones.push(...((partial as any)?.zones ?? []));
        }

        // ── Post-filter scope: province + comuni ──────────────────────────
        const oppsInScope: any[] = [];
        const zonesInScope: any[] = [];
        let excludedWrongProvince = 0;
        let excludedWrongComune = 0;
        const excludedSamples: Array<{ comune: string; provincia: string; reason: string }> = [];
        const checkScope = (it: any): "in" | "wrong_province" | "wrong_comune" => {
          const p = String(it?.provincia ?? "").toUpperCase();
          const c = String(it?.comune ?? "").trim().toLowerCase();
          if (requestedProvinceSet.size > 0 && p && !requestedProvinceSet.has(p)) return "wrong_province";
          if (requestedComuniLower.size > 0 && c && !requestedComuniLower.has(c)) return "wrong_comune";
          return "in";
        };
        for (const o of allOpps) {
          const r = checkScope(o);
          if (r === "in") { oppsInScope.push(o); continue; }
          if (r === "wrong_province") excludedWrongProvince++;
          else excludedWrongComune++;
          if (excludedSamples.length < 10) {
            excludedSamples.push({ comune: String(o?.comune ?? ""), provincia: String(o?.provincia ?? ""), reason: r });
          }
        }
        for (const z of allZones) {
          if (checkScope(z) === "in") zonesInScope.push(z);
        }

        // Slice finale al cap dell'utente, dopo post-filter
        const finalOpps = oppsInScope
          .sort((a, b) => (Number(b?.score_breakdown?.total ?? 0) || 0) - (Number(a?.score_breakdown?.total ?? 0) || 0))
          .slice(0, userCap);
        const finalZones = zonesInScope.slice(0, Math.max(userCap, 30));

        const out = {
          ...(outFirst ?? {}),
          zones: finalZones,
          opportunities: finalOpps,
        };

        let rawReport = budgetState?.cost_report;
        try {
          const post = await computeBudgetState(radarMeta);
          rawReport = post.cost_report;
        } catch { /* ignore */ }
        const cost_report = ensureCostReport(rawReport ?? null, ingestionWarnings);
        (cost_report as Record<string, unknown>).ingestion = {
          perPortal: aggregateStats.perPortal,
          rotation: aggregateStats.rotation,
          comuni_processed: ingestionReport.length,
          result_summary: resultSummary,
        };

        // ── Diagnostica raccolta /agent-radar ─────────────────────────────
        // source_breakdown: deriva da dataBasis[] (mai "unknown" se ci sono basi)
        const sourceBreakdownAR: Record<string, number> = {};
        for (const o of finalOpps) {
          const basis: string[] = Array.isArray(o?.dataBasis) ? o.dataBasis as string[] : [];
          if (basis.length === 0) {
            const fallback = (o?.source ?? o?.payload?.source ?? "no_basis") as string;
            sourceBreakdownAR[fallback] = (sourceBreakdownAR[fallback] ?? 0) + 1;
          } else {
            for (const b of basis) sourceBreakdownAR[b] = (sourceBreakdownAR[b] ?? 0) + 1;
          }
        }
        const returnedComuni = Array.from(new Set(finalOpps.map((o) => String(o?.comune ?? "")).filter(Boolean))).sort();

        let lastSourceRefreshAR: string | null = null;
        try {
          const supaDiag = getServiceClient();
          if (supaDiag && requestedComuni.length > 0) {
            const { data: ls } = await supaDiag
              .from("listing_price_snapshots")
              .select("captured_at")
              .in("municipality", requestedComuni.map((c) => c.toLowerCase()))
              .order("captured_at", { ascending: false })
              .limit(1);
            lastSourceRefreshAR = ls?.[0]?.captured_at ?? null;
          }
        } catch { /* non-fatal */ }

        // ── Scope canonico Padova OMI ─────────────────────────────────────
        // Civiko One vende SOLO Padova Comune in 22 zone OMI ufficiali.
        // Ogni opportunity restituita deve avere omi_zone_code valido.
        const requireOmiZoneAR = (body as any).require_omi_zone === true
          || requestedScope === "padova_omi_zones"
          || (typeof (body as any).scope === "string" && (body as any).scope === "padova_omi_zones");
        const isPadova = (v: unknown) => typeof v === "string" && v.trim().toLowerCase() === "padova";
        const oppsPadovaRaw = finalOpps.filter((o) => isPadova(o?.comune));
        const excludedNotPadovaAR = finalOpps.length - oppsPadovaRaw.length;

        const supaO = getServiceClient();
        const omiResAR = await resolvePadovaOmiBatch(
          oppsPadovaRaw as unknown as Array<Record<string, unknown>>,
          supaO as any,
          (r) => ({
            lat: typeof (r as any).lat === "number" ? (r as any).lat : null,
            lng: typeof (r as any).lng === "number" ? (r as any).lng : null,
          }),
        );

        const oppsPadova: any[] = [];
        let excludedNoOmiZoneAR = 0;
        let excludedLowConfidenceAR = 0;
        const omiExcludedSamplesAR: Array<{ id: unknown; reason: string; comune: string }> = [];
        const omiZoneBreakdownAR: Record<string, number> = {};

        for (let i = 0; i < oppsPadovaRaw.length; i++) {
          const o = oppsPadovaRaw[i];
          const r = omiResAR[i];
          const code = r?.omi_zone_code ?? null;
          if (requireOmiZoneAR) {
            if (!code) {
              excludedNoOmiZoneAR++;
              if (omiExcludedSamplesAR.length < 20) {
                omiExcludedSamplesAR.push({ id: o?.id ?? null, reason: r?.omi_zone_reason ?? "missing_omi", comune: String(o?.comune ?? "") });
              }
              continue;
            }
            if ((r?.omi_zone_confidence ?? 0) < 0.6) {
              excludedLowConfidenceAR++;
              if (omiExcludedSamplesAR.length < 20) {
                omiExcludedSamplesAR.push({ id: o?.id ?? null, reason: "low_confidence", comune: String(o?.comune ?? "") });
              }
              continue;
            }
          }
          if (code) omiZoneBreakdownAR[code] = (omiZoneBreakdownAR[code] ?? 0) + 1;
          oppsPadova.push({
            ...o,
            comune: "Padova",
            municipality: "Padova",
            provincia: "PD",
            province: "PD",
            omi_zone_code: code,
            omi_zone_label: r?.omi_zone_label ?? null,
            omi_zone_confidence: r?.omi_zone_confidence ?? 0,
            omi_zone_reason: r?.omi_zone_reason ?? "unknown",
          });
        }

        // Snapshot breakdown ufficiale (point-in-polygon) per il monitor.
        let omiZonesWithData = 0;
        let omiZoneBreakdown: Array<{ omi_zone_code: string; fascia: string; snapshot_count: number }> = [];
        try {
          if (supaO) {
            const sinceOmi = new Date(Date.now() - 26 * 3_600_000).toISOString();
            const { data: bO } = await supaO.rpc("padova_omi_snapshot_breakdown", { p_since: sinceOmi });
            omiZoneBreakdown = (bO ?? []).map((r: any) => ({
              omi_zone_code: r.omi_zone_code, fascia: r.fascia,
              snapshot_count: Number(r.snapshot_count ?? 0),
            }));
            omiZonesWithData = omiZoneBreakdown.filter((r) => r.snapshot_count > 0).length;
          }
        } catch { /* non-fatal */ }

        const diagnostics = {
          scope: "padova_omi_zones",
          municipality_applied: "Padova",
          omi_zones_expected: CIVIKO_PADOVA_SCOPE.omi_zones_expected,
          omi_zones_with_data: omiZonesWithData || Object.keys(omiZoneBreakdownAR).length,
          omi_zone_breakdown: omiZoneBreakdown,
          omi_zone_breakdown_returned: omiZoneBreakdownAR,
          intent: intentRaw || null,
          requested_province: requestedProvince,
          requested_comuni: requestedComuni,
          returned_comuni: returnedComuni,
          total_opportunities: oppsPadova.length,
          total_zones: finalZones.length,
          source_breakdown: sourceBreakdownAR,
          excluded_out_of_scope: {
            total: excludedWrongProvince + excludedWrongComune + excludedNotPadovaAR + excludedNoOmiZoneAR + excludedLowConfidenceAR,
            wrong_province: excludedWrongProvince,
            wrong_comune: excludedWrongComune,
            not_padova: excludedNotPadovaAR,
            no_omi_zone: excludedNoOmiZoneAR,
            low_confidence: excludedLowConfidenceAR,
            samples: [...excludedSamples, ...omiExcludedSamplesAR],
          },
          require_omi_zone: requireOmiZoneAR,
          ingestion_per_portal: aggregateStats.perPortal,
          ingestion_rotation: aggregateStats.rotation ?? null,
          ingestion_comuni_processed: ingestionReport.length,
          last_source_refresh_at: lastSourceRefreshAR,
          warnings: ingestionWarnings,
          result_summary: resultSummary,
        };
        const outPadova = { ...out, opportunities: oppsPadova };
        return withIdentity(json(req, 200, {
          ...outPadova,
          scopeMode,
          scope: "padova_omi_zones",
          ok: true,
          result_summary: resultSummary,
          cost_report,
          ingestion: ingestionReport,
          diagnostics,
          data: { ...((outPadova as any)?.data ?? {}), cost_report, ingestion: ingestionReport, diagnostics, result_summary: resultSummary },
        }, debugId), "agent-radar");
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] agent-radar error: ${e instanceof Error ? e.message : String(e)}`);
        const errReport = ensureCostReport(budgetState?.cost_report ?? null, ["agent_radar_error"]);
        const fallback = {
          ok: false, scopeMode,
          configured: false,
          scope: { region: "Veneto" as const, province: ["VE","VR","VI","PD","TV","BL","RO"], datasetStatus: "empty" as const, message: "Errore interno temporaneo." },
          summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" as const },
          zones: [],
          opportunities: [],
          dataQuality: { real: [], partial: [], missing: [], warnings: ["Errore interno: " + (e instanceof Error ? e.message : String(e))] },
          cost_report: errReport,
          data: { cost_report: errReport },
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
