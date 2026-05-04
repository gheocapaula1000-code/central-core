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

const PERPLEXITY_SYSTEM_OPPORTUNITA = `Sei un analista immobiliare italiano specializzato in acquisizioni off-market. Rispondi SOLO con un oggetto JSON valido.

STRUTTURA JSON RICHIESTA:
{
  "opportunita": [
    {
      "tipo": "asta|successione|luxury|terreno|commerciale|ribasso|divorzio|confisca",
      "titolo": "Titolo reale e specifico",
      "descrizione": "Dettagli dell'opportunità",
      "prezzoIndicativo": "es. 150.000€",
      "scontoStimato": "es. -20%",
      "localita": "Comune o quartiere",
      "fonte": "Nome del sito o tribunale",
      "evidenceUrl": "https://...",
      "categoria": "residenziale|commerciale|terreno|luxury|altro",
      "urgenza": "alta|media|bassa"
    }
  ]
}

REGOLE CRITICHE (STRICT FALLBACK):
- MAI inventare opportunità, indirizzi, prezzi o URL.
- Se non trovi un'opportunità REALE e VERIFICABILE con un URL funzionante, NON includerla.
- Se non trovi nulla di reale nella zona richiesta, restituisci {"opportunita":[]}.
- È preferibile restituire 0 opportunità vere che 10 opportunità inventate. L'onestà è il requisito numero uno.`;

function withAbort(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

import { scrapeAsteGiudiziarie } from "./asteGiudiziarie.ts";
import { scrapeRibassiPortali } from "./ribassiPortali.ts";
import { scrapeSuccessioniPotenziali } from "./successioniPotenziali.ts";

export async function buildOpportunitaOffMarket(
  comune: string,
  provincia: string,
  coords: { lat: number; lng: number } | null = null,
): Promise<OpportunitaOffMarket[]> {
  // Lancia tutti gli scraper proprietari in parallelo con Perplexity
  const astePromise = scrapeAsteGiudiziarie(comune, coords);
  const ribassiPromise = scrapeRibassiPortali(comune, coords);
  const successioniPromise = scrapeSuccessioniPotenziali(comune, provincia);

  const collectScrapers = async (): Promise<OpportunitaOffMarket[]> => {
    const [aste, ribassi, successioni] = await Promise.all([
      astePromise.catch(() => [] as OpportunitaOffMarket[]),
      ribassiPromise.catch(() => [] as OpportunitaOffMarket[]),
      successioniPromise.catch(() => [] as OpportunitaOffMarket[]),
    ]);
    return [...aste, ...ribassi, ...successioni];
  };

  const key = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
  if (!key) {
    // Anche senza Perplexity, restituisci almeno i dati certi degli scraper
    return (await collectScrapers()).slice(0, 15);
  }

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
    if (!res.ok) return (await collectScrapers()).slice(0, 15);
    const data = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    if (!raw || raw.trim().length < 10) return (await collectScrapers()).slice(0, 15);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return (await collectScrapers()).slice(0, 15);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return (await collectScrapers()).slice(0, 15);
    }
    const rawList = Array.isArray(parsed.opportunita) ? parsed.opportunita : [];
    const VALID_TIPI = ["asta", "successione", "luxury", "terreno", "commerciale", "ribasso", "divorzio", "confisca"];
    const VALID_CAT = ["residenziale", "commerciale", "terreno", "luxury", "altro"];
    const VALID_URG = ["alta", "media", "bassa"];
    const safeStr = (v: unknown, max = 300): string =>
      typeof v === "string" ? v.slice(0, max) : "";
    const safeNullStr = (v: unknown, max = 300): string | null =>
      typeof v === "string" && v !== "null" && v.length > 0 ? v.slice(0, max) : null;

    const opportunitaPerplexity = rawList
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
      .filter((o) => o.titolo.length > 3 && o.evidenceUrl !== null);

    // Dati certi dagli scraper proprietari (prioritari); filtra duplicati da Perplexity
    const [asteCerte, ribassiCerti, successioniPotenziali] = await Promise.all([
      astePromise.catch(() => [] as OpportunitaOffMarket[]),
      ribassiPromise.catch(() => [] as OpportunitaOffMarket[]),
      successioniPromise.catch(() => [] as OpportunitaOffMarket[]),
    ]);
    const opportunitaFiltrate = opportunitaPerplexity.filter(
      (o) =>
        o.tipo !== "asta" &&
        o.tipo !== "ribasso" &&
        o.tipo !== "successione" &&
        typeof o.evidenceUrl === "string" &&
        o.evidenceUrl.startsWith("http"),
    );
    return [
      ...asteCerte,
      ...ribassiCerti,
      ...successioniPotenziali,
      ...opportunitaFiltrate,
    ].slice(0, 15);
  } catch {
    return (await collectScrapers()).slice(0, 15);
  } finally {
    clear();
  }
}
