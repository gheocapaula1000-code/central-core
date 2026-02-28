function withTimeout(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(id) };
}

export interface PerplexitySearchResult {
  answer: string;
  citations: Array<{ url: string; title?: string }>;
  latencyMs: number;
}

/** Returns null if key not configured or request fails — never throws. */
export async function perplexitySearch(query: string): Promise<PerplexitySearchResult | null> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not configured");
    return null;
  }

  const { controller, clear } = withTimeout(20_000);
  const started = Date.now();

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        max_tokens: 800,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "Sei un assistente che ricerca fonti ufficiali italiane. Rispondi in italiano. Cita preferibilmente fonti gov.it, inps.it, agenziaentrate.gov.it, enea.it, invitalia.it, normattiva.it. Non inventare dati.",
          },
          { role: "user", content: query },
        ],
        return_citations: true,
        search_recency_filter: "year",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[perplexity] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const answer: string = data?.choices?.[0]?.message?.content ?? "";
    const rawCitations: unknown[] = data?.citations ?? [];

    const citations = rawCitations
      .map((c) => {
        if (typeof c === "string") return { url: c };
        if (typeof c === "object" && c !== null) {
          const obj = c as Record<string, unknown>;
          return { url: (obj.url as string) ?? "", title: obj.title as string | undefined };
        }
        return { url: "" };
      })
      .filter((c) => c.url.length > 0);

    return { answer, citations, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("[perplexity] Timeout after 20s");
    } else {
      console.warn("[perplexity] Failed:", String(err));
    }
    return null;
  } finally {
    clear();
  }
}

/** Generation call — uses Perplexity as LLM with web access */
export async function callPerplexity(
  prompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{ output: string; latencyMs: number }> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) throw new Error("PERPLEXITY_API_KEY not configured");

  const { controller, clear } = withTimeout(25_000);
  const started = Date.now();

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        return_citations: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Perplexity error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const output = data?.choices?.[0]?.message?.content ?? "";
    if (!output) throw new Error("Perplexity returned empty content");
    return { output, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("Perplexity timeout");
    throw err;
  } finally {
    clear();
  }
}
