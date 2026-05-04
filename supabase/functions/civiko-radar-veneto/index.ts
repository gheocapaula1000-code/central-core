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
];

interface RequestBody {
  address?: string;
  latitude?: number;
  longitude?: number;
  comune?: string;
  provincia?: string;
}

interface ZoneSignal {
  label: string;
  livello: "alto" | "medio" | "basso" | "non_disponibile";
  nota: string;
  fonte: string;
}

interface OffMarketOpportunity {
  tipo: "asta" | "ribasso" | "eredita" | "successione" | "luxury" | "terreno" | "commerciale" | "divorzio" | "confisca";
  titolo: string;
  descrizione: string;
  prezzoIndicativo?: string | null;
  scontoStimato?: string | null;
  localita?: string;
  fonte: string;
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
  return { label, livello: "non_disponibile", nota: "Riscontro non disponibile in questo momento.", fonte: "Fonte da Collegare" };
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
  return {
    sentiment: { label: "Sentiment di Zona", livello: sent.livello, nota: sent.nota, fonte: fonte(s1.length) },
    sicurezza: { label: "Sicurezza Percepita", livello: sec.livello, nota: sec.nota, fonte: fonte(s2.length) },
    rumore: { label: "Rumore Ambientale", livello: noise.livello, nota: noise.nota, fonte: fonte(s3.length) },
    qualitaAria: { label: "Qualità dell'Aria", livello: air.livello, nota: air.nota, fonte: fonte(s4.length) },
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
      out.push({
        tipo: block.tipo,
        titolo: it.title.slice(0, 200) || "Opportunità pubblica",
        descrizione: (it.description || "").slice(0, 320),
        fonte: "Rassegna pubblica",
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

  const [segnali, off, bandi] = await Promise.all([
    hasFirecrawl ? buildSentimentSignals(comune) : Promise.resolve(base.segnaliDiZona),
    hasFirecrawl ? buildOffMarket(comune, provincia, coords) : Promise.resolve([]),
    hasFirecrawl ? buildBandiNazionali(comune, provincia) : Promise.resolve([]),
  ]);

  const anySignal = Object.values(segnali).some((s) => s.livello !== "non_disponibile");
  const status: RadarResponse["status"] = (anySignal || off.length || bandi.length) ? (anySignal && off.length && bandi.length ? "ok" : "partial") : "unavailable";

  const out: any = {
    configured: hasFirecrawl,
    status,
    scope: { comune, provincia },
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
      segnaliDiZona: {
        sentiment: { label: "Sentiment di Zona", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare" },
        sicurezza: { label: "Sicurezza Percepita", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare" },
        rumore: { label: "Rumore Ambientale", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare" },
        qualitaAria: { label: "Qualità dell'Aria", livello: "non_disponibile", nota: "Errore interno temporaneo.", fonte: "Fonte da Collegare" },
      },
      opportunitaOffMarket: [], bandiRegionali: [],
      warnings: ["Errore interno temporaneo durante l'elaborazione."],
      updatedAt: new Date().toISOString(),
    });
    return withIdentity(json(req, 200, fallback, debugId), "error-fallback");
  }
});
