export interface ZonaIntelligence {
  status: "ok" | "parziale" | "non_disponibile";
  classificazioneZona: string;
  sentimentResidenti: string;
  livelloSentiment: "alto" | "medio" | "basso" | "non_disponibile";
  notizieRecenti: Array<{ titolo: string; fonte: string; url: string | null }>;
  puntiDiForzaNascosti: string[];
  criticitaEmergenti: string[];
  tendenzaMercato: string;
  fonteData: string;
  generatedAt: string;
}

const EMPTY_INTELLIGENCE: ZonaIntelligence = {
  status: "non_disponibile",
  classificazioneZona: "Dati non disponibili",
  sentimentResidenti: "Analisi non disponibile in questo momento.",
  livelloSentiment: "non_disponibile",
  notizieRecenti: [],
  puntiDiForzaNascosti: [],
  criticitaEmergenti: [],
  tendenzaMercato: "Dati non disponibili",
  fonteData: "Fonte da Collegare",
  generatedAt: new Date().toISOString(),
};

const PERPLEXITY_SYSTEM = `Sei un analista immobiliare italiano con accesso al web in tempo reale. Il tuo compito è analizzare una zona/quartiere italiano cercando informazioni REALI e RECENTI. Rispondi SOLO con un oggetto JSON valido.

STRUTTURA JSON RICHIESTA:
{
  "classificazioneZona": "es. Residenziale Premium / Commerciale / Periferia in sviluppo",
  "sentimentResidenti": "es. Zona tranquilla ma carente di parcheggi. Recenti lamentele per la viabilità.",
  "livelloSentiment": "alto|medio|basso|non_disponibile",
  "notizieRecenti": [
    { "titolo": "Titolo reale notizia", "fonte": "Nome testata", "url": "https://..." }
  ],
  "puntiDiForzaNascosti": ["stringa1","stringa2"],
  "criticitaEmergenti": ["stringa1","stringa2"],
  "tendenzaMercato": "es. Prezzi in crescita del 8% / Mercato stagnante / Forte domanda da famiglie"
}

REGOLE CRITICHE (STRICT FALLBACK):
- MAI inventare notizie, URL, o dati. Se non trovi una notizia reale con URL funzionante, restituisci "notizieRecenti": [].
- Se non trovi dati reali per un campo, usa stringa vuota "" o array vuoto [].
- È preferibile un JSON vuoto a un JSON inventato. L'onestà è il requisito numero uno.
- MAI usare dati più vecchi di 12 mesi.`;

function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

export async function buildZonaIntelligence(
  address: string,
  municipality: string,
  coords: { lat: number; lng: number } | null,
): Promise<ZonaIntelligence> {
  const key = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
  if (!key) return { ...EMPTY_INTELLIGENCE };

  const locationStr = municipality
    ? `${municipality}${address ? `, zona ${address}` : ""}`
    : address || "zona non specificata";
  const coordStr = coords ? ` (coordinate: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})` : "";

  const prompt = `Analizza la zona immobiliare di: ${locationStr}${coordStr}

Cerca informazioni recenti (ultimi 12 mesi) su:
1. Notizie di cronaca locale, progetti urbanistici, eventi significativi
2. Discussioni su forum locali, gruppi Facebook pubblici, Reddit su questa zona
3. Sentiment generale dei residenti
4. Tendenza dei prezzi immobiliari in questa zona
5. Punti di forza non ovvi (nuove aperture, riqualificazioni, investimenti)
6. Criticità emerse (sicurezza, rumore, cantieri, degrado)

Rispondi SOLO in JSON come da istruzioni.`;

  const { signal, clear } = withAbort(35_000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        max_tokens: 1200,
        temperature: 0.0,
        messages: [
          { role: "system", content: PERPLEXITY_SYSTEM },
          { role: "user", content: prompt },
        ],
        return_citations: true,
        search_recency_filter: "year",
      }),
      signal,
    });
    if (!res.ok) return { ...EMPTY_INTELLIGENCE };
    const data = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    if (!raw || raw.trim().length < 10) return { ...EMPTY_INTELLIGENCE };

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...EMPTY_INTELLIGENCE };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { ...EMPTY_INTELLIGENCE };
    }

    const safeStr = (v: unknown, max = 300): string =>
      typeof v === "string" ? v.slice(0, max) : "";
    const safeArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => (x as string).slice(0, 200)) : [];
    const safeLevel = (v: unknown): "alto" | "medio" | "basso" | "non_disponibile" =>
      ["alto", "medio", "basso"].includes(v as string) ? (v as "alto" | "medio" | "basso") : "non_disponibile";

    const notizieRaw = Array.isArray(parsed.notizieRecenti) ? parsed.notizieRecenti : [];
    const notizie = notizieRaw
      .filter((n) => n && typeof n === "object")
      .map((n) => ({
        titolo: safeStr((n as Record<string, unknown>).titolo, 200),
        fonte: safeStr((n as Record<string, unknown>).fonte, 100),
        url:
          typeof (n as Record<string, unknown>).url === "string" && (n as Record<string, unknown>).url !== "null"
            ? safeStr((n as Record<string, unknown>).url, 300)
            : null,
      }))
      .filter((n) => n.titolo.length > 3)
      .slice(0, 3);

    const classificazione = safeStr(parsed.classificazioneZona, 100);
    const sentiment = safeStr(parsed.sentimentResidenti, 300);
    const hasData = classificazione.length > 3 || sentiment.length > 10 || notizie.length > 0;

    return {
      status: hasData ? "ok" : "parziale",
      classificazioneZona: classificazione || "Dati non disponibili",
      sentimentResidenti: sentiment || "Analisi non disponibile.",
      livelloSentiment: safeLevel(parsed.livelloSentiment),
      notizieRecenti: notizie,
      puntiDiForzaNascosti: safeArr(parsed.puntiDiForzaNascosti).slice(0, 3),
      criticitaEmergenti: safeArr(parsed.criticitaEmergenti).slice(0, 3),
      tendenzaMercato: safeStr(parsed.tendenzaMercato, 150) || "Dati non disponibili",
      fonteData: "Perplexity AI (web real-time)",
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return { ...EMPTY_INTELLIGENCE };
  } finally {
    clear();
  }
}
