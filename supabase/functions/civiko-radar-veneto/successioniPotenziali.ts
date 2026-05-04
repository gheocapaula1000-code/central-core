import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { OpportunitaOffMarket } from "./radarOpportunita.ts";

/**
 * Successioni potenziali — Pipeline reale:
 *
 * 1. Carica fonti attive da `obituaries_sources` (region=veneto)
 * 2. Per ciascuna fonte: scrape via Firecrawl con template URL
 * 3. Dedupe via fingerprint (sha256 cognome|comune|data) su `obituaries_seen`
 * 4. Geocoding del comune (Mapbox) → lookup OMI zona via omi_zone_by_point
 * 5. Filtro: emetti segnale SOLO se zona OMI ha tipologia residenziale (Abitazioni civili/economiche/signorili)
 *    E se ISTAT del comune indica indice vecchiaia elevato (>150 = molti anziani vs giovani)
 *
 * Strict-fallback: nessun segnale se manca geocoding, OMI o ISTAT.
 * Pseudonimizzazione: storage solo cognome + comune (no nome completo, no indirizzo personale).
 */

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const MAX_OBITUARIES_PER_SOURCE = 20;
const MAX_SIGNALS = 5;
const INDICE_VECCHIAIA_SOGLIA = 150;
const OMI_TIPOLOGIE_RESIDENZIALI = [
  "abitazioni civili",
  "abitazioni economiche",
  "abitazioni signorili",
  "abitazioni di tipo economico",
  "ville e villini",
];

interface ObituarySource {
  id: number;
  name: string;
  search_url_template: string;
}

interface ScrapedObituary {
  surname: string;
  death_date: string | null;
  source_url: string;
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeSurname(full: string): string | null {
  const parts = full.trim().replace(/[^\p{L}\s'-]/gu, "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  // Heuristic Italian: surname is first token (LASTNAME Firstname format on most necrologie)
  // ma supportiamo anche "Firstname LASTNAME" → prendiamo l'ultimo capitalizzato
  const upper = parts.find((p) => p === p.toUpperCase() && p.length > 2);
  return (upper ?? parts[parts.length - 1]).slice(0, 80);
}

function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  const iso = `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

async function fetchSources(
  supabase: ReturnType<typeof getServiceClient>,
): Promise<ObituarySource[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("obituaries_sources")
    .select("id, name, search_url_template")
    .eq("is_active", true)
    .eq("region", "veneto")
    .order("reliability_score", { ascending: false })
    .limit(3);
  if (error || !data) return [];
  return data as ObituarySource[];
}

async function scrapeSource(
  source: ObituarySource,
  municipality: string,
  firecrawlKey: string,
): Promise<ScrapedObituary[]> {
  const url = source.search_url_template
    .replace("{municipality}", encodeURIComponent(municipality.toLowerCase()))
    .replace("{region}", "veneto");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: [{
          type: "json",
          prompt:
            "Estrai i necrologi presenti nella pagina relativi al comune indicato. Per ciascuno: nome e cognome del defunto (se visibile), data del decesso (formato GG/MM/AAAA), link permanente al necrologio. Solo dati realmente presenti.",
          schema: {
            type: "object",
            properties: {
              obituaries: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    full_name: { type: "string" },
                    death_date: { type: "string" },
                    permalink: { type: "string" },
                  },
                  required: ["full_name", "permalink"],
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
      data?.data?.json?.obituaries ?? data?.json?.obituaries ?? data?.data?.extract?.obituaries ?? [];
    if (!Array.isArray(items)) return [];

    const out: ScrapedObituary[] = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const r = it as Record<string, unknown>;
      const fullName = typeof r.full_name === "string" ? r.full_name : "";
      const link = typeof r.permalink === "string" ? r.permalink : "";
      if (!fullName || !link.startsWith("http")) continue;
      const surname = normalizeSurname(fullName);
      if (!surname) continue;
      out.push({
        surname,
        death_date: parseDate(typeof r.death_date === "string" ? r.death_date : null),
        source_url: link.slice(0, 400),
      });
      if (out.length >= MAX_OBITUARIES_PER_SOURCE) break;
    }
    return out;
  } catch (e) {
    console.error(`[successioni] source ${source.name} error:`, e instanceof Error ? e.message : String(e));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeMunicipality(
  municipality: string,
  province: string | null,
): Promise<{ lat: number; lng: number; cap: string | null } | null> {
  const key = Deno.env.get("MAPBOX_API_KEY");
  if (!key) return null;
  const q = encodeURIComponent(`${municipality}${province ? `, ${province}` : ""}, Italia`);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?country=IT&limit=1&types=place,postcode&access_token=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const feat = data?.features?.[0];
    const center = feat?.center;
    if (!Array.isArray(center) || center.length !== 2) return null;
    // Extract CAP from context (postcode) o dal feature stesso
    let cap: string | null = null;
    const ctx = Array.isArray(feat?.context) ? feat.context : [];
    for (const c of ctx) {
      if (typeof c?.id === "string" && c.id.startsWith("postcode") && typeof c.text === "string") {
        cap = c.text.match(/^\d{5}$/)?.[0] ?? null;
        break;
      }
    }
    if (!cap && feat?.id?.startsWith?.("postcode") && typeof feat?.text === "string") {
      cap = feat.text.match(/^\d{5}$/)?.[0] ?? null;
    }
    return { lng: Number(center[0]), lat: Number(center[1]), cap };
  } catch {
    return null;
  }
}

async function lookupOmiTipologia(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  lat: number,
  lng: number,
): Promise<{ link_zona: string; zona_descr: string; tipologia: string | null } | null> {
  const { data: zoneData, error: zoneErr } = await supabase
    .rpc("omi_zone_by_point", { p_lat: lat, p_lng: lng });
  if (zoneErr || !zoneData || zoneData.length === 0) return null;
  const zone = zoneData[0] as { link_zona: string; zona_descr: string };

  const { data: omi, error: omiErr } = await supabase
    .from("omi_zone")
    .select("descr_tip_prev")
    .eq("link_zona", zone.link_zona)
    .limit(1);
  if (omiErr) return null;

  const tipologia = (omi?.[0] as { descr_tip_prev?: string } | undefined)?.descr_tip_prev ?? null;
  return { link_zona: zone.link_zona, zona_descr: zone.zona_descr, tipologia };
}

async function fetchIstatVecchiaia(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  municipality: string,
): Promise<{ indice: number | null; over75: number | null }> {
  const { data, error } = await supabase
    .from("istat_comuni")
    .select("indice_vecchiaia, percentuale_75_84, percentuale_over85, percentuale_over65")
    .ilike("comune", municipality)
    .limit(1);
  if (error || !data || data.length === 0) return { indice: null, over75: null };
  const r = data[0] as {
    indice_vecchiaia: number | null;
    percentuale_75_84: number | null;
    percentuale_over85: number | null;
    percentuale_over65: number | null;
  };
  const over75 = r.percentuale_75_84 !== null && r.percentuale_over85 !== null
    ? Number(r.percentuale_75_84) + Number(r.percentuale_over85)
    : null;
  return { indice: r.indice_vecchiaia, over75 };
}

export async function scrapeSuccessioniPotenziali(
  municipality: string,
  province?: string,
): Promise<OpportunitaOffMarket[]> {
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey || !municipality) return [];

  const supabase = getServiceClient();
  if (!supabase) return [];

  const sources = await fetchSources(supabase);
  if (sources.length === 0) return [];

  // Scrape parallelo, max 3 fonti
  const scrapeResults = await Promise.all(
    sources.map((s) =>
      scrapeSource(s, municipality, firecrawlKey)
        .then((r) => ({ source: s, items: r }))
        .catch(() => ({ source: s, items: [] as ScrapedObituary[] }))
    ),
  );

  // Lookup geo + OMI + ISTAT (una sola volta per comune)
  const coords = await geocodeMunicipality(municipality, province ?? null);
  const omi = coords ? await lookupOmiTipologia(supabase, coords.lat, coords.lng) : null;
  const istat = await fetchIstatVecchiaia(supabase, municipality);

  // Filtro qualità del segnale
  const tipologiaOk = omi?.tipologia
    ? OMI_TIPOLOGIE_RESIDENZIALI.some((t) => omi.tipologia!.toLowerCase().includes(t))
    : false;
  const vecchiaiaOk = istat.indice !== null && Number(istat.indice) >= INDICE_VECCHIAIA_SOGLIA;

  if (!tipologiaOk || !vecchiaiaOk) {
    console.log(
      `[successioni] ${municipality}: filtro non passato (tipologia=${omi?.tipologia ?? "n/d"}, indice_vecchiaia=${istat.indice ?? "n/d"})`,
    );
    return [];
  }

  const opportunita: OpportunitaOffMarket[] = [];
  for (const { source, items } of scrapeResults) {
    for (const ob of items) {
      const fingerprint = await sha256Hex(
        `${ob.surname.toUpperCase()}|${municipality.toUpperCase()}|${ob.death_date ?? ""}`,
      );

      // Dedup: skip se già visto negli ultimi 90gg
      const { data: existing } = await supabase
        .from("obituaries_seen")
        .select("id")
        .eq("fingerprint", fingerprint)
        .limit(1);
      if (existing && existing.length > 0) continue;

      // Insert (idempotente via UNIQUE constraint)
      const { error: insErr } = await supabase.from("obituaries_seen").insert({
        fingerprint,
        surname: ob.surname,
        municipality,
        province: province ?? null,
        death_date: ob.death_date,
        source_id: source.id,
        source_url: ob.source_url,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        cap: coords?.cap ?? null,
        omi_link_zona: omi.link_zona,
        omi_zona_descr: omi.zona_descr,
        omi_tipologia: omi.tipologia,
      });
      if (insErr && !insErr.message.includes("duplicate")) {
        console.error("[successioni] insert error:", insErr.message);
        continue;
      }

      const dataFmt = ob.death_date
        ? new Date(ob.death_date).toLocaleDateString("it-IT")
        : "data non specificata";

      opportunita.push({
        tipo: "successione",
        titolo: `Possibile successione famiglia ${ob.surname} — zona ${omi.zona_descr}`,
        descrizione:
          `Decesso registrato (${dataFmt}). Zona OMI residenziale (${omi.tipologia}), comune con indice di vecchiaia ${Number(istat.indice).toFixed(0)}. Possibile incarico di vendita nei prossimi 6-18 mesi.`
            .slice(0, 300),
        prezzoIndicativo: null,
        scontoStimato: "Trattativa privata",
        localita: `${omi.zona_descr}, ${municipality}`,
        fonte: source.name,
        evidenceUrl: ob.source_url,
        categoria: "residenziale",
        urgenza: "bassa",
      });

      if (opportunita.length >= MAX_SIGNALS) break;
    }
    if (opportunita.length >= MAX_SIGNALS) break;
  }

  return opportunita;
}
