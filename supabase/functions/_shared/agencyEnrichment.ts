// Agency enrichment cascade per detail page dei portali immobiliari.
// Cascade attuale:
//   1) Parser HTML/JSON-LD diretto su payload Firecrawl scrape.
//   2) Firecrawl scrape (formats: html + markdown).
//   (Hook futuri: Apify per portale, Perplexity per singolo URL.)
//
// Risultati scritti in public.listing_agency_enrichment (cache 72h per URL).
// Mai accettare: portal:*, nomi-portale, "privato", "proprietario", "ha cancellato".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { canSpendFirecrawl, recordFirecrawlSpend } from "./firecrawlBudget.ts";

export type Portal = "casa" | "immobiliare" | "idealista" | "subito";

export interface AgencyExtraction {
  raw_agency_name: string | null;
  normalized_agency_name: string | null;
  agency_url: string | null;
  agency_phone: string | null;
  agency_logo_url: string | null;
  extraction_method: string;
  confidence: "high" | "medium" | "low" | "none";
  error: string | null;
  raw_excerpt: Record<string, unknown>;
}

const BLOCKLIST = new Set([
  "casa", "immobiliare", "idealista", "subito",
  "privato", "privati", "private", "proprietario", "owner",
  "ha cancellato l'annuncio", "ha cancellato lannuncio",
  "casa.it", "immobiliare.it", "idealista.it", "subito.it",
]);

function isBlocked(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (!n) return true;
  if (n.startsWith("portal:")) return true;
  if (n.startsWith("ha cancellato")) return true;
  return BLOCKLIST.has(n);
}

export function normalizeAgency(name: string | null | undefined): string | null {
  if (!name) return null;
  let s = name.trim();
  if (!s) return null;
  s = s.replace(/\s+/g, " ");
  s = s.replace(/[®©™]/g, "").trim();
  if (isBlocked(s)) return null;
  // canonical key: lowercase, no punctuation, common legal-form stripped
  const key = s
    .toLowerCase()
    .replace(/\b(s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|s\.?s\.?|srls|srl|spa|sas|snc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!key || key.length < 3) return null;
  if (isBlocked(key)) return null;
  return key;
}

// ---------- HTML parsing helpers ----------
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(parseInt(c, 10)));
}

function pickJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...(parsed as Record<string, unknown>[]));
      else out.push(parsed as Record<string, unknown>);
    } catch { /* ignore */ }
  }
  return out;
}

function findAgencyInJsonLd(blocks: Record<string, unknown>[]): { name: string | null; url: string | null; phone: string | null; logo: string | null } {
  for (const b of blocks) {
    // RealEstateAgent, Organization, publisher, provider, seller, offers.seller
    const candidates: unknown[] = [
      b,
      (b as { publisher?: unknown }).publisher,
      (b as { provider?: unknown }).provider,
      (b as { seller?: unknown }).seller,
      (b as { offers?: { seller?: unknown } }).offers?.seller,
      ...((b as { offers?: unknown[] }).offers && Array.isArray((b as { offers?: unknown[] }).offers)
        ? ((b as { offers: unknown[] }).offers).map((o) => (o as { seller?: unknown })?.seller)
        : []),
    ].flat().filter(Boolean);
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const type = String(o["@type"] ?? "").toLowerCase();
      const name = typeof o.name === "string" ? o.name : null;
      const url = typeof o.url === "string" ? o.url : null;
      const phone = typeof o.telephone === "string" ? o.telephone : null;
      const logo = typeof o.logo === "string" ? o.logo : (typeof (o.logo as { url?: string })?.url === "string" ? (o.logo as { url: string }).url : null);
      if (name && (type.includes("agent") || type.includes("organization") || type.includes("realestate") || type === "")) {
        if (!isBlocked(name)) return { name, url, phone, logo };
      }
    }
  }
  return { name: null, url: null, phone: null, logo: null };
}

// Portal-specific HTML heuristics (best-effort, deterministic)
function extractFromHtml(portal: Portal, html: string): { name: string | null; url: string | null; phone: string | null; logo: string | null; method: string } {
  const h = html;

  // Generic JSON-LD first
  const ld = findAgencyInJsonLd(pickJsonLd(h));
  if (ld.name) return { ...ld, method: "jsonld" };

  // Immobiliare.it: __NEXT_DATA__ JSON contains advertiser.agency or author
  if (portal === "immobiliare") {
    const m = h.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const stack: unknown[] = [data];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== "object") continue;
          const o = cur as Record<string, unknown>;
          const ag = (o.agency ?? o.advertiser ?? o.author) as Record<string, unknown> | undefined;
          if (ag && typeof ag === "object") {
            const name = (ag.displayName ?? ag.name ?? (ag as { agency?: { displayName?: string } }).agency?.displayName) as string | undefined;
            if (typeof name === "string" && !isBlocked(name)) {
              const url = (ag.url ?? (ag as { agency?: { url?: string } }).agency?.url) as string | undefined;
              const phone = (ag.phone ?? ag.telephone) as string | undefined;
              const logo = (ag.imageUrl ?? ag.logo) as string | undefined;
              return { name, url: url ?? null, phone: phone ?? null, logo: logo ?? null, method: "next_data" };
            }
          }
          for (const k in o) {
            const v = o[k];
            if (v && typeof v === "object") stack.push(v);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Casa.it: title attribute "Vedi tutti gli annunci dell'agenzia X" (alta affidabilità)
  if (portal === "casa") {
    const m1 = h.match(/title="Vedi tutti gli annunci dell['’]agenzia\s+([^"]{2,120})"/i);
    if (m1 && !isBlocked(m1[1])) return { name: decodeEntities(m1[1].trim()), url: null, phone: null, logo: null, method: "casa_title_attr" };
    const m2 = h.match(/Contatta l['’]agenzia<\/p>\s*<p[^>]*>([^<]{2,120})</i);
    if (m2 && !isBlocked(m2[1])) return { name: decodeEntities(m2[1].trim()), url: null, phone: null, logo: null, method: "casa_contact_block" };
    // logo alt fallback (lower confidence)
    const m3 = h.match(/<img[^>]+src="[^"]*\/logo\/[^"]+"[^>]*alt="([^"]{2,120})"/i);
    if (m3 && !isBlocked(m3[1])) return { name: decodeEntities(m3[1].trim()), url: null, phone: null, logo: null, method: "casa_logo_alt" };
  }

  // Immobiliare.it: URL agenzia /(agenzie-immobiliari|agenzie|imprese-edili|costruttori|nuove-costruzioni)/<id>/<slug>/
  if (portal === "immobiliare") {
    const m = h.match(/href="(https:\/\/www\.immobiliare\.it\/(?:agenzie-immobiliari|agenzie|imprese-edili|costruttori)\/(\d+)\/([a-z0-9-]+)\/?)"/i);
    if (m) {
      const slug = m[3];
      const name = slug.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
      if (!isBlocked(name)) return { name, url: m[1], phone: null, logo: null, method: "immobiliare_agency_url" };
    }
  }

  // Idealista: detail page mostra "Contatta agente" o blocco "Agenzia"
  if (portal === "idealista") {
    if (/datadome|geo\.captcha|captcha-delivery|access denied/i.test(h)) {
      return { name: null, url: null, phone: null, logo: null, method: "blocked_by_antibot" };
    }
    const m = h.match(/professional-name[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i)
          || h.match(/class="professional-name"[^>]*>([^<]+)</i)
          || h.match(/<a[^>]+href="\/pro\/[^"]+"[^>]*>([^<]+)<\/a>/i)
          || h.match(/href="https:\/\/www\.idealista\.it\/agenzie-immobiliari\/[^"\/]+\/"[^>]*>([^<]{2,120})</i);
    if (m && !isBlocked(m[1])) return { name: decodeEntities(m[1].trim()), url: null, phone: null, logo: null, method: "idealista_pro_block" };
  }

  // Subito.it: PRIVATI per default, raramente agenzie
  if (portal === "subito") {
    const m = h.match(/"shopName"\s*:\s*"([^"]{2,120})"/) || h.match(/itemprop="name"[^>]*>([^<]{2,120})</i);
    if (m && !isBlocked(m[1])) return { name: decodeEntities(m[1]), url: null, phone: null, logo: null, method: "subito_shop" };
  }

  return { name: null, url: null, phone: null, logo: null, method: "not_found" };
}

// ---------- Firecrawl scrape ----------
async function firecrawlScrape(url: string): Promise<{ html: string | null; status: number | null; error: string | null }> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return { html: null, status: null, error: "no_firecrawl_api_key" };
  try {
    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 3000,
        timeout: 30000,
      }),
    });
    const status = resp.status;
    if (!resp.ok) {
      const t = await resp.text();
      return { html: null, status, error: `http_${status}:${t.slice(0, 200)}` };
    }
    const j = await resp.json() as { data?: { html?: string; rawHtml?: string }; html?: string };
    const html = j?.data?.html ?? j?.data?.rawHtml ?? j?.html ?? null;
    return { html: html ?? null, status, error: html ? null : "empty_html" };
  } catch (e) {
    return { html: null, status: null, error: `fetch_error:${String((e as Error).message).slice(0, 200)}` };
  }
}

// ---------- Public entrypoint ----------
function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

export async function enrichListingAgency(
  listingUrl: string,
  portal: Portal,
  opts?: { forceRefresh?: boolean },
): Promise<AgencyExtraction & { from_cache: boolean; budget_skip?: string }> {
  const c = sb();

  // Cache 72h
  if (!opts?.forceRefresh) {
    const { data: cached } = await c
      .from("listing_agency_enrichment")
      .select("raw_agency_name, normalized_agency_name, agency_url, agency_phone, agency_logo_url, extraction_method, confidence, error, raw_excerpt, enriched_at")
      .eq("listing_url", listingUrl)
      .maybeSingle();
    if (cached) {
      const ageMs = Date.now() - new Date(cached.enriched_at as string).getTime();
      if (ageMs < 72 * 3600 * 1000) {
        return {
          raw_agency_name: cached.raw_agency_name as string | null,
          normalized_agency_name: cached.normalized_agency_name as string | null,
          agency_url: cached.agency_url as string | null,
          agency_phone: cached.agency_phone as string | null,
          agency_logo_url: cached.agency_logo_url as string | null,
          extraction_method: (cached.extraction_method as string) ?? "cache",
          confidence: (cached.confidence as AgencyExtraction["confidence"]) ?? "none",
          error: cached.error as string | null,
          raw_excerpt: (cached.raw_excerpt as Record<string, unknown>) ?? {},
          from_cache: true,
        };
      }
    }
  }

  // Budget gate
  const bud = await canSpendFirecrawl(1);
  if (!bud.ok) {
    const out: AgencyExtraction & { from_cache: boolean; budget_skip?: string } = {
      raw_agency_name: null, normalized_agency_name: null, agency_url: null,
      agency_phone: null, agency_logo_url: null, extraction_method: "skip_budget",
      confidence: "none", error: bud.reason ?? "budget_cap",
      raw_excerpt: { cap: bud.cap, spent: bud.spent },
      from_cache: false, budget_skip: bud.reason ?? "budget_cap",
    };
    return out;
  }

  // Scrape
  const fc = await firecrawlScrape(listingUrl);
  await recordFirecrawlSpend(1, 1);

  let ext: AgencyExtraction;
  if (!fc.html) {
    ext = {
      raw_agency_name: null, normalized_agency_name: null, agency_url: null,
      agency_phone: null, agency_logo_url: null,
      extraction_method: "firecrawl_failed",
      confidence: "none",
      error: fc.error ?? "no_html",
      raw_excerpt: { http_status: fc.status },
    };
  } else if (fc.status === 404) {
    ext = {
      raw_agency_name: null, normalized_agency_name: null, agency_url: null,
      agency_phone: null, agency_logo_url: null,
      extraction_method: "page_dead",
      confidence: "none",
      error: "page_dead",
      raw_excerpt: { http_status: 404, html_len: fc.html.length },
    };
  } else {
    const parsed = extractFromHtml(portal, fc.html);
    const conf: AgencyExtraction["confidence"] =
      parsed.method === "jsonld" || parsed.method === "next_data" || parsed.method === "casa_title_attr" || parsed.method === "immobiliare_agency_url" ? "high"
      : parsed.method === "casa_contact_block" || parsed.method === "idealista_pro_block" || parsed.method === "subito_shop" ? "medium"
      : parsed.method === "casa_logo_alt" ? "low"
      : "none";
    ext = {
      raw_agency_name: parsed.name,
      normalized_agency_name: normalizeAgency(parsed.name),
      agency_url: parsed.url,
      agency_phone: parsed.phone,
      agency_logo_url: parsed.logo,
      extraction_method: parsed.method,
      confidence: parsed.name ? conf : "none",
      error: parsed.method === "blocked_by_antibot" ? "blocked_by_antibot" : (parsed.name ? null : "agency_not_found"),
      raw_excerpt: { http_status: fc.status, html_len: fc.html.length },
    };
  }

  // Persist cache
  try {
    await c.from("listing_agency_enrichment").upsert({
      listing_url: listingUrl,
      portal,
      raw_agency_name: ext.raw_agency_name,
      normalized_agency_name: ext.normalized_agency_name,
      agency_url: ext.agency_url,
      agency_phone: ext.agency_phone,
      agency_logo_url: ext.agency_logo_url,
      extraction_method: ext.extraction_method,
      confidence: ext.confidence,
      enriched_at: new Date().toISOString(),
      error: ext.error,
      raw_excerpt: ext.raw_excerpt,
    }, { onConflict: "listing_url" });
  } catch { /* ignore cache write errors */ }

  return { ...ext, from_cache: false };
}
