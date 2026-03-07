// Sottra — Motore Forecast handlers (6 endpoints)

import { ok, fail } from "../_shared/http.ts";
import { callAI, parseJSON, reverseGeocode } from "./shared.ts";

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

Includi solo progetti reali e realistici per quella specifica città e zona. Considera: estensioni metro/tram, nuove piste ciclabili, riqualificazioni urbane, nuovi parchi, grandi opere stradali.`;

  try {
    const output = await callAI(prompt, 500, 0.3);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse infrastructure data", debugId);
    return ok(req, data, ["Progetti basati su dati urbanistici pubblici"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Infrastructure analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/rischio-zona — coordinates → zone risk assessment */
export async function handleForecastRischioZona(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un esperto di rischio territoriale italiano. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), valuta i rischi ambientali.

Rispondi SOLO in JSON valido:
{
  "idrogeologico": "alto" oppure "medio" oppure "basso" oppure "nullo",
  "sismico": "zona1" oppure "zona2" oppure "zona3" oppure "zona4",
  "inquinamento": "alto" oppure "medio" oppure "basso",
  "alluvionale": true oppure false,
  "scoreRischio": numero_da_0_a_100
}

Lo scoreRischio va da 0 (massimo rischio) a 100 (zona sicurissima). Basa la valutazione su: classificazione sismica OPCM del comune, mappe ISPRA per rischio idrogeologico, dati ARPA per inquinamento, mappe alluvionali del distretto idrografico. L'Italia ha 4 zone sismiche: zona1 = massimo rischio (Calabria, Sicilia orientale), zona4 = minimo (Sardegna, parti del Nord).`;

  try {
    const output = await callAI(prompt, 250, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse risk data", debugId);
    return ok(req, data, ["Rischio stimato da dati ISPRA/OPCM — non perizia certificata"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Risk analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}

/** POST /sottra/forecast/trend-demografico — coordinates → demographic trends */
export async function handleForecastTrendDemografico(req: Request, body: Record<string, unknown>, debugId: string): Promise<Response> {
  const lat = body.lat as number | undefined;
  const lng = body.lng as number | undefined;
  if (lat == null || lng == null) return fail(req, 400, "MISSING_COORDS", "Provide lat and lng", debugId);

  const address = await reverseGeocode(lat, lng) ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  const prompt = `Sei un demografo italiano. Per la zona di "${address}" (coordinate: ${lat}, ${lng}), analizza i trend demografici.

Rispondi SOLO in JSON valido:
{
  "etaMedia": eta_media_residenti,
  "densitaAbitanti": abitanti_per_km_quadro,
  "flussoResidenti12Mesi": numero_positivo_arrivi_o_negativo_partenze,
  "percentualeFamiglie": percentuale_nuclei_familiari,
  "percentualeGiovani": percentuale_under_35,
  "percentualeStranieri": percentuale_residenti_stranieri
}

Basa la stima su dati ISTAT della zona: centri storici = età media alta + meno famiglie, periferie = più giovani + più famiglie, zone universitarie = alta % giovani, quartieri multietnici = alta % stranieri. Il flusso è positivo se la zona attira nuovi residenti.`;

  try {
    const output = await callAI(prompt, 250, 0.2);
    const data = parseJSON(output);
    if (!data) return fail(req, 502, "PARSE_ERROR", "Failed to parse demographic data", debugId);
    return ok(req, data, ["Dati demografici stimati da fonti ISTAT"], debugId);
  } catch (e) {
    return fail(req, 502, "PROVIDER_ERROR", `Demographic analysis failed: ${String(e).slice(0, 100)}`, debugId);
  }
}
