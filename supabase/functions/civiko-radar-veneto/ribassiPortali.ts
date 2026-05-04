import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { OpportunitaOffMarket } from "./radarOpportunita.ts";

/**
 * Ribassi reali su portali immobiliari (Immobiliare.it via Firecrawl).
 *
 * Pipeline:
 * 1. Scrape pagina ricerca città (annunci ordinati per recente)
 * 2. Per ogni annuncio: salva snapshot (listing_price_snapshots)
 * 3. Confronta con storico ≥ 90 giorni dello stesso listing_id
 * 4. Emetti opportunità SOLO se drop > 10% verificato sui dati storici
 *
 * Strict-fallback: nessun dato inventato. Se manca storico → nessun segnale.
 */

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const MIN_DROP_PERCENT = 10;
const HISTORY_WINDOW_DAYS = 90;
const MAX_LISTINGS_PER_RUN = 25;

interface ScrapedListing {
  listing_id: string;
  url: string;
  title: string;
  address: string | null;
  price_eur: number | null;
}

function parsePriceEur(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).replace(/[^0-9,.\s]/g, "").trim();
  if (!s) return null;
  // Italian format: "350.000" or "350.000,50" → 350000 / 350000.50
  const normalized = s.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) && n > 1000 && n < 100_000_000 ? n : null;
}

function deriveListingId(url: string): string | null {
  // Immobiliare.it: /annunci/<id>/ or /vendita-case/<...>/<id>/
  const m = url.match(/\/(\d{6,})(?:[/?]|$)/);
  return m ? `imm-${m[1]}` : null;
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function firecrawlScrape(searchUrl: string, firecrawlKey: string): Promise<ScrapedListing[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: searchUrl,
        formats: [{
          type: "json",
          prompt:
            "Estrai la lista degli annunci immobiliari presenti nella pagina. Per ciascuno: titolo, indirizzo (se visibile), prezzo numerico in euro, link assoluto all'annuncio. Solo dati realmente presenti.",
          schema: {
            type: "object",
            properties: {
              listings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    address: { type: "string" },
                    price: { type: "string" },
                    link: { type: "string" },
                  },
                  required: ["title", "price", "link"],
                },
              },
            },
          },
        }],
        onlyMainContent: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items: unknown =
      data?.data?.json?.listings ?? data?.json?.listings ?? data?.data?.extract?.listings ?? [];
    if (!Array.isArray(items)) return [];

    const out: ScrapedListing[] = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const r = it as Record<string, unknown>;
      const link = typeof r.link === "string" ? r.link : null;
      if (!link || !link.startsWith("http")) continue;
      const id = deriveListingId(link);
      if (!id) continue;
      const price = parsePriceEur(r.price);
      out.push({
        listing_id: id,
        url: link.slice(0, 400),
        title: typeof r.title === "string" ? r.title.slice(0, 200) : "Annuncio",
        address: typeof r.address === "string" ? r.address.slice(0, 200) : null,
        price_eur: price,
      });
      if (out.length >= MAX_LISTINGS_PER_RUN) break;
    }
    return out;
  } catch (e) {
    console.error("[ribassiPortali] firecrawl error:", e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function scrapeRibassiPortali(
  municipality: string,
  coords: { lat: number; lng: number } | null,
): Promise<OpportunitaOffMarket[]> {
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey || !municipality) return [];

  const supabase = getServiceClient();
  if (!supabase) {
    console.warn("[ribassiPortali] no service client — drop detection disabled");
    return [];
  }

  const slug = municipality.toLowerCase().trim().replace(/\s+/g, "-");
  const searchUrl = `https://www.immobiliare.it/vendita-case/${slug}/?ordinamento=dataModifica`;

  const listings = await firecrawlScrape(searchUrl, firecrawlKey);
  if (listings.length === 0) return [];

  // Persist snapshots (best-effort, non-blocking on errors)
  const snapshotRows = listings
    .filter((l) => l.price_eur !== null)
    .map((l) => ({
      listing_id: l.listing_id,
      source: "immobiliare.it",
      url: l.url,
      price_eur: l.price_eur,
      municipality,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      raw_title: l.title,
      raw_address: l.address,
    }));

  if (snapshotRows.length > 0) {
    const { error: insErr } = await supabase
      .from("listing_price_snapshots")
      .insert(snapshotRows);
    if (insErr) console.error("[ribassiPortali] snapshot insert:", insErr.message);
  }

  // Per ogni listing, lookup storico ≥ 90gg e calcola drop
  const cutoffISO = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
  const opportunita: OpportunitaOffMarket[] = [];

  for (const l of listings) {
    if (l.price_eur === null) continue;

    const { data: history, error: histErr } = await supabase
      .from("listing_price_snapshots")
      .select("price_eur, captured_at")
      .eq("listing_id", l.listing_id)
      .lte("captured_at", cutoffISO)
      .not("price_eur", "is", null)
      .order("captured_at", { ascending: true })
      .limit(1);

    if (histErr || !history || history.length === 0) continue;
    const oldPrice = Number(history[0].price_eur);
    if (!Number.isFinite(oldPrice) || oldPrice <= 0) continue;

    const dropPct = ((oldPrice - l.price_eur) / oldPrice) * 100;
    if (dropPct < MIN_DROP_PERCENT) continue;

    const dropFmt = dropPct.toFixed(1);
    const priceFmt = new Intl.NumberFormat("it-IT").format(l.price_eur);
    const oldPriceFmt = new Intl.NumberFormat("it-IT").format(oldPrice);

    opportunita.push({
      tipo: "ribasso",
      titolo: `Ribasso ${dropFmt}% verificato: ${l.title.slice(0, 140)}`,
      descrizione: `Prezzo precedente €${oldPriceFmt} → attuale €${priceFmt} (-${dropFmt}% in ${HISTORY_WINDOW_DAYS}gg). Possibile margine di trattativa.`.slice(0, 300),
      prezzoIndicativo: `€${priceFmt}`,
      scontoStimato: `-${dropFmt}%`,
      localita: l.address ?? municipality,
      fonte: "Monitoraggio prezzi Immobiliare.it",
      evidenceUrl: l.url,
      categoria: "residenziale",
      urgenza: dropPct >= 20 ? "alta" : "media",
    });

    if (opportunita.length >= 5) break;
  }

  return opportunita;
}
