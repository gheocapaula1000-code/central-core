import type { OpportunitaOffMarket } from "./radarOpportunita.ts";

/**
 * Scraper potenziali successioni: estrae necrologi locali recenti via Firecrawl.
 * Segnala una potenziale opportunità di successione, senza incrocio catastale.
 * Strict-fallback: nessun dato inventato; ritorna [] se Firecrawl non risponde.
 */
export async function scrapeSuccessioniPotenziali(
  municipality: string,
): Promise<OpportunitaOffMarket[]> {
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey || !municipality) return [];

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `necrologi ${municipality} ultimi giorni`,
  )}`;

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
            "Estrai i necrologi più recenti (ultimi 7 giorni) per questa località. Trova nome del defunto, data del decesso e link di riferimento. Solo dati realmente presenti.",
          schema: {
            type: "object",
            properties: {
              necrologi: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    nome: { type: "string" },
                    data: { type: "string" },
                    link: { type: "string" },
                  },
                  required: ["nome", "link"],
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
    const necrologi: unknown = data?.data?.extract?.necrologi ?? data?.extract?.necrologi ?? [];
    if (!Array.isArray(necrologi)) return [];

    return necrologi
      .filter((n): n is Record<string, string> =>
        !!n && typeof n === "object" &&
        typeof (n as Record<string, unknown>).nome === "string" &&
        typeof (n as Record<string, unknown>).link === "string" &&
        ((n as Record<string, unknown>).link as string).startsWith("http")
      )
      .slice(0, 3)
      .map((n) => {
        const cognome = String(n.nome).trim().split(/\s+/).pop() ?? "—";
        return {
          tipo: "successione" as const,
          titolo: `Potenziale successione: famiglia ${cognome}`,
          descrizione:
            `Decesso recente${n.data ? ` (${String(n.data).slice(0, 60)})` : ""}. Possibile immobile in successione a breve nella zona.`.slice(0, 300),
          prezzoIndicativo: null,
          scontoStimato: "Trattativa privata",
          localita: municipality,
          fonte: "Registri locali / Necrologi",
          evidenceUrl: String(n.link).slice(0, 400),
          categoria: "residenziale" as const,
          urgenza: "bassa" as const,
        };
      });
  } catch (e) {
    console.error("[successioniPotenziali] errore:", e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
  }
}
