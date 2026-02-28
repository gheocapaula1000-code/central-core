function withTimeout(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(id) };
}

export interface FirecrawlResult {
  url: string;
  markdown: string;
  title: string;
}

export async function firecrawlExtract(url: string): Promise<FirecrawlResult | null> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) {
    console.warn("[firecrawl] FIRECRAWL_API_KEY not configured");
    return null;
  }

  const { controller, clear } = withTimeout(20_000);

  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[firecrawl] HTTP ${res.status} for ${url}`);
      return null;
    }

    const data = await res.json();
    const markdown: string = data?.data?.markdown ?? data?.markdown ?? "";
    const title: string = data?.data?.metadata?.title ?? url;

    if (!markdown || markdown.trim().length < 50) return null;

    return { url, markdown: markdown.slice(0, 2500), title };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[firecrawl] Timeout for ${url}`);
    } else {
      console.warn(`[firecrawl] Error:`, String(err));
    }
    return null;
  } finally {
    clear();
  }
}

export async function firecrawlBatch(urls: string[]): Promise<FirecrawlResult[]> {
  const results = await Promise.all(urls.slice(0, 2).map(firecrawlExtract));
  return results.filter((r): r is FirecrawlResult => r !== null);
}
