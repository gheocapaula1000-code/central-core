// Sottra — Motore Forecast: Sviluppo Area
// Aggregates real public data sources for territorial development signals

import { ok, fail } from "../_shared/http.ts";
import { reverseGeocode, withAbort, normalizeWithGPT } from "./shared.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Helpers ──

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

function extractComune(address: string): string {
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? "";
  return last.replace(/\s+[A-Z]{2}$/, "").trim();
}

function extractProvincia(address: string): string {
  const match = address.match(/\b([A-Z]{2})\b/);
  return match?.[1] ?? "";
}

// ── Source adapters ──

interface DevelopmentSignal {
  source: string;
  type: string;
  title: string;
  status: string | null;
  value: string | null;
  relevance: "high" | "medium" | "low";
}

/** OpenCoesione — public cohesion projects API */
async function fetchOpenCoesione(comune: string, _lat: number, _lng: number): Promise<{
  signals: DevelopmentSignal[];
  raw: unknown;
  available: boolean;
  error?: string;
}> {
  // OpenCoesione API: https://opencoesione.gov.it/it/api/
  // Search projects by territory name
  const encodedComune = encodeURIComponent(comune);
  const url = `https://opencoesione.gov.it/it/api/progetti.json?territorio_txt=${encodedComune}&ordinamento=-costo_rendicontabile_totale&q_limit=10`;

  const { signal, clear } = withAbort(10_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Sottra/1.0 (sottra.app)" },
      signal,
    });
    if (!res.ok) {
      return { signals: [], raw: null, available: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const results = data?.results ?? data?.progetti ?? [];

    if (!Array.isArray(results) || results.length === 0) {
      return { signals: [], raw: data, available: true };
    }

    const signals: DevelopmentSignal[] = results.slice(0, 8).map((p: Record<string, unknown>) => ({
      source: "OpenCoesione",
      type: "public_investment",
      title: (p.titolo_progetto ?? p.oc_titolo_progetto ?? p.titolo ?? "Progetto senza titolo") as string,
      status: (p.stato_progetto ?? p.stato ?? null) as string | null,
      value: p.costo_rendicontabile_totale
        ? `€ ${Number(p.costo_rendicontabile_totale).toLocaleString("it-IT")}`
        : null,
      relevance: Number(p.costo_rendicontabile_totale ?? 0) > 1_000_000 ? "high" : "medium" as const,
    }));

    return { signals, raw: { count: results.length, sample: results.slice(0, 3) }, available: true };
  } catch (e) {
    return { signals: [], raw: null, available: false, error: String(e).slice(0, 120) };
  } finally {
    clear();
  }
}

/** Infratel / BUL — broadband coverage signals */
async function fetchInfratel(comune: string): Promise<{
  signals: DevelopmentSignal[];
  connectivity: Record<string, unknown> | null;
  available: boolean;
  error?: string;
}> {
  // Infratel BandaUltraLarga.italia.it — public API
  const encodedComune = encodeURIComponent(comune.toUpperCase());
  const url = `https://bandaultralarga.italia.it/wp-json/jesuspended/v1/comuni?comune=${encodedComune}`;

  const { signal, clear } = withAbort(8_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Sottra/1.0 (sottra.app)" },
      signal,
    });
    if (!res.ok) {
      return { signals: [], connectivity: null, available: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data : data?.data ? (Array.isArray(data.data) ? data.data : [data.data]) : [];

    if (results.length === 0) {
      return { signals: [], connectivity: null, available: false, error: "No data for comune" };
    }

    const entry = results[0] as Record<string, unknown>;
    const signals: DevelopmentSignal[] = [];

    // Check for FTTH/FWA coverage info
    const ftth = entry.ftth ?? entry.copertura_ftth ?? entry.fibra;
    const fwa = entry.fwa ?? entry.copertura_fwa;
    const stato = entry.stato_intervento ?? entry.stato ?? entry.status;

    if (ftth || fwa || stato) {
      signals.push({
        source: "Infratel/BUL",
        type: "connectivity",
        title: `Copertura banda ultralarga — ${comune}`,
        status: stato ? String(stato) : null,
        value: ftth ? `FTTH: ${ftth}` : fwa ? `FWA: ${fwa}` : null,
        relevance: "high",
      });
    }

    return {
      signals,
      connectivity: {
        ftth: ftth ?? null,
        fwa: fwa ?? null,
        stato: stato ?? null,
        raw: entry,
      },
      available: true,
    };
  } catch (e) {
    return { signals: [], connectivity: null, available: false, error: String(e).slice(0, 120) };
  } finally {
    clear();
  }
}

/** MIT Cantieri — Osserva Cantieri (best effort, may not be queryable) */
async function fetchMITCantieri(comune: string, _provincia: string): Promise<{
  signals: DevelopmentSignal[];
  available: boolean;
  error?: string;
}> {
  // MIT Servizio Contratti Pubblici / ANAC OpenData (fallback)
  // Try ANAC open data for public contracts in the area
  const encodedComune = encodeURIComponent(comune);
  const url = `https://dati.anticorruzione.it/opendata/dataset/contrattipubblici/resource/contrattipubblici/download/contrattipubblici.json?q=${encodedComune}&limit=5`;

  const { signal, clear } = withAbort(8_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Sottra/1.0 (sottra.app)" },
      signal,
    });

    if (!res.ok) {
      // Expected — this endpoint may not be stable
      return { signals: [], available: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const results = Array.isArray(data) ? data : data?.results ?? [];

    const signals: DevelopmentSignal[] = results.slice(0, 5).map((c: Record<string, unknown>) => ({
      source: "MIT/ANAC",
      type: "public_works",
      title: (c.oggetto ?? c.descrizione ?? "Opera pubblica") as string,
      status: (c.stato ?? null) as string | null,
      value: c.importo ? `€ ${Number(c.importo).toLocaleString("it-IT")}` : null,
      relevance: "medium" as const,
    }));

    return { signals, available: signals.length > 0 };
  } catch (e) {
    return { signals: [], available: false, error: String(e).slice(0, 120) };
  } finally {
    clear();
  }
}

/** Local DB data enrichment (ISTAT demographics + ISPRA risk + OMI values) */
async function fetchLocalDBSignals(comune: string): Promise<{
  signals: DevelopmentSignal[];
  demographics: Record<string, unknown> | null;
  risk: Record<string, unknown> | null;
  omiPresent: boolean;
}> {
  const supabase = getSupabase();
  const signals: DevelopmentSignal[] = [];

  const [istatRes, ispraRes, omiRes] = await Promise.all([
    supabase.from("istat_comuni").select("popolazione, eta_media, percentuale_under35, percentuale_over65").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("ispra_rischio").select("idro_p3_perc, frana_p4_perc, superficie_kmq").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("omi_valori").select("compr_min, compr_max, zona").ilike("comune_descrizione", comune.toUpperCase()).limit(3),
  ]);

  let demographics: Record<string, unknown> | null = null;
  if (istatRes.data) {
    demographics = istatRes.data as Record<string, unknown>;
    const under35 = Number(istatRes.data.percentuale_under35 ?? 0);
    if (under35 > 35) {
      signals.push({
        source: "ISTAT 2025",
        type: "demographic",
        title: `Alta percentuale popolazione giovane (under 35: ${under35.toFixed(1)}%)`,
        status: "attivo",
        value: `${under35.toFixed(1)}%`,
        relevance: "medium",
      });
    }
    const pop = Number(istatRes.data.popolazione ?? 0);
    if (pop > 50_000) {
      signals.push({
        source: "ISTAT 2025",
        type: "demographic",
        title: `Centro urbano significativo (${pop.toLocaleString("it-IT")} abitanti)`,
        status: "attivo",
        value: pop.toLocaleString("it-IT"),
        relevance: "low",
      });
    }
  }

  let risk: Record<string, unknown> | null = null;
  if (ispraRes.data) {
    risk = ispraRes.data as Record<string, unknown>;
    const idro = Number(ispraRes.data.idro_p3_perc ?? 0);
    const frana = Number(ispraRes.data.frana_p4_perc ?? 0);
    if (idro < 1 && frana < 1) {
      signals.push({
        source: "ISPRA 2021",
        type: "environmental",
        title: "Basso rischio idrogeologico e frane nella zona",
        status: "favorevole",
        value: null,
        relevance: "medium",
      });
    }
  }

  const omiPresent = (omiRes.data?.length ?? 0) > 0;
  if (omiPresent) {
    signals.push({
      source: "OMI 2025/1",
      type: "market",
      title: "Valori OMI disponibili — mercato immobiliare attivo",
      status: "attivo",
      value: null,
      relevance: "low",
    });
  }

  return { signals, demographics, risk, omiPresent };
}

// ── Scoring ──

interface ScoringResult {
  score: number;
  band: string;
  reason: string;
}

function computeDevelopmentScore(
  openCoesioneSignals: DevelopmentSignal[],
  infratelAvailable: boolean,
  infratelSignals: DevelopmentSignal[],
  mitSignals: DevelopmentSignal[],
  localSignals: DevelopmentSignal[],
): ScoringResult {
  let score = 30; // baseline

  // OpenCoesione projects weight
  const ocHigh = openCoesioneSignals.filter(s => s.relevance === "high").length;
  const ocMedium = openCoesioneSignals.filter(s => s.relevance === "medium").length;
  score += Math.min(ocHigh * 10, 25); // max +25
  score += Math.min(ocMedium * 3, 10); // max +10

  // Connectivity
  if (infratelSignals.length > 0) score += 10;
  else if (infratelAvailable) score += 3;

  // MIT/ANAC public works
  score += Math.min(mitSignals.length * 5, 10);

  // Local DB signals
  for (const s of localSignals) {
    if (s.relevance === "high") score += 5;
    else if (s.relevance === "medium") score += 3;
    else score += 1;
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  // Band
  let band: string;
  if (score >= 75) band = "molto alto";
  else if (score >= 55) band = "alto";
  else if (score >= 35) band = "medio";
  else band = "basso";

  // Narrative
  const totalSignals = openCoesioneSignals.length + infratelSignals.length + mitSignals.length + localSignals.length;
  let reason: string;
  if (score >= 75) {
    reason = "Area con segnali pubblici convergenti di trasformazione territoriale significativa";
  } else if (score >= 55) {
    reason = "Territorio interessato da fattori evolutivi rilevanti — contesto da monitorare";
  } else if (score >= 35) {
    reason = totalSignals > 0
      ? "Presenza di alcuni segnali di sviluppo — dinamica territoriale da approfondire"
      : "Contesto territoriale con indicatori nella media — pochi segnali pubblici rilevati";
  } else {
    reason = "Pochi segnali pubblici di trasformazione rilevati per questa zona";
  }

  return { score, band, reason };
}

// ── Main handler ──

export async function handleForecastSviluppoArea(
  req: Request,
  body: Record<string, unknown>,
  debugId: string,
): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) {
    return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);
  }

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  const provincia = extractProvincia(address);

  if (!comune) {
    return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);
  }

  console.log(`[sviluppo-area] comune=${comune} provincia=${provincia} debug_id=${debugId}`);

  // Parallel fetch all sources (including school data)
  const supabase = getSupabase();
  const [ocResult, infraResult, mitResult, localResult, schoolResult] = await Promise.all([
    fetchOpenCoesione(comune, lat, lng),
    fetchInfratel(comune),
    fetchMITCantieri(comune, provincia),
    fetchLocalDBSignals(comune),
    supabase.from("mim_schools").select("denominazione, grado, indirizzo, tipologia, lat, lng").ilike("comune", comune).limit(100),
  ]);

  // Compute score
  const scoring = computeDevelopmentScore(
    ocResult.signals,
    infraResult.available,
    infraResult.signals,
    mitResult.signals,
    localResult.signals,
  );

  // Build source tracking
  const sourcesUsed: string[] = [];
  const sourcesUnavailable: string[] = [];
  const limitations: string[] = [];

  if (ocResult.available) {
    sourcesUsed.push("OpenCoesione — Politiche di coesione");
  } else {
    sourcesUnavailable.push("OpenCoesione");
    limitations.push(`OpenCoesione non raggiungibile o senza dati per "${comune}": ${ocResult.error ?? "nessun risultato"}`);
  }

  if (infraResult.available) {
    sourcesUsed.push("Infratel — Piano BUL Banda Ultralarga");
  } else {
    sourcesUnavailable.push("Infratel/BUL");
    limitations.push(`Infratel BUL non raggiungibile o senza dati per "${comune}"`);
  }

  if (mitResult.available) {
    sourcesUsed.push("MIT/ANAC — Contratti pubblici");
  } else {
    sourcesUnavailable.push("MIT/ANAC Cantieri");
    limitations.push("Osserva Cantieri MIT / ANAC non raggiungibile o senza risultati per la zona");
  }

  // Local DB always available (but may be empty)
  sourcesUsed.push("ISTAT 2025, ISPRA 2021, OMI 2025/1 (database interno)");

  limitations.push("Indice sintetico proprietario — non è un indicatore ufficiale");
  limitations.push("I segnali riflettono dati pubblici disponibili, non coprono tutti i fattori di sviluppo");
  limitations.push("Copertura territoriale dipendente dalla disponibilità delle fonti per il comune specifico");

  const allSignals = [
    ...ocResult.signals,
    ...infraResult.signals,
    ...mitResult.signals,
    ...localResult.signals,
  ];

  let enrichedNarrative = scoring.reason;
  // GPT-5.4 normalization layer (optional — enriches narrative only)
  if (allSignals.length >= 2) {
    try {
      const norm = await normalizeWithGPT({
        module: "sviluppo-area",
        comune,
        collectedData: { score: scoring.score, band: scoring.band, signalCount: allSignals.length, sourcesUsed, sourcesUnavailable },
        requestedOutputs: ["observation"],
      });
      if (norm.normalized && norm.observation) {
        enrichedNarrative = norm.observation;
      }
    } catch { /* static fallback */ }
  }

  const warnings: string[] = [];
  if (sourcesUnavailable.length > 0) {
    warnings.push(`Fonti non disponibili: ${sourcesUnavailable.join(", ")}`);
  }

  // ── Build schoolContext from mim_schools data ──
  const schools = schoolResult.data ?? [];
  const schoolsByGrado: Record<string, number> = {};
  for (const s of schools) {
    const g = s.grado ?? "altro";
    schoolsByGrado[g] = (schoolsByGrado[g] ?? 0) + 1;
  }
  const schoolContext = schools.length > 0
    ? {
        available: true,
        totalSchools: schools.length,
        byGrado: schoolsByGrado,
        gradiPresenti: Object.keys(schoolsByGrado),
        nearestSchools: schools.slice(0, 5).map(s => ({
          denominazione: s.denominazione,
          grado: s.grado,
          indirizzo: s.indirizzo,
        })),
        precision: "comune" as const,
        source: "MIM — Ministero Istruzione e Merito (Open Data)",
        limitations: [
          "Conteggio a livello comunale, non per raggio dal civico",
          "Dataset soggetto ad aggiornamento annuale",
        ],
      }
    : {
        available: false,
        totalSchools: 0,
        byGrado: {},
        gradiPresenti: [],
        nearestSchools: [],
        precision: "comune" as const,
        source: null,
        limitations: [
          `Nessuna scuola trovata nel dataset MIM per il comune "${comune}"`,
          "Il dataset potrebbe non essere ancora importato per questo territorio",
        ],
      };

  if (schools.length > 0) {
    sourcesUsed.push("MIM — Open Data Scuole");
    // Schools boost score slightly
    if (schools.length >= 10) scoring.score = Math.min(100, scoring.score + 3);
  }

  return ok(req, {
    comune,
    address,
    developmentSignals: allSignals,
    infrastructureProjects: ocResult.signals.filter(s => s.type === "public_investment"),
    connectivitySignals: infraResult.signals,
    publicInvestmentSignals: [
      ...ocResult.signals,
      ...mitResult.signals,
    ],
    areaDevelopmentScore: scoring.score,
    areaDevelopmentBand: scoring.band,
    narrativeObservation: enrichedNarrative,
    schoolContext,
    sourcesQueried: {
      openCoesione: { available: ocResult.available, projectsFound: ocResult.signals.length },
      infratel: { available: infraResult.available, signalsFound: infraResult.signals.length },
      mitAnac: { available: mitResult.available, signalsFound: mitResult.signals.length },
      mim: { available: schools.length > 0, schoolsFound: schools.length },
      localDB: {
        istat: localResult.demographics != null,
        ispra: localResult.risk != null,
        omi: localResult.omiPresent,
      },
    },
    // Phase 2 placeholders (predisposed, not blocking)
    openDataComunali: { available: false, predisposed: true },
    alboPretorio: { available: false, predisposed: true },

    sourceLabel: sourcesUsed.length > 1 ? sourcesUsed.join(" + ") : sourcesUsed[0] ?? "Nessuna fonte esterna disponibile",
    sourceType: sourcesUsed.length >= 2 ? "elaborated" : "unavailable",
    sourcePeriod: "Dati aggregati multi-fonte — consultazione marzo 2026",
    confidenceReason: scoring.reason,
    limitations,
  }, warnings, debugId);
}
