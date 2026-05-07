// ═══════════════════════════════════════════════════════════════
// Ribassi Portali — Cross-portal intelligence
// ═══════════════════════════════════════════════════════════════
//
// Pipeline:
// 1. Scrape parallelo Immobiliare + Idealista + Casa.it
// 2. Per ogni listing: calcolo identity_hash (fuzzy cross-portal)
// 3. Persisto snapshot + aggiorno listing_identity (sources_seen, agencies_seen)
// 4. Rilevo anomalie: cross_portal_reappear, agency_swap, price_jump
// 5. Calcolo motivated seller score (drops + days_online)
// 6. Drop singolo > 10% in 90gg → opportunità "ribasso"
//
// "Meglio assente che fragile": se manca lat/lng/sqm → no identity_hash
// → annuncio salvato come snapshot ma escluso dal cross-portal matching.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { OpportunitaOffMarket } from "./radarOpportunita.ts";
import { scrapeAllPortals, type NormalizedListing } from "./portalScrapers.ts";
import { computeIdentityHash, roundCoord } from "./listingIdentity.ts";

const MIN_DROP_PERCENT = 10;
const HISTORY_WINDOW_DAYS = 90;

// Soglie adattive (scelta utente)
const FATIGUE_RULES = {
  caldissimo: { minDrops: 2, dropPct: 5, minDaysOnline: 180 },
  caldo:      { minDrops: 2, dropPct: 5, minDaysOnline: 90 },
  tiepido:    { minDrops: 1, dropPct: 5, minDaysOnline: 120, totalDropPct: 15 },
};

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

interface IdentityRow {
  identity_hash: string;
  sources_seen: string[];
  agencies_seen: string[];
  listing_ids_seen: string[];
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

async function upsertIdentity(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  l: NormalizedListing,
  identity_hash: string,
  municipality: string,
): Promise<{ row: IdentityRow | null; isNewSource: boolean; isNewAgency: boolean }> {
  const { data: existing } = await supabase
    .from("listing_identity")
    .select("*")
    .eq("identity_hash", identity_hash)
    .maybeSingle();

  if (!existing) {
    const insertRow = {
      identity_hash,
      lat_rounded: roundCoord(l.lat),
      lng_rounded: roundCoord(l.lng),
      surface_sqm: l.surface_sqm,
      property_type: l.property_type,
      rooms: l.rooms,
      municipality,
      sources_seen: [l.source],
      agencies_seen: l.agency_name ? [l.agency_name] : [],
      listing_ids_seen: [l.listing_id],
      observation_count: 1,
    };
    const { data: inserted } = await supabase
      .from("listing_identity")
      .insert(insertRow)
      .select("*")
      .maybeSingle();
    return { row: inserted as IdentityRow | null, isNewSource: false, isNewAgency: false };
  }

  const e = existing as IdentityRow;
  const sources = new Set(e.sources_seen ?? []);
  const agencies = new Set(e.agencies_seen ?? []);
  const ids = new Set(e.listing_ids_seen ?? []);
  const isNewSource = !sources.has(l.source);
  const isNewAgency = !!l.agency_name && agencies.size > 0 && !agencies.has(l.agency_name);
  sources.add(l.source);
  if (l.agency_name) agencies.add(l.agency_name);
  ids.add(l.listing_id);

  const { data: updated } = await supabase
    .from("listing_identity")
    .update({
      sources_seen: [...sources],
      agencies_seen: [...agencies],
      listing_ids_seen: [...ids],
      observation_count: (e.observation_count ?? 1) + 1,
      last_seen_at: new Date().toISOString(),
    })
    .eq("identity_hash", identity_hash)
    .select("*")
    .maybeSingle();
  return { row: updated as IdentityRow | null, isNewSource, isNewAgency };
}

async function recordAnomaly(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  identity_hash: string,
  type: "cross_portal_reappear" | "agency_swap" | "price_jump_after_disappear" | "duplicate_listing",
  municipality: string,
  province: string | null,
  payload: Record<string, unknown>,
  confidence: "high" | "medium" | "low" = "medium",
) {
  await supabase.from("market_anomalies").insert({
    identity_hash,
    anomaly_type: type,
    municipality,
    province,
    payload,
    confidence,
    expires_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
  });
}

interface FatigueComputation {
  drops_count: number;
  total_drop_pct: number;
  days_online: number;
  initial_price_eur: number | null;
  last_price_eur: number;
  label: "caldissimo" | "caldo" | "tiepido" | null;
  score: number;
}

async function computeFatigue(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  identity_hash: string,
  current_price: number,
): Promise<FatigueComputation | null> {
  const { data, error } = await supabase
    .from("listing_price_snapshots")
    .select("price_eur, captured_at, first_seen_at")
    .eq("identity_hash", identity_hash)
    .not("price_eur", "is", null)
    .order("captured_at", { ascending: true })
    .limit(200);
  if (error || !data || data.length === 0) return null;

  const prices = data
    .map((r) => ({ p: Number(r.price_eur), t: new Date(r.captured_at).getTime(), first: r.first_seen_at }))
    .filter((r) => Number.isFinite(r.p) && r.p > 0);
  if (prices.length === 0) return null;

  const initial = prices[0].p;
  const earliestSeen = prices.reduce<number>((acc, r) => {
    const t = r.first ? new Date(r.first).getTime() : r.t;
    return Number.isFinite(t) ? Math.min(acc, t) : acc;
  }, prices[0].t);
  const days_online = Math.max(0, Math.floor((Date.now() - earliestSeen) / 86_400_000));

  // Conta i ribassi reali (strict decrease > 1%)
  let drops_count = 0;
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].p;
    const cur = prices[i].p;
    const pct = ((prev - cur) / prev) * 100;
    if (pct >= 1) drops_count++;
  }
  // Considera anche il valore corrente vs ultimo snapshot
  const lastInDb = prices[prices.length - 1].p;
  if (current_price < lastInDb && ((lastInDb - current_price) / lastInDb) * 100 >= 1) {
    drops_count++;
  }

  const total_drop_pct = initial > 0 ? ((initial - current_price) / initial) * 100 : 0;

  let label: FatigueComputation["label"] = null;
  if (
    drops_count >= FATIGUE_RULES.caldissimo.minDrops &&
    days_online >= FATIGUE_RULES.caldissimo.minDaysOnline &&
    total_drop_pct >= FATIGUE_RULES.caldissimo.dropPct * FATIGUE_RULES.caldissimo.minDrops
  ) {
    label = "caldissimo";
  } else if (
    drops_count >= FATIGUE_RULES.caldo.minDrops &&
    days_online >= FATIGUE_RULES.caldo.minDaysOnline
  ) {
    label = "caldo";
  } else if (
    days_online >= FATIGUE_RULES.tiepido.minDaysOnline &&
    total_drop_pct >= FATIGUE_RULES.tiepido.totalDropPct
  ) {
    label = "tiepido";
  }

  // Score 0-100: pesa drops (40%) + days_online (30%) + total_drop_pct (30%)
  const score =
    Math.min(40, drops_count * 15) +
    Math.min(30, (days_online / 365) * 30) +
    Math.min(30, total_drop_pct);

  return {
    drops_count,
    total_drop_pct,
    days_online,
    initial_price_eur: initial,
    last_price_eur: current_price,
    label,
    score: Math.round(score * 10) / 10,
  };
}

export async function scrapeRibassiPortali(
  municipality: string,
  coords: { lat: number; lng: number } | null,
  province?: string,
): Promise<OpportunitaOffMarket[]> {
  console.log("[DEBUG ribassiPortali] input:", { municipality, province: province ?? null, hasCoords: !!coords });
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey || !municipality) {
    console.log("[DEBUG ribassiPortali] early-exit:", { hasKey: !!firecrawlKey, hasMunicipality: !!municipality });
    return [];
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.warn("[ribassiPortali] no service client — intelligence disabled");
    return [];
  }

  const listings = await scrapeAllPortals(municipality, firecrawlKey);
  console.log("[DEBUG ribassiPortali] scrapeAllPortals returned:", {
    municipality,
    total: listings.length,
    bySource: listings.reduce((acc: Record<string, number>, l) => { acc[l.source] = (acc[l.source] ?? 0) + 1; return acc; }, {}),
    sample: listings.slice(0, 2).map((l) => ({ source: l.source, title: l.title?.slice(0, 60), price_eur: l.price_eur, url: l.url?.slice(0, 80) })),
  });
  if (listings.length === 0) return [];

  const opportunita: OpportunitaOffMarket[] = [];
  const nowIso = new Date().toISOString();

  for (const l of listings) {
    if (l.price_eur === null) continue;

    const identity_hash = await computeIdentityHash({
      lat: l.lat ?? coords?.lat ?? null,
      lng: l.lng ?? coords?.lng ?? null,
      surface_sqm: l.surface_sqm,
      property_type: l.property_type,
      rooms: l.rooms,
    });

    // Snapshot persistente (anche senza identity_hash — tracciamo storico per listing_id)
    const { error: insErr } = await supabase.from("listing_price_snapshots").insert({
      listing_id: l.listing_id,
      source: l.source,
      url: l.url,
      price_eur: l.price_eur,
      municipality,
      province: province ?? null,
      lat: l.lat ?? coords?.lat ?? null,
      lng: l.lng ?? coords?.lng ?? null,
      raw_title: l.title,
      raw_address: l.address,
      first_seen_at: nowIso, // upsert logic: se già esiste, INSERT crea solo nuovo snapshot
      agency_name: l.agency_name,
      surface_sqm: l.surface_sqm,
      rooms: l.rooms,
      property_type: l.property_type,
      identity_hash,
    });
    if (insErr) console.warn("[ribassiPortali] snapshot insert:", insErr.message);

    if (!identity_hash) continue;

    // Identity tracking + anomaly detection
    const { row, isNewSource, isNewAgency } = await upsertIdentity(supabase, l, identity_hash, municipality);

    if (row && isNewSource && row.observation_count > 1) {
      // Stesso immobile riapparso su un nuovo portale: cross-portal anomaly
      await recordAnomaly(supabase, identity_hash, "cross_portal_reappear", municipality, province ?? null, {
        new_source: l.source,
        sources_seen: row.sources_seen,
        listing_id: l.listing_id,
        url: l.url,
        current_price_eur: l.price_eur,
      }, "high");

      opportunita.push({
        tipo: "ribasso",
        titolo: `Anomalia di Mercato: stesso immobile su più portali (${l.title.slice(0, 100)})`,
        descrizione: `Immobile in ${municipality} rilevato su ${row.sources_seen.join(" + ")}. Prezzo corrente €${new Intl.NumberFormat("it-IT").format(l.price_eur)}. Possibile cambio strategia di vendita.`.slice(0, 300),
        prezzoIndicativo: `€${new Intl.NumberFormat("it-IT").format(l.price_eur)}`,
        scontoStimato: "Cross-portal",
        localita: l.address ?? municipality,
        fonte: `Anomalia ${row.sources_seen.join("+")}`,
        evidenceUrl: l.url,
        categoria: l.property_type === "commerciale" ? "commerciale" : "residenziale",
        urgenza: "media",
      });
    }

    if (row && isNewAgency) {
      // Cambio agenzia: lead caldo
      await recordAnomaly(supabase, identity_hash, "agency_swap", municipality, province ?? null, {
        new_agency: l.agency_name,
        agencies_seen: row.agencies_seen,
        listing_id: l.listing_id,
        url: l.url,
      }, "high");
    }

    // Drop > 10% storico
    const cutoffISO = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: history } = await supabase
      .from("listing_price_snapshots")
      .select("price_eur, captured_at")
      .eq("identity_hash", identity_hash)
      .lte("captured_at", cutoffISO)
      .not("price_eur", "is", null)
      .order("captured_at", { ascending: true })
      .limit(1);

    if (history && history.length > 0) {
      const oldPrice = Number(history[0].price_eur);
      if (Number.isFinite(oldPrice) && oldPrice > 0) {
        const dropPct = ((oldPrice - l.price_eur) / oldPrice) * 100;
        if (dropPct >= MIN_DROP_PERCENT) {
          const dropFmt = dropPct.toFixed(1);
          const priceFmt = new Intl.NumberFormat("it-IT").format(l.price_eur);
          const oldFmt = new Intl.NumberFormat("it-IT").format(oldPrice);
          opportunita.push({
            tipo: "ribasso",
            titolo: `Ribasso ${dropFmt}% verificato: ${l.title.slice(0, 130)}`,
            descrizione: `Prezzo precedente €${oldFmt} → attuale €${priceFmt} (-${dropFmt}% in ${HISTORY_WINDOW_DAYS}gg). Margine di trattativa.`.slice(0, 300),
            prezzoIndicativo: `€${priceFmt}`,
            scontoStimato: `-${dropFmt}%`,
            localita: l.address ?? municipality,
            fonte: `Monitoraggio ${l.source}`,
            evidenceUrl: l.url,
            categoria: l.property_type === "commerciale" ? "commerciale" : "residenziale",
            urgenza: dropPct >= 20 ? "alta" : "media",
          });
        }
      }
    }

    // Motivated seller / Venditore Motivato
    const fatigue = await computeFatigue(supabase, identity_hash, l.price_eur);
    if (fatigue && fatigue.label) {
      await supabase.from("motivated_sellers").insert({
        identity_hash,
        listing_id: l.listing_id,
        source: l.source,
        url: l.url,
        municipality,
        province: province ?? null,
        first_seen_at: new Date(Date.now() - fatigue.days_online * 86_400_000).toISOString(),
        last_price_eur: fatigue.last_price_eur,
        initial_price_eur: fatigue.initial_price_eur,
        total_drop_pct: fatigue.total_drop_pct,
        drops_count: fatigue.drops_count,
        days_online: fatigue.days_online,
        fatigue_score: fatigue.score,
        fatigue_label: fatigue.label,
        payload: { title: l.title, agency: l.agency_name, address: l.address },
      });

      if (fatigue.label === "caldissimo") {
        opportunita.push({
          tipo: "ribasso",
          titolo: `Proprietario in fase di stanchezza: ${l.title.slice(0, 110)}`,
          descrizione: `${fatigue.drops_count} ribassi in ${fatigue.days_online}gg, sconto totale ${fatigue.total_drop_pct.toFixed(1)}%. Lead ad alta probabilità di chiusura.`.slice(0, 300),
          prezzoIndicativo: `€${new Intl.NumberFormat("it-IT").format(l.price_eur)}`,
          scontoStimato: `-${fatigue.total_drop_pct.toFixed(1)}% totale`,
          localita: l.address ?? municipality,
          fonte: `Lead caldissimo (${l.source})`,
          evidenceUrl: l.url,
          categoria: l.property_type === "commerciale" ? "commerciale" : "residenziale",
          urgenza: "alta",
        });
      }
    }

    if (opportunita.length >= 12) break;
  }

  return opportunita;
}
