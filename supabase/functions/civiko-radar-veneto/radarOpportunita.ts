export interface OpportunitaOffMarket {
  tipo: "asta" | "successione" | "luxury" | "terreno" | "commerciale" | "ribasso" | "divorzio" | "confisca";
  titolo: string;
  descrizione: string;
  prezzoIndicativo: string | null;
  scontoStimato: string | null;
  localita: string;
  fonte: string;
  evidenceUrl: string | null;
  categoria: "residenziale" | "commerciale" | "terreno" | "luxury" | "altro";
  urgenza: "alta" | "media" | "bassa";
}

const PERPLEXITY_SYSTEM_OPPORTUNITA = `Sei un analista immobiliare esperto con accesso al web in tempo reale.
Cerca opportunità immobiliari off-market e SEGNALI RISERVATI (deboli) che indichino vendite imminenti o sotto pressione.

FORMATO RISPOSTA OBBLIGATORIO — rispondi SEMPRE e SOLO in questo JSON valido:
{
  "opportunita": [
    {
      "tipo": "asta|successione|luxury|terreno|commerciale|ribasso|divorzio|confisca",
      "titolo": "stringa descrittiva breve",
      "descrizione": "stringa max 300 caratteri con dettaglio del segnale",
      "prezzoIndicativo": "es. € 180.000 base d'asta oppure null",
      "scontoStimato": "es. ~30% sotto mercato oppure null",
      "localita": "es. Milano, zona Navigli",
      "fonte": "nome del sito/ente",
      "evidenceUrl": "URL diretto e verificabile oppure null",
      "categoria": "residenziale|commerciale|terreno|luxury|altro",
      "urgenza": "alta|media|bassa"
    }
  ]
}

CATEGORIE DA CERCARE:
1. ASTE GIUDIZIARIE: pvp.giustizia.it, asteonline.it, astegiudiziarie.it, portaleaste.it, siti tribunali
2. BENI CONFISCATI: anbsc.it, agenziadelbeni.gov.it
3. LUXURY OFF-MARKET: sothebysrealty.it, knightfrank.it, engelvoelkers.com/it, luxuryestate.com, christiesrealestate.com, ville-casali.com
4. TERRENI E COMMERCIALE: portali comunali, liquidazioni aziendali, annunci NPL bancari
5. SEGNALI RISERVATI (segnali deboli):
   - Successioni ed eredità recenti (necrologi locali incrociati con proprietà immobiliari, pubblicazioni tribunali) → tipo "successione"
   - Divorzi e separazioni (sentenze pubbliche o annunci con motivazione "cambio progetto di vita", "separazione") → tipo "divorzio"
   - Difficoltà finanziarie (chiusure attività commerciali, pignoramenti, procedure concorsuali) → tipo "ribasso" o "commerciale"
   - Immobili sfitti da oltre 12 mesi (annunci datati mai rimossi, ribassi multipli) → tipo "ribasso"

REGOLE:
- Ogni opportunità DEVE avere evidenceUrl reale e verificabile. Se non hai URL, NON includere.
- urgenza "alta" = asta imminente, segnale forte di vendita sotto pressione, prezzo molto sotto mercato
- Massimo 10 opportunità totali, mix di categorie quando possibile
- MAI inventare dati, prezzi, nomi o URL
- I segnali riservati devono basarsi su fonti pubbliche (necrologi, pubblicazioni tribunali, registri imprese)
- Se non trovi nulla di reale: {"opportunita":[]}`;

function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

export async function buildOpportunitaOffMarket(
  comune: string,
  provincia: string,
): Promise<OpportunitaOffMarket[]> {
  const key = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
  if (!key) return [];

  const location = [comune, provincia].filter(Boolean).join(", ") || "Italia";

  const prompt = `Cerca opportunità immobiliari off-market e segnali riservati nella zona di: ${location}

Cerca in parallelo:
1. ASTE GIUDIZIARIE attive: immobili residenziali, commerciali e terreni all'asta nei tribunali di ${provincia || "Italia"}. Cerca su pvp.giustizia.it e portali aste.
2. LUXURY E VILLE: immobili di pregio (ville, attici, casali) non presenti su Immobiliare.it. Cerca su Sotheby's, Knight Frank, Engel & Völkers per la zona ${comune || "Italia"}.
3. TERRENI EDIFICABILI: lotti edificabili o agricoli con cambio destinazione d'uso a prezzo ribassato in ${comune || "Italia"} e dintorni.
4. BENI CONFISCATI: immobili dell'ANBSC o Agenzia del Demanio disponibili in ${provincia || "Italia"}.
5. SEGNALI RISERVATI (segnali deboli) in ${comune || "Italia"}:
   - Successioni ed eredità: necrologi locali recenti incrociati con proprietà immobiliari, pubblicazioni tribunali su eredità giacenti
   - Divorzi e separazioni: annunci con motivazione "cambio progetto di vita", "separazione", sentenze pubbliche
   - Difficoltà finanziarie: chiusure attività commerciali, pignoramenti, procedure concorsuali, NPL bancari
   - Immobili sfitti da oltre 12 mesi: annunci datati con ribassi multipli, mai rimossi dai portali

Per ogni opportunità trovata, includi URL diretto alla fonte verificabile. Rispondi SOLO in JSON.`;

  const { signal, clear } = withAbort(40_000);
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        max_tokens: 2000,
        temperature: 0.0,
        messages: [
          { role: "system", content: PERPLEXITY_SYSTEM_OPPORTUNITA },
          { role: "user", content: prompt },
        ],
        return_citations: true,
        search_recency_filter: "year",
      }),
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    if (!raw || raw.trim().length < 10) return [];
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return [];
    }
    const rawList = Array.isArray(parsed.opportunita) ? parsed.opportunita : [];
    const VALID_TIPI = ["asta", "successione", "luxury", "terreno", "commerciale", "ribasso", "divorzio", "confisca"];
    const VALID_CAT = ["residenziale", "commerciale", "terreno", "luxury", "altro"];
    const VALID_URG = ["alta", "media", "bassa"];
    const safeStr = (v: unknown, max = 300): string =>
      typeof v === "string" ? v.slice(0, max) : "";
    const safeNullStr = (v: unknown, max = 300): string | null =>
      typeof v === "string" && v !== "null" && v.length > 0 ? v.slice(0, max) : null;

    return rawList
      .filter((o) => o && typeof o === "object")
      .map((o) => {
        const item = o as Record<string, unknown>;
        return {
          tipo: VALID_TIPI.includes(item.tipo as string)
            ? (item.tipo as OpportunitaOffMarket["tipo"])
            : "ribasso",
          titolo: safeStr(item.titolo, 200) || "Opportunità immobiliare",
          descrizione: safeStr(item.descrizione, 300),
          prezzoIndicativo: safeNullStr(item.prezzoIndicativo, 100),
          scontoStimato: safeNullStr(item.scontoStimato, 80),
          localita: safeStr(item.localita, 150) || location,
          fonte: safeStr(item.fonte, 100) || "Fonte pubblica",
          evidenceUrl: safeNullStr(item.evidenceUrl, 400),
          categoria: VALID_CAT.includes(item.categoria as string)
            ? (item.categoria as OpportunitaOffMarket["categoria"])
            : "altro",
          urgenza: VALID_URG.includes(item.urgenza as string)
            ? (item.urgenza as OpportunitaOffMarket["urgenza"])
            : "media",
        };
      })
      .filter((o) => o.titolo.length > 3 && o.evidenceUrl !== null)
      .slice(0, 10);
  } catch {
    return [];
  } finally {
    clear();
  }
}
