import type { OpportunitaOffMarket } from "./radarOpportunita.ts";

interface AstaScraped {
  tipo?: string;
  indirizzo?: string;
  prezzoBase?: string;
  dataVendita?: string;
  link?: string;
}

export async function scrapeAsteGiudiziarie(
  municipality: string,
  coords: { lat: number; lng: number } | null,
): Promise<OpportunitaOffMarket[]> {
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey || !municipality || !coords) return [];

  const pvpUrl =
    `https://pvp.giustizia.it/pvp/it/lista_annunci.wp?searchType=searchForm&page=0&size=10&sortProperty=dataOraVendita,asc&macro=IMMOBILI` +
    `&localita=${encodeURIComponent(municipality)}` +
    `&raggioAzione=15&coordIndirizzo=${coords.lat},${coords.lng}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);

  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: pvpUrl,
        formats: ["extract"],
        extract: {
          prompt:
            "Estrai tutte le aste immobiliari presenti in questa pagina. Per ogni asta, trova il tipo di immobile, l'indirizzo, il prezzo base d'asta, la data di vendita e il link all'annuncio.",
          schema: {
            type: "object",
            properties: {
              aste: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tipo: { type: "string" },
                    indirizzo: { type: "string" },
                    prezzoBase: { type: "string" },
                    dataVendita: { type: "string" },
                    link: { type: "string" },
                  },
                  required: ["tipo", "indirizzo", "prezzoBase", "link"],
                },
              },
            },
          },
        },
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) return [];
    const data = await res.json();
    const aste: AstaScraped[] =
      data?.data?.extract?.aste ?? data?.extract?.aste ?? [];
    if (!Array.isArray(aste)) return [];

    return aste
      .filter((a) => a && typeof a.link === "string" && a.link.length > 3)
      .map((asta): OpportunitaOffMarket => {
        const link = String(asta.link);
        const evidenceUrl = link.startsWith("http")
          ? link
          : `https://pvp.giustizia.it${link.startsWith("/") ? "" : "/"}${link}`;
        return {
          tipo: "asta",
          titolo: `Asta Giudiziaria: ${(asta.tipo ?? "Immobile").slice(0, 120)}`,
          descrizione: `Data vendita: ${asta.dataVendita || "Non specificata"}`,
          prezzoIndicativo: asta.prezzoBase ? String(asta.prezzoBase).slice(0, 100) : null,
          scontoStimato: "Base d'asta",
          localita: (asta.indirizzo ?? municipality).slice(0, 150),
          fonte: "Portale Vendite Pubbliche (Ministero Giustizia)",
          evidenceUrl: evidenceUrl.slice(0, 400),
          categoria: "residenziale",
          urgenza: "alta",
        };
      })
      .slice(0, 10);
  } catch (e) {
    console.error("[asteGiudiziarie] scraping error:", e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
  }
}
