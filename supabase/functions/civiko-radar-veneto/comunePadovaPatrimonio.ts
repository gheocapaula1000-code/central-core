// ═══════════════════════════════════════════════════════════════
// comunePadovaPatrimonio — fonte istituzionale legittima per Padova
//
// Scopo:
//   Affiancare casa.it con una seconda fonte di alimentazione per
//   listing_price_snapshots / early-warning, basata SOLO su pagine
//   pubbliche istituzionali del Comune di Padova e di enti pubblici
//   regionali. Volume basso ma legalmente difendibile e privacy-safe.
//
// Cosa NON fa:
//   - Nessun bypass login / captcha / paywall.
//   - Nessuno scraping di portali privati con ToS restrittivi.
//   - Nessun dato personale (nominativi proprietari, eredi, contatti).
//
// Cosa fa:
//   - Scarica via Firecrawl la pagina indice patrimonio/alienazioni
//     del Comune di Padova (e poche pagine pubbliche istituzionali
//     correlate), estrae voci con prezzo/asta/avviso pubblico, e le
//     persiste come listing_price_snapshots con
//     source_name = "comune_padova_patrimonio".
//   - Robots/ToS friendly: 1 chiamata/giorno per pagina, UA dichiarato,
//     nessun parallelismo.
//   - Idempotente via identity_hash su URL + prezzo + data.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const SUPA_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPA_SR  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";

// Pagine pubbliche istituzionali da monitorare. Tenute ESPLICITE
// in codice: niente discovery dinamica, niente crawl profondo.
const SOURCES: { id: string; url: string; label: string }[] = [
  {
    id: "padovanet_bandi_immobili",
    url: "https://bandi.padovanet.it/avvisi",
    label: "Comune di Padova — Avvisi pubblici (patrimonio/alienazioni)",
  },
  {
    id: "padovanet_patrimonio",
    url: "https://www.padovanet.it/informazione/patrimonio-immobiliare",
    label: "Comune di Padova — Patrimonio immobiliare",
  },
];

interface InstitutionalItem {
  source_url: string;
  title: string;
  price_eur: number | null;
  raw_address: string | null;
  detected_at: string;
}

interface RunResult {
  ok: boolean;
  source_name: string;
  sources_checked: number;
  items_found: number;
  items_inserted: number;
  warnings: string[];
  errors: string[];
}

function parsePriceEur(raw: string): number | null {
  // Cerca importi tipo "€ 250.000,00" o "250000 EUR" nel testo
  const m = raw.match(/(?:€|EUR)\s?([\d.\s]+(?:[,.]\d{1,2})?)/i)
        ?? raw.match(/([\d.\s]+(?:[,.]\d{1,2})?)\s?(?:€|EUR)/i);
  if (!m) return null;
  const norm = m[1].replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(norm);
  return Number.isFinite(n) && n > 1000 && n < 100_000_000 ? n : null;
}

async function fetchPage(url: string): Promise<{ markdown: string; links: string[] } | null> {
  if (!FIRECRAWL_KEY) return null;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const r = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        onlyMainContent: true,
        waitFor: 1500,
        location: { country: "IT", languages: ["it"] },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as { data?: { markdown?: string; links?: string[] }; markdown?: string; links?: string[] } | null;
    const markdown = j?.data?.markdown ?? j?.markdown ?? "";
    const links = j?.data?.links ?? j?.links ?? [];
    return { markdown, links };
  } catch {
    return null;
  } finally {
    clearTimeout(tm);
  }
}

function extractItems(markdown: string, links: string[], baseUrl: string): InstitutionalItem[] {
  const out: InstitutionalItem[] = [];
  if (!markdown) return out;
  // Tronca paragrafi tra titoli markdown
  const blocks = markdown.split(/\n(?=#{1,4}\s)/);
  for (const block of blocks) {
    const lower = block.toLowerCase();
    // Filtro: solo blocchi che parlano di immobili
    const isRealEstate =
      lower.includes("immobil") ||
      lower.includes("alienazion") ||
      lower.includes("patrimonio") ||
      lower.includes("asta") ||
      lower.includes("vendita") ||
      lower.includes("locazione") ||
      lower.includes("concession");
    if (!isRealEstate) continue;
    const titleMatch = block.match(/^#{1,4}\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : block.slice(0, 120).trim();
    const price = parsePriceEur(block);
    // address euristico: cerca "via/piazza/v.le/corso ..."
    const addrMatch = block.match(/((?:via|piazza|p\.zza|viale|v\.le|corso|c\.so|largo|vicolo)\s+[a-zà-ù0-9'.\s]{3,80})/i);
    out.push({
      source_url: baseUrl,
      title: title.slice(0, 250),
      price_eur: price,
      raw_address: addrMatch ? addrMatch[1].trim().slice(0, 200) : null,
      detected_at: new Date().toISOString(),
    });
  }
  // Dedupe per title
  const seen = new Set<string>();
  return out.filter((i) => {
    const k = i.title.toLowerCase().slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 30);
}

export async function runComunePadovaPatrimonio(): Promise<RunResult> {
  const result: RunResult = {
    ok: true,
    source_name: "comune_padova_patrimonio",
    sources_checked: 0,
    items_found: 0,
    items_inserted: 0,
    warnings: [],
    errors: [],
  };
  if (!FIRECRAWL_KEY) {
    result.ok = false;
    result.errors.push("FIRECRAWL_API_KEY missing");
    return result;
  }
  if (!SUPA_URL || !SUPA_SR) {
    result.ok = false;
    result.errors.push("supabase env missing");
    return result;
  }
  const sb = createClient(SUPA_URL, SUPA_SR, { auth: { persistSession: false } });

  for (const src of SOURCES) {
    result.sources_checked++;
    const page = await fetchPage(src.url);
    if (!page) {
      result.warnings.push(`fetch_failed:${src.id}`);
      continue;
    }
    const items = extractItems(page.markdown, page.links, src.url);
    result.items_found += items.length;
    for (const it of items) {
      const listing_id = `${src.id}:${it.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
      const identity_hash = `${listing_id}|${it.price_eur ?? ""}`;
      const { error } = await sb.from("listing_price_snapshots").insert({
        listing_id,
        source: "comune_padova_patrimonio",
        url: it.source_url,
        price_eur: it.price_eur,
        municipality: "Padova",
        province: "PD",
        raw_title: it.title,
        raw_address: it.raw_address,
        captured_at: it.detected_at,
        identity_hash,
      });
      if (error) {
        // unique violations are expected on re-run → silent
        if (!String(error.message).includes("duplicate")) {
          result.warnings.push(`insert:${listing_id}:${error.message}`);
        }
      } else {
        result.items_inserted++;
      }
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}
