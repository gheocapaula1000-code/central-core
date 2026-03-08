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
    return ok(req, data, ["Score basato su analisi dati del quartiere"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `MoodScore analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/timeview — coordinates + horizon → projections */
export async function handleForecastTimeView(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un analista immobiliare e urbanistico italiano. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), prevedi l'evoluzione del valore immobiliare nei prossimi 5, 10 e 20 anni.

Rispondi SOLO in JSON valido:
{
  "previsione5Anni": percentuale_variazione_attesa,
  "previsione10Anni": percentuale_variazione_attesa,
  "previsione20Anni": percentuale_variazione_attesa,
  "progettiInArrivo": ["progetto 1 con anno", "progetto 2 con anno"]
}

Considera: piani urbanistici comunali, nuove infrastrutture di trasporto (metro, tram, ferrovie), riqualificazioni previste, trend demografici, effetti del cambiamento climatico sulla zona. I progetti devono essere realistici per quella specifica città/zona. Le percentuali possono essere negative se la zona è in declino.`;

  try {
    const output = await callAI(prompt, 400, 0.3);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse timeview data", debugId);
    return ok(req, data, ["Previsioni basate su dati urbanistici — non consulenza finanziaria"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `TimeView analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/opportunity — coordinates → opportunity index */
export async function handleForecastOpportunity(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un analista di opportunità immobiliari in Italia. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), calcola un Indice Opportunità da 0 a 100 e assegna un quadrante.

Rispondi SOLO in JSON valido:
{
  "indice": numero_da_0_a_100,
  "quadrante": "uno tra: Stella Nascente, Diamante Grezzo, Picco Raggiunto, Allerta Rossa",
  "raccomandazione": "frase di raccomandazione in italiano max 15 parole"
}

QUADRANTI:
- "Stella Nascente" (indice 70-100): zona in forte crescita, ottimo momento per comprare
- "Diamante Grezzo" (indice 50-69): zona sottovalutata con potenziale nascosto
- "Picco Raggiunto" (indice 30-49): zona ai massimi, crescita futura limitata
- "Allerta Rossa" (indice 0-29): zona in declino o sopravvalutata, rischio alto

Valuta: trend prezzi recenti, progetti infrastrutturali, demografia, attrattività commerciale, rapporto prezzo/qualità della zona.`;

  try {
    const output = await callAI(prompt, 300, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse opportunity data", debugId);
    return ok(req, data, ["Indice calcolato da analisi di mercato — non consulenza di investimento"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Opportunity analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
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
    return ok(req, data, ["Progetti basati su dati urbanistici pubblici"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Infrastructure analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/rischio-zona — coordinates → zone risk assessment (REAL ISPRA DATA) */
export async function handleForecastRischioZona(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const comune = extractComune(address);
  if (!comune) return fail(req, 400, "COMUNE_NOT_FOUND", "Could not extract comune from address", debugId);

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ispra_rischio")
    .select("*")
    .ilike("comune", comune)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return fail(req, 404, "DATA_NOT_FOUND", `No ISPRA data for comune "${comune}"`, debugId);
  }

  // scoreRischio = 100 - (idro_p3_perc * 2 + frana_p4_perc * 3) clamped 0-100
  const idroP3 = Number(data.idro_p3_perc) || 0;
  const franaP4 = Number(data.frana_p4_perc) || 0;
  const rawScore = 100 - (idroP3 * 2 + franaP4 * 3);
  const scoreRischio = Math.round(Math.max(0, Math.min(100, rawScore)));

  // Classify idrogeologico risk level
  const idroTotal = idroP3 + (Number(data.idro_p2_perc) || 0);
  const idrogeologico = idroTotal > 15 ? "alto" : idroTotal > 5 ? "medio" : idroTotal > 0 ? "basso" : "nullo";

  // Alluvionale: true if any significant flood risk
  const alluvionale = (Number(data.idro_p1_perc) || 0) > 10 || (Number(data.pop_idro_p1) || 0) > 100;

  return ok(req, {
    idrogeologico,
    sismico: "dato non disponibile",
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
    fonte: "ISPRA — Dissesto idrogeologico in Italia, ed. 2021",
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
  const { data, error } = await supabase
    .from("istat_comuni")
    .select("*")
    .ilike("comune", comune)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return fail(req, 404, "DATA_NOT_FOUND", `No ISTAT data for comune "${comune}"`, debugId);
  }

  // Compute density using ISPRA superficie if available
  let densitaAbitanti: number | null = null;
  const { data: ispra } = await supabase
    .from("ispra_rischio")
    .select("superficie_kmq")
    .ilike("comune", comune)
    .limit(1)
    .maybeSingle();

  if (ispra?.superficie_kmq && data.popolazione) {
    densitaAbitanti = Math.round(Number(data.popolazione) / Number(ispra.superficie_kmq));
  }

  return ok(req, {
    etaMedia: data.eta_media,
    popolazione: data.popolazione,
    densitaAbitanti,
    percentualeGiovani: data.percentuale_under35,
    percentualeUnder18: data.percentuale_under18,
    percentualeOver65: data.percentuale_over65,
    maschi: data.maschi,
    femmine: data.femmine,
    anno: data.anno,
    fonte: "ISTAT — Popolazione residente al 1° gennaio 2025",
  }, [], debugId);
}
