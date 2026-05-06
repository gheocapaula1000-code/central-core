// ═══════════════════════════════════════════════════════════════
// Firecrawl client — wrapper minimale, server-side only.
// Compliance: niente bypass login/CAPTCHA/paywall. Niente dati personali.
// ═══════════════════════════════════════════════════════════════
const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

export interface ScrapeResult {
  ok: boolean;
  url: string;
  status?: number;
  title?: string | null;
  markdown?: string | null;
  links?: string[];
  publishedAt?: string | null;
  error?: string;
}

function key(): string | null {
  const k = Deno.env.get("FIRECRAWL_API_KEY");
  return k && k.length > 0 ? k : null;
}

export function firecrawlAvailable(): boolean {
  return !!key();
}

export async function fcScrape(url: string, opts: { timeoutMs?: number; formats?: string[] } = {}): Promise<ScrapeResult> {
  const k = key();
  if (!k) return { ok: false, url, error: "FIRECRAWL_API_KEY missing" };
  const timeout = opts.timeoutMs ?? 25_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${FIRECRAWL_V2}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: opts.formats ?? ["markdown", "links"],
        onlyMainContent: true,
      }),
      signal: ctrl.signal,
    });
    const status = res.status;
    if (!res.ok) return { ok: false, url, status, error: `HTTP ${status}` };
    const data = await res.json().catch(() => ({}));
    const root = data?.data ?? data;
    const md: string | null = root?.markdown ?? null;
    const title: string | null = root?.metadata?.title ?? null;
    const publishedAt: string | null = root?.metadata?.publishedTime ?? root?.metadata?.modifiedTime ?? null;
    const links: string[] = Array.isArray(root?.links) ? root.links.slice(0, 200) : [];
    return { ok: true, url, status, title, markdown: md ? md.slice(0, 12_000) : null, links, publishedAt };
  } catch (e) {
    return { ok: false, url, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fcMap(url: string, opts: { search?: string; limit?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; links: string[]; error?: string }> {
  const k = key();
  if (!k) return { ok: false, links: [], error: "FIRECRAWL_API_KEY missing" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${FIRECRAWL_V2}/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, search: opts.search, limit: opts.limit ?? 100, includeSubdomains: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, links: [], error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    const raw: unknown[] = Array.isArray(data?.links)
      ? data.links
      : Array.isArray(data?.data?.links)
        ? data.data.links
        : Array.isArray(data?.data)
          ? data.data
          : [];
    const links: string[] = raw
      .map((l) => (typeof l === "string" ? l : (l as { url?: string })?.url ?? ""))
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    return { ok: true, links: links.slice(0, opts.limit ?? 100) };
  } catch (e) {
    return { ok: false, links: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
