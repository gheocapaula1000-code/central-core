import type { OpportunitaOffMarket } from "./radarOpportunita.ts";

/**
 * Scraper ribassi su portali immobiliari (Immobiliare.it) tramite Firecrawl.
 * Ritorna array vuoto se la chiave manca, l'URL non risponde, o non emergono dati reali.
 * Strict-fallback: nessun dato inventato.
 */
export async function scrapeRibassiPortali(
  municipality: string,
  _coords: { lat: number; lng: number } | null,
): Promise<OpportunitaOffMarket[]> {
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey || !municipality) return [];

  const slug = municipality.toLowerCase().trim().replace(/\s+/g, "-");
  const searchUrl = `https://www.immobiliare.it/vendita-case/${slug}/?criterio=ribasso`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: searchUrl,
        formats: ["extract"],
        extract: {
          prompt:
            "Estrai gli immobili in vendita che hanno subito un ribasso di prezzo recente. Trova titolo, indirizzo, prezzo attuale, percentuale o importo del ribasso, e link all'annuncio. Solo dati realmente presenti nella pagina.",
          schema: {
            type: "object",
            properties: {
              ribassi: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    titolo: { type: "string" },
                    indirizzo: { type: "string" },
                    prezzoAttuale: { type: "string" },
                    sconto: { type: "string" },
                    link: { type: "string" },
                  },
                  required: ["titolo", "indirizzo", "prezzoAttuale", "sconto", "link"],
                },
              },
            },
          },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) return [];
    const data = await res.json();
    const ribassi: unknown = data?.data?.extract?.ribassi ?? data?.extract?.ribassi ?? [];
    if (!Array.isArray(ribassi)) return [];

    return ribassi
      .filter((r): r is Record<string, string> =>
        !!r && typeof r === "object" &&
        typeof (r as Record<string, unknown>).link === "string" &&
        ((r as Record<string, unknown>).link as string).startsWith("http")
      )
      .slice(0, 5)
      .map((r) => ({
        tipo: "ribasso" as const,
        titolo: `Ribasso recente: ${String(r.titolo ?? "Immobile").slice(0, 160)}`,
        descrizione: `Immobile ribassato del ${r.sconto ?? "?"}. Possibile margine di trattativa.`.slice(0, 300),
        prezzoIndicativo: r.prezzoAttuale ? String(r.prezzoAttuale).slice(0, 100) : null,
        scontoStimato: r.sconto ? String(r.sconto).slice(0, 80) : null,
        localita: (r.indirizzo && String(r.indirizzo).slice(0, 150)) || municipality,
        fonte: "Monitoraggio Portali Immobiliari",
        evidenceUrl: String(r.link).slice(0, 400),
        categoria: "residenziale" as const,
        urgenza: "media" as const,
      }));
  } catch (e) {
    console.error("[ribassiPortali] errore:", e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
  }
}
