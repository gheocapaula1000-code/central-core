// Sottra — Motore Forecast handlers (6 endpoints)

import { ok, fail } from "../_shared/http.ts";
import { callAI, parseJSON, reverseGeocode } from "./shared.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

/** Extract comune name from address (same logic as omi-lookup) */
function extractComune(address: string): string {
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? "";
  return last.replace(/\s+[A-Z]{2}$/, "").trim();
}

// ═══════════════════════════════════════════════════════════════
// AI-BASED ENDPOINTS (sourceType: "estimate")
// ═══════════════════════════════════════════════════════════════

/** POST /sottra/forecast/moodscore — coordinates → zone sentiment score */
export async function handleForecastMoodScore(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un analista urbano italiano. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), calcola un MoodScore da 0 a 100 che rappresenta la qualità percepita del quartiere.

Rispondi SOLO in JSON valido:
{
  "score": numero_da_0_a_100,
  "trend": "in crescita" oppure "stabile" oppure "in calo",
  "categorie": {
    "commercio": punteggio_0_100,
    "trasporti": punteggio_0_100,
    "verde": punteggio_0_100,
    "sicurezza": punteggio_0_100,
    "socialLife": punteggio_0_100
  }
}

Valuta basandoti su: densità negozi e servizi (commercio), accessibilità trasporto pubblico e metro (trasporti), parchi e aree verdi (verde), percezione sicurezza della zona (sicurezza), vita sociale e locali (socialLife). Lo score principale è la media pesata.`;

  try {
    const output = await callAI(prompt, 300, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse moodscore data", debugId);
    return ok(req, {
      ...data,
      sourceLabel: "Stima indicativa",
      sourceType: "estimate",
      sourcePeriod: null,
      confidenceReason: "Valutazione basata su conoscenza generale della zona",
      limitations: ["Non basato su dati ufficiali", "Punteggi soggettivi e non verificabili"],
    }, ["Stima indicativa — non dato ufficiale"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `MoodScore analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/timeview — coordinates → scenario medio periodo basato su dati reali */
export async function handleForecastTimeView(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  if (!comune) return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);

  const supabase = getSupabase();

  // Parallel queries: OMI, ISTAT, ISPRA, Sismica
  const [omiResult, istatResult, ispraResult, sismicaResult] = await Promise.all([
    supabase.from("omi_valori").select("compr_min, compr_max, loc_min, loc_max, descr_tipologia, zona, stato_prev").ilike("comune_descrizione", comune.toUpperCase()).eq("descr_tipologia", "Abitazioni civili").limit(10),
    supabase.from("istat_comuni").select("*").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("ispra_rischio").select("idro_p3_perc, frana_p4_perc, superficie_kmq").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("classificazione_sismica").select("zona_sismica").ilike("comune", comune).limit(1).maybeSingle(),
  ]);

  const sourcesUsed: string[] = [];
  const limitations: string[] = [];
  const drivers: { label: string; direction: "positivo" | "negativo" | "neutro"; source: string }[] = [];
  const risks: { label: string; severity: "alto" | "medio" | "basso"; source: string }[] = [];

  // OMI market trend signals
  const omiRows = omiResult.data ?? [];
  const hasOMI = omiRows.length > 0;
  if (hasOMI) {
    sourcesUsed.push("OMI 2025/1");
    const statoPrev = omiRows.map(r => r.stato_prev).filter(Boolean);
    const crescita = statoPrev.filter(s => /crescita|aumento|rialzo/i.test(s ?? "")).length;
    const calo = statoPrev.filter(s => /calo|ribasso|diminuzione|flessione/i.test(s ?? "")).length;
    if (crescita > calo) {
      drivers.push({ label: "Mercato OMI in fase di crescita nella zona", direction: "positivo", source: "OMI 2025/1" });
    } else if (calo > crescita) {
      drivers.push({ label: "Mercato OMI in fase di contrazione nella zona", direction: "negativo", source: "OMI 2025/1" });
    } else {
      drivers.push({ label: "Mercato OMI stabile nella zona", direction: "neutro", source: "OMI 2025/1" });
    }
  } else {
    limitations.push("Dati OMI non disponibili per questo comune — scenario basato su indicatori parziali");
  }

  // Demographic drivers
  if (istatResult.data) {
    sourcesUsed.push("ISTAT 2025");
    const istat = istatResult.data;
    const under35 = Number(istat.percentuale_under35 ?? 0);
    const over65 = Number(istat.percentuale_over65 ?? 0);
    const pop = Number(istat.popolazione ?? 0);

    if (under35 > 35) {
      drivers.push({ label: `Popolazione giovane sopra la media (under 35: ${under35.toFixed(1)}%)`, direction: "positivo", source: "ISTAT 2025" });
    } else if (over65 > 30) {
      drivers.push({ label: `Invecchiamento significativo (over 65: ${over65.toFixed(1)}%)`, direction: "negativo", source: "ISTAT 2025" });
    } else {
      drivers.push({ label: "Struttura demografica nella media nazionale", direction: "neutro", source: "ISTAT 2025" });
    }
    if (pop > 100_000) {
      drivers.push({ label: `Centro urbano rilevante (${pop.toLocaleString("it-IT")} ab.)`, direction: "positivo", source: "ISTAT 2025" });
    }
  } else {
    limitations.push("Dati demografici ISTAT non disponibili per questo comune");
  }

  // Risk factors
  if (ispraResult.data) {
    sourcesUsed.push("ISPRA 2021");
    const idro = Number(ispraResult.data.idro_p3_perc ?? 0);
    const frana = Number(ispraResult.data.frana_p4_perc ?? 0);
    if (idro > 10 || frana > 10) {
      risks.push({ label: "Rischio idrogeologico elevato nella zona", severity: "alto", source: "ISPRA 2021" });
    } else if (idro > 1 || frana > 1) {
      risks.push({ label: "Rischio idrogeologico moderato", severity: "medio", source: "ISPRA 2021" });
    }
  }

  if (sismicaResult.data) {
    sourcesUsed.push("OPCM 3519/2006");
    const zona = sismicaResult.data.zona_sismica;
    if (zona === 1) risks.push({ label: "Zona sismica 1 — rischio molto elevato", severity: "alto", source: "OPCM 3519" });
    else if (zona === 2) risks.push({ label: "Zona sismica 2 — rischio rilevante", severity: "medio", source: "OPCM 3519" });
  }

  // Compute scenario band
  const positiveDrivers = drivers.filter(d => d.direction === "positivo").length;
  const negativeDrivers = drivers.filter(d => d.direction === "negativo").length;
  const highRisks = risks.filter(r => r.severity === "alto").length;

  let scenarioBand: string;
  if (positiveDrivers >= 3 && highRisks === 0) scenarioBand = "favorevole";
  else if (positiveDrivers > negativeDrivers && highRisks === 0) scenarioBand = "moderatamente_favorevole";
  else if (highRisks > 0 || negativeDrivers > positiveDrivers) scenarioBand = "da_monitorare";
  else scenarioBand = "stabile";

  // Narrative
  const dataPoints = sourcesUsed.length;
  let narrativeObservation: string;
  if (dataPoints < 2) {
    narrativeObservation = "Dati insufficienti per una valutazione di scenario articolata — quadro parziale";
  } else if (scenarioBand === "favorevole") {
    narrativeObservation = "I dati pubblici disponibili delineano un contesto con fattori convergenti positivi nel breve-medio periodo";
  } else if (scenarioBand === "moderatamente_favorevole") {
    narrativeObservation = "Contesto con elementi positivi prevalenti, bilanciati da fattori da approfondire";
  } else if (scenarioBand === "da_monitorare") {
    narrativeObservation = "Presenza di fattori di rischio o segnali negativi — scenario che richiede attenzione";
  } else {
    narrativeObservation = "Quadro sostanzialmente stabile — nessun segnale particolarmente marcato in una direzione";
  }

  limitations.push("Scenario basato su dati statici, non su serie storiche pluriennali");
  limitations.push("Non costituisce previsione di mercato né consulenza finanziaria");
  limitations.push("Orizzonte limitato a 3-5 anni — proiezioni a lungo termine non supportate dai dati disponibili");

  return ok(req, {
    comune,
    scenarioBand,
    scenarioHorizon: "3-5 anni",
    scenarioDrivers: drivers,
    scenarioRisks: risks,
    narrativeObservation,
    omiZonesAnalyzed: omiRows.length,
    sourceLabel: sourcesUsed.join(" + "),
    sourceType: dataPoints >= 2 ? "elaborated" : "unavailable",
    sourcePeriod: "Dati aggregati multi-fonte — marzo 2026",
    confidenceReason: dataPoints >= 3
      ? "Scenario costruito su dati ufficiali ISTAT, ISPRA, OMI e classificazione sismica"
      : `Scenario parziale — disponibili solo ${dataPoints} fonti su 4`,
    limitations,
  }, [], debugId);
}

/** POST /sottra/forecast/opportunity — coordinates → indice opportunità basato su dati reali */
export async function handleForecastOpportunity(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  if (!comune) return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);

  const supabase = getSupabase();

  // Parallel queries
  const [omiResult, istatResult, ispraResult, sismicaResult] = await Promise.all([
    supabase.from("omi_valori").select("compr_min, compr_max, loc_min, loc_max, descr_tipologia, zona, stato_prev").ilike("comune_descrizione", comune.toUpperCase()).eq("descr_tipologia", "Abitazioni civili").limit(20),
    supabase.from("istat_comuni").select("popolazione, eta_media, percentuale_under35, percentuale_over65").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("ispra_rischio").select("idro_p3_perc, frana_p4_perc, superficie_kmq").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("classificazione_sismica").select("zona_sismica").ilike("comune", comune).limit(1).maybeSingle(),
  ]);

  const sourcesUsed: string[] = [];
  const limitations: string[] = [];
  const drivers: { label: string; impact: "positivo" | "negativo" | "neutro"; weight: number; source: string }[] = [];
  let score = 50; // baseline

  // ── OMI pricing attractiveness ──
  const omiRows = omiResult.data ?? [];
  if (omiRows.length > 0) {
    sourcesUsed.push("OMI 2025/1");
    const avgPrice = omiRows.reduce((sum, r) => sum + ((Number(r.compr_min ?? 0) + Number(r.compr_max ?? 0)) / 2), 0) / omiRows.length;
    const avgRent = omiRows.reduce((sum, r) => sum + ((Number(r.loc_min ?? 0) + Number(r.loc_max ?? 0)) / 2), 0) / omiRows.length;

    // Yield indicator: annual rent / price (rough)
    const yieldPct = avgPrice > 0 && avgRent > 0 ? (avgRent * 12 / avgPrice) * 100 : 0;

    if (yieldPct > 6) {
      score += 12;
      drivers.push({ label: `Rendimento lordo indicativo elevato (${yieldPct.toFixed(1)}%)`, impact: "positivo", weight: 12, source: "OMI 2025/1" });
    } else if (yieldPct > 4) {
      score += 6;
      drivers.push({ label: `Rendimento lordo indicativo nella media (${yieldPct.toFixed(1)}%)`, impact: "positivo", weight: 6, source: "OMI 2025/1" });
    } else if (yieldPct > 0) {
      score -= 3;
      drivers.push({ label: `Rendimento lordo indicativo contenuto (${yieldPct.toFixed(1)}%)`, impact: "negativo", weight: -3, source: "OMI 2025/1" });
    }

    // Market trend from stato_prev
    const trends = omiRows.map(r => r.stato_prev).filter(Boolean);
    const crescita = trends.filter(s => /crescita|aumento|rialzo/i.test(s ?? "")).length;
    const calo = trends.filter(s => /calo|ribasso|diminuzione|flessione/i.test(s ?? "")).length;
    if (crescita > calo) {
      score += 8;
      drivers.push({ label: "Trend di mercato OMI in crescita", impact: "positivo", weight: 8, source: "OMI 2025/1" });
    } else if (calo > crescita) {
      score -= 8;
      drivers.push({ label: "Trend di mercato OMI in contrazione", impact: "negativo", weight: -8, source: "OMI 2025/1" });
    }

    // Zone diversity (more zones = more active market)
    const uniqueZones = new Set(omiRows.map(r => r.zona)).size;
    if (uniqueZones >= 5) {
      score += 5;
      drivers.push({ label: `Mercato articolato su ${uniqueZones} zone OMI`, impact: "positivo", weight: 5, source: "OMI 2025/1" });
    }
  } else {
    limitations.push("Dati OMI non disponibili — indice calcolato senza indicatori di mercato");
  }

  // ── Demographics ──
  if (istatResult.data) {
    sourcesUsed.push("ISTAT 2025");
    const under35 = Number(istatResult.data.percentuale_under35 ?? 0);
    const over65 = Number(istatResult.data.percentuale_over65 ?? 0);
    const pop = Number(istatResult.data.popolazione ?? 0);

    if (under35 > 35) {
      score += 6;
      drivers.push({ label: `Popolazione giovane sopra la media (${under35.toFixed(1)}% under 35)`, impact: "positivo", weight: 6, source: "ISTAT 2025" });
    }
    if (over65 > 30) {
      score -= 4;
      drivers.push({ label: `Invecchiamento rilevante (${over65.toFixed(1)}% over 65)`, impact: "negativo", weight: -4, source: "ISTAT 2025" });
    }
    if (pop > 50_000) {
      score += 3;
      drivers.push({ label: `Bacino urbano significativo (${pop.toLocaleString("it-IT")} ab.)`, impact: "positivo", weight: 3, source: "ISTAT 2025" });
    }
  } else {
    limitations.push("Dati demografici ISTAT non disponibili");
  }

  // ── Risk factors ──
  if (ispraResult.data) {
    sourcesUsed.push("ISPRA 2021");
    const idro = Number(ispraResult.data.idro_p3_perc ?? 0);
    const frana = Number(ispraResult.data.frana_p4_perc ?? 0);
    if (idro > 10 || frana > 10) {
      score -= 12;
      drivers.push({ label: "Rischio idrogeologico elevato", impact: "negativo", weight: -12, source: "ISPRA 2021" });
    } else if (idro < 1 && frana < 1) {
      score += 5;
      drivers.push({ label: "Basso rischio idrogeologico", impact: "positivo", weight: 5, source: "ISPRA 2021" });
    }
  }

  if (sismicaResult.data) {
    sourcesUsed.push("OPCM 3519/2006");
    const zona = sismicaResult.data.zona_sismica;
    if (zona === 1) {
      score -= 10;
      drivers.push({ label: "Zona sismica 1 — rischio molto elevato", impact: "negativo", weight: -10, source: "OPCM 3519" });
    } else if (zona === 4) {
      score += 4;
      drivers.push({ label: "Zona sismica 4 — rischio basso", impact: "positivo", weight: 4, source: "OPCM 3519" });
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Band
  let band: string;
  if (score >= 70) band = "molto_forte";
  else if (score >= 55) band = "forte";
  else if (score >= 40) band = "interessante";
  else band = "limitata";

  // Observation
  const dataPoints = sourcesUsed.length;
  let observation: string;
  if (dataPoints < 2) {
    observation = "Dati insufficienti per una valutazione articolata — quadro parziale da integrare";
  } else if (band === "molto_forte") {
    observation = "Quadro favorevole con segnali convergenti da approfondire — contesto meritevole di analisi";
  } else if (band === "forte") {
    observation = "Segnali convergenti da non sottovalutare — contesto interessante da monitorare";
  } else if (band === "interessante") {
    observation = "Contesto interessante ma con fattori da monitorare attentamente";
  } else {
    observation = "Potenziale presente con elementi di cautela — approfondimento consigliato";
  }

  limitations.push("Indice sintetico proprietario — non è un indicatore ufficiale di mercato");
  limitations.push("Non costituisce raccomandazione di investimento né consulenza finanziaria");
  limitations.push("Rendimenti indicativi calcolati su valori OMI medi, non su immobili specifici");

  return ok(req, {
    comune,
    score,
    band,
    drivers,
    observation,
    omiZonesAnalyzed: omiRows.length,
    sourceLabel: sourcesUsed.join(" + "),
    sourceType: dataPoints >= 2 ? "elaborated" : "unavailable",
    sourcePeriod: "Dati aggregati multi-fonte — marzo 2026",
    confidenceReason: dataPoints >= 3
      ? "Indice costruito su dati ufficiali OMI, ISTAT, ISPRA e classificazione sismica"
      : `Indice parziale — disponibili solo ${dataPoints} fonti su 4`,
    limitations,
  }, [], debugId);
}

/** POST /sottra/forecast/infrastrutture — coordinates → infrastructure projects */
export async function handleForecastInfrastrutture(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un urbanista italiano esperto di infrastrutture. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), elenca i progetti infrastrutturali in corso o approvati.

Rispondi SOLO in JSON valido:
{
  "progetti": [
    {
      "nome": "nome del progetto",
      "tipo": "metro" oppure "tram" oppure "ciclabile" oppure "strada" oppure "edificio_pubblico" oppure "parco" oppure "altro",
      "stato": "approvato" oppure "in_costruzione" oppure "completato",
      "completamentoPrevisto": "YYYY-MM",
      "distanzaKm": distanza_dal_punto_in_km
    }
  ],
  "cantieriAperti": numero_cantieri_nella_zona,
  "impattoStimato": "alto" oppure "medio" oppure "basso"
}

Includi solo progetti reali e realistici per quella specifica città e zona. Considera: estensioni metro/tram, nuove piste ciclabili, riqualificazioni urbane, nuovi parchi, grandi opere stradali.

IMPORTANTE: Includi SOLO progetti entro 3 km dal punto indicato. Non includere progetti di altre zone della città.
La data corrente è marzo 2026. Non includere progetti già completati o con date nel passato.`;

  try {
    const output = await callAI(prompt, 500, 0.3);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse infrastructure data", debugId);
    return ok(req, {
      ...data,
      sourceLabel: "Stima indicativa",
      sourceType: "estimate",
      sourcePeriod: null,
      confidenceReason: "Elenco basato su conoscenza generale di progetti pubblici noti",
      limitations: ["Non basato su dataset ufficiale dei cantieri", "Distanze e date approssimative"],
    }, ["Stima indicativa — non dato ufficiale"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Infrastructure analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

// ═══════════════════════════════════════════════════════════════
// DATA-DRIVEN ENDPOINTS (real ISTAT / ISPRA / INGV data)
// ═══════════════════════════════════════════════════════════════

/** POST /sottra/forecast/rischio-zona — coordinates → zone risk assessment (REAL ISPRA + SISMICA DATA) */
export async function handleForecastRischioZona(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  if (!comune) return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);

  const supabase = getSupabase();

  // Parallel queries: ISPRA + Sismica
  const [ispraResult, sismicaResult] = await Promise.all([
    supabase.from("ispra_rischio").select("*").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("classificazione_sismica").select("zona_sismica").ilike("comune", comune).limit(1).maybeSingle(),
  ]);

  if (ispraResult.error || !ispraResult.data) {
    return ok(req, {
      idrogeologico: "dato non disponibile",
      sismico: "dato non disponibile",
      inquinamento: "dato non disponibile",
      alluvionale: null,
      scoreRischio: null,
      dettaglioISPRA: null,
      sourceLabel: "ISPRA — IdroGEO + INGV/Protezione Civile OPCM 3519",
      sourceType: "unavailable",
      sourcePeriod: null,
      confidenceReason: `Nessun dato ISPRA trovato per il comune "${comune}"`,
      limitations: [`Comune "${comune}" non presente nel dataset ISPRA importato`],
    }, [`Dati ISPRA non disponibili per il comune "${comune}"`], debugId);
  }

  const data = ispraResult.data;
  const idroP3 = Number(data.idro_p3_perc) || 0;
  const franaP4 = Number(data.frana_p4_perc) || 0;

  // scoreRischio = 100 - (idro_p3_perc * 2 + frana_p4_perc * 3) clamped 0-100
  const rawScore = 100 - (idroP3 * 2 + franaP4 * 3);
  const scoreRischio = Math.round(Math.max(0, Math.min(100, rawScore)));

  // Classify idrogeologico risk level based on idro_p3_perc
  const idrogeologico = idroP3 > 10 ? "alto" : idroP3 >= 1 ? "medio" : idroP3 > 0 ? "basso" : "nullo";

  // Alluvionale: true if any idro_p3 > 0
  const alluvionale = idroP3 > 0;

  // Sismico from classificazione_sismica table
  const zonaSismica = sismicaResult.data?.zona_sismica;
  const sismico = zonaSismica != null ? `zona${zonaSismica}` : "dato non disponibile";

  const limitations: string[] = [];
  limitations.push("Dati di rischio idrogeologico a livello comunale (non sub-comunale)");
  if (zonaSismica == null) limitations.push(`Classificazione sismica non disponibile per "${comune}"`);
  limitations.push("Dati di inquinamento/qualità aria non disponibili (fonti ARPA non integrate)");

  return ok(req, {
    idrogeologico,
    sismico,
    inquinamento: "dato non disponibile",
    alluvionale,
    scoreRischio,
    dettaglioISPRA: {
      superficie_kmq: data.superficie_kmq,
      idro_p3_perc: data.idro_p3_perc,
      idro_p2_perc: data.idro_p2_perc,
      idro_p1_perc: data.idro_p1_perc,
      pop_idro_p3: data.pop_idro_p3,
      pop_idro_p2: data.pop_idro_p2,
      pop_idro_p1: data.pop_idro_p1,
      frana_p4_perc: data.frana_p4_perc,
      frana_p3_perc: data.frana_p3_perc,
      frana_p2_perc: data.frana_p2_perc,
      frana_p1_perc: data.frana_p1_perc,
      pop_frana_p3p4: data.pop_frana_p3p4,
    },
    sourceLabel: "ISPRA — IdroGEO + INGV/Protezione Civile OPCM 3519",
      sourceType: "official",
      sourcePeriod: "ISPRA ed. 2021 + OPCM 3519/2006",
    confidenceReason: "Dati ufficiali ISPRA e classificazione sismica INGV/Protezione Civile importati da dataset pubblici",
    limitations,
  }, [], debugId);
}

/** POST /sottra/forecast/trend-demografico — coordinates → demographic trends (REAL ISTAT DATA) */
export async function handleForecastTrendDemografico(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  if (!comune) return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);

  const supabase = getSupabase();

  // Parallel queries: ISTAT + ISPRA (for superficie/density)
  const [istatResult, ispraResult] = await Promise.all([
    supabase.from("istat_comuni").select("*").ilike("comune", comune).limit(1).maybeSingle(),
    supabase.from("ispra_rischio").select("superficie_kmq").ilike("comune", comune).limit(1).maybeSingle(),
  ]);

  if (istatResult.error || !istatResult.data) {
    return ok(req, {
      etaMedia: null,
      popolazione: null,
      densitaAbitanti: null,
      flussoResidenti12Mesi: null,
      percentualeFamiglie: null,
      percentualeGiovani: null,
      percentualeStranieri: null,
      percentualeUnder18: null,
      percentualeOver65: null,
      maschi: null,
      femmine: null,
      anno: null,
      sourceLabel: "ISTAT — Popolazione residente al 1° gennaio 2025",
      sourceType: "unavailable",
      sourcePeriod: null,
      confidenceReason: `Nessun dato ISTAT trovato per il comune "${comune}"`,
      limitations: [`Comune "${comune}" non presente nel dataset ISTAT importato`],
    }, [`Dati ISTAT non disponibili per il comune "${comune}"`], debugId);
  }

  const istat = istatResult.data;

  // Compute density using ISPRA superficie
  let densitaAbitanti: number | null = null;
  if (ispraResult.data?.superficie_kmq && istat.popolazione) {
    densitaAbitanti = Math.round(Number(istat.popolazione) / Number(ispraResult.data.superficie_kmq));
  }

  const limitations: string[] = [];
  limitations.push("Dati a livello comunale (non sub-comunale o di quartiere)");
  limitations.push("Flusso residenti, percentuale famiglie e percentuale stranieri non disponibili nel dataset importato");
  if (!densitaAbitanti) limitations.push("Densità non calcolabile: superficie ISPRA non disponibile per questo comune");

  return ok(req, {
    etaMedia: istat.eta_media,
    popolazione: istat.popolazione,
    densitaAbitanti,
    flussoResidenti12Mesi: null,
    percentualeFamiglie: null,
    percentualeGiovani: istat.percentuale_under35,
    percentualeStranieri: null,
    percentualeUnder18: istat.percentuale_under18,
    percentualeOver65: istat.percentuale_over65,
    maschi: istat.maschi,
    femmine: istat.femmine,
    anno: istat.anno,
    sourceLabel: "ISTAT — Popolazione residente al 1° gennaio 2025",
      sourceType: "official",
      sourcePeriod: `Anno ${istat.anno ?? 2025}`,
    confidenceReason: "Dati ufficiali ISTAT importati da dataset pubblico I.Stat",
    limitations,
  }, [], debugId);
}
