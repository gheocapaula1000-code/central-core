// core-offmarket-list-public
// Endpoint pubblico (no auth) che aggrega i segnali off-market per Padova
// da 4 fonti: eventi vita legali, successioni potenziali, annunci in difficolta',
// patrimonio Comune di Padova.
//
// Contratto completezza (fail-closed):
//  - ogni fonte viene letta con paginazione interna fino a un cap esplicito;
//  - se una fonte raggiunge il cap, lo snapshot NON è probante: la risposta è
//    ok:false / snapshot_complete:false, senza totals presentati come veri;
//  - `source_counts` e `source_caps` sono sempre esposti;
//  - la risposta finale è paginata (limit/offset) con `total` autorevole.
// Privacy, esclusione aste e perimetro restano invariati.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { isAuctionRecord } from "../_shared/auctionExclusion.ts";
import {
  VALID_COMMERCIAL_ZONE_SLUGS,
  isValidCommercialZoneSlug,
  buildOmiToSlugMap,
  assignCommercialZonesBatch,
  type ActiveZoneRow,
  type CommercialZoneSlug,
} from "../_shared/commercialZoneMapping.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/** Cap esplicito per fonte: superarlo significa snapshot non probante. */
export const SOURCE_CAP = 5000;
const PAGE_SIZE = 1000;
export const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 100;

type Item = {
  id: string;
  fonte: "legal_life_events" | "successioni" | "distress" | "patrimonio_comunale";
  badge: "Evento Vita" | "Successione" | "Distress" | "Patrimonio Comunale";
  titolo: string;
  indirizzo: string;
  zona: string;
  prezzo_eur: number | null;
  mq: number | null;
  url_sorgente: string | null;
  data_segnalazione: string;
  note: string | null;
  commercial_zone_slug: CommercialZoneSlug | null;
  zone_match_method: string;
  zone_match_confidence: number | null;
  // record grezzo per risoluzione zona post-hoc (rimosso prima della serializzazione)
  __resolveInput?: Record<string, unknown> | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/**
 * Legge TUTTE le righe di una fonte con paginazione interna.
 * `truncated` = la fonte ha raggiunto il cap: lo snapshot non è completo.
 */
async function fetchAllRows(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> },
  cap = SOURCE_CAP,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1;
    const { data, error } = await build().range(from, to);
    if (error) {
      return { rows, truncated: false, error: (error as { message?: string }).message ?? "read_failed" };
    }
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < to - from + 1) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const url = new URL(req.url);
  const commercialZoneFilterRaw = url.searchParams.get("commercial_zone_slug");
  const commercialZoneFilter = commercialZoneFilterRaw && commercialZoneFilterRaw.trim()
    ? commercialZoneFilterRaw.trim()
    : null;
  if (commercialZoneFilter !== null && !isValidCommercialZoneSlug(commercialZoneFilter)) {
    return json({
      ok: false,
      error: "INVALID_SLUG",
      message: `commercial_zone_slug non valido: '${commercialZoneFilter}'`,
      allowed: VALID_COMMERCIAL_ZONE_SLUGS,
    }, 400);
  }

  const limitRaw = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_PAGE_LIMIT), 10);
  const pageLimit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const pageOffsetReq = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  // Carica una sola volta le zone commerciali attive.
  const { data: zonesRows } = await supabase
    .from("civiko_commercial_zones")
    .select("slug, omi_codes, attiva")
    .eq("attiva", true);
  const activeZones: ActiveZoneRow[] = (zonesRows ?? []).map((z: any) => ({
    slug: String(z.slug ?? ""),
    omi_codes: Array.isArray(z.omi_codes) ? (z.omi_codes as string[]) : [],
  }));
  const omiToSlug = buildOmiToSlugMap(activeZones);

  const items: Item[] = [];
  const totals = {
    legal_life_events: 0,
    successioni: 0,
    distress: 0,
    patrimonio_comunale: 0,
    total: 0,
  };
  const sourceCounts: Record<string, number> = {};
  const sourceCaps: Record<string, number> = {
    legal_life_events: SOURCE_CAP,
    successioni: SOURCE_CAP,
    distress: SOURCE_CAP,
    patrimonio_comunale: SOURCE_CAP,
  };
  const truncatedSources: string[] = [];

  const failClosed = (extra: Record<string, unknown>, status: number) =>
    json({
      ok: false,
      snapshot_complete: false,
      updated_at: new Date().toISOString(),
      commercial_zone_filter: commercialZoneFilter,
      source_counts: sourceCounts,
      source_caps: sourceCaps,
      truncated_sources: truncatedSources,
      items: [],
      ...extra,
    }, status);

  try {
    // 1) Legal life events (Padova, privacy-safe attivi)
    // Esclusione aste: riusa auctionExclusion.ts (guardia condivisa).
    const lleRes = await fetchAllRows(() =>
      supabase
        .from("legal_life_event_signals")
        .select("id, signal_type, source_name, source_url, event_date, detected_at, area_or_microzone, property_hint, explanation")
        .ilike("municipality", "padova")
        .eq("is_active", true)
        .eq("privacy_safe", true)
        .eq("pii_redacted", true)
        .eq("contains_personal_data", false)
        .order("detected_at", { ascending: false })
        .order("id", { ascending: false }) as never
    );
    if (lleRes.error) return failClosed({ error: "legal_life_events_read_failed", message: lleRes.error }, 500);
    sourceCounts.legal_life_events = lleRes.rows.length;
    if (lleRes.truncated) truncatedSources.push("legal_life_events");

    let lleAuctionExcluded = 0;
    for (const r of lleRes.rows) {
      if (isAuctionRecord(r)) {
        lleAuctionExcluded++;
        continue;
      }
      items.push({
        id: `lle-${r.id}`,
        fonte: "legal_life_events",
        badge: "Evento Vita",
        titolo: (r.explanation as string) ?? (r.signal_type as string) ?? "Segnalazione evento di vita",
        indirizzo: (r.property_hint as string) ?? "Padova",
        zona: (r.area_or_microzone as string) ?? "Padova",
        prezzo_eur: null,
        mq: null,
        url_sorgente: (r.source_url as string) ?? null,
        data_segnalazione: ((r.event_date ?? r.detected_at ?? new Date().toISOString()) as string).toString(),
        note: (r.source_name as string) ?? null,
        commercial_zone_slug: null,
        zone_match_method: "unresolved",
        zone_match_confidence: null,
        __resolveInput: {
          address: r.property_hint ?? "",
          zona: r.area_or_microzone ?? "",
          quartiere: r.area_or_microzone ?? "",
          title: r.explanation ?? "",
        },
      });
      totals.legal_life_events++;
    }
    (totals as Record<string, number>).legal_life_events_auction_excluded = lleAuctionExcluded;

    // 2) Successioni potenziali (aggregate only, mai nominativi/PII)
    const succRes = await fetchAllRows(() =>
      supabase
        .from("inheritance_pressure_signals")
        .select("id, area_label, area_type, score, signal_basis, source_urls, source_names, computed_at, indicators, standard_radar_visible, agency_private_only")
        .ilike("comune", "padova")
        .eq("is_active", true)
        .eq("standard_radar_visible", true)
        .eq("agency_private_only", false)
        .order("computed_at", { ascending: false })
        .order("id", { ascending: false }) as never
    );
    if (succRes.error) return failClosed({ error: "successioni_read_failed", message: succRes.error }, 500);
    sourceCounts.successioni = succRes.rows.length;
    if (succRes.truncated) truncatedSources.push("successioni");

    for (const r of succRes.rows) {
      if (isAuctionRecord(r)) continue;
      const srcUrl = Array.isArray(r.source_urls) && r.source_urls.length ? (r.source_urls as string[])[0] : null;
      const nomeFonte = Array.isArray(r.source_names) && (r.source_names as string[]).length
        ? (r.source_names as string[]).join(", ")
        : null;
      items.push({
        id: `succ-${r.id}`,
        fonte: "successioni",
        badge: "Successione",
        titolo: `Pressione successoria ${r.area_label ?? "Padova"}`,
        indirizzo: (r.area_label as string) ?? "Padova",
        zona: (r.area_label as string) ?? "Padova",
        prezzo_eur: null,
        mq: null,
        url_sorgente: srcUrl,
        data_segnalazione: ((r.computed_at ?? new Date().toISOString()) as string).toString(),
        note: nomeFonte,
        // Successioni aggregate: MAI assegnate a una zona esatta.
        commercial_zone_slug: null,
        zone_match_method: "unresolved",
        zone_match_confidence: null,
      });
      totals.successioni++;
    }

    // 3) Distress — fonte primaria RPC get_padova_verified_price_drops.
    // La RPC non espone count: se restituisce esattamente il cap, la
    // completezza non è dimostrabile => fail-closed.
    let rpcOkDist = false;
    {
      const { data: rpcRows, error: rpcErr } = await supabase.rpc(
        "get_padova_verified_price_drops",
        { p_limit: SOURCE_CAP, p_min_drop_pct: 5, p_max_age_days: 14 },
      );
      if (!rpcErr && Array.isArray(rpcRows)) {
        rpcOkDist = true;
        sourceCounts.distress = rpcRows.length;
        if (rpcRows.length >= SOURCE_CAP) truncatedSources.push("distress");
        for (const r of rpcRows as Record<string, unknown>[]) {
          if (isAuctionRecord(r)) continue;
          const slug = (r.commercial_zone_slug as string) || null;
          if (!slug) continue;
          const dropPct = Number(r.total_drop_pct) || 0;
          if (dropPct < 5) continue;
          const rowUrl = String(r.url || "");
          if (!rowUrl.startsWith("https://")) continue;
          const title = String(r.title || "Annuncio in difficoltà");
          const drops = Number(r.drops_count) || 0;
          const validSlug = isValidCommercialZoneSlug(slug) ? slug : null;
          items.push({
            id: `dist-${String(r.source_id || r.listing_id || rowUrl)}`,
            fonte: "distress",
            badge: "Distress",
            titolo: `${title} — ribasso ${dropPct}%`,
            indirizzo: title,
            zona: (r.omi_zone as string) || "Padova",
            prezzo_eur: Number(r.current_price_eur) || null,
            mq: r.mq === null || r.mq === undefined ? null : Number(r.mq),
            url_sorgente: rowUrl,
            data_segnalazione: (r.last_seen_at as string) || new Date().toISOString(),
            note: `Ribasso ${dropPct}% · ${drops} ribass${drops === 1 ? "o" : "i"}`,
            commercial_zone_slug: validSlug,
            zone_match_method: validSlug ? "rpc_verified_drop" : "unresolved",
            zone_match_confidence: validSlug ? 0.95 : null,
          });
          totals.distress++;
        }
      }
    }

    if (!rpcOkDist) {
      // Fallback storico su motivated_sellers (attivo, no aste, prezzo minimo, zona da padova_listings)
      const distRes = await fetchAllRows(() =>
        supabase
          .from("motivated_sellers")
          .select("id, url, municipality, last_price_eur, total_drop_pct, drops_count, days_online, fatigue_label, detected_at, payload")
          .ilike("municipality", "padova")
          .eq("is_active", true)
          .or("last_price_eur.is.null,last_price_eur.gte.10000")
          .order("detected_at", { ascending: false })
          .order("id", { ascending: false }) as never
      );
      if (distRes.error) return failClosed({ error: "distress_read_failed", message: distRes.error }, 500);
      sourceCounts.distress = distRes.rows.length;
      if (distRes.truncated) truncatedSources.push("distress");

      const distUrls = Array.from(
        new Set(distRes.rows.map((r) => r.url).filter((u): u is string => typeof u === "string" && u.length > 0)),
      );
      const listingMap = new Map<string, { indirizzo: string | null; quartiere: string | null; mq: number | null; commercial_zone_slug: string | null; expired_at: string | null }>();
      for (let i = 0; i < distUrls.length; i += 500) {
        const chunk = distUrls.slice(i, i + 500);
        const { data: listings, error: lErr } = await supabase
          .from("padova_listings")
          .select("url, indirizzo, quartiere, mq, commercial_zone_slug, expired_at")
          .in("url", chunk);
        if (lErr) return failClosed({ error: "listings_read_failed", message: lErr.message }, 500);
        for (const l of listings ?? []) {
          if (l.url) listingMap.set(l.url, {
            indirizzo: l.indirizzo ?? null,
            quartiere: l.quartiere ?? null,
            mq: l.mq ?? null,
            commercial_zone_slug: (l as Record<string, unknown>).commercial_zone_slug as string | null ?? null,
            expired_at: (l as Record<string, unknown>).expired_at as string | null ?? null,
          });
        }
      }

      for (const r of distRes.rows) {
        if (isAuctionRecord(r)) continue;
        const dropPct = Number(r.total_drop_pct ?? 0) || 0;
        if (dropPct < 5) continue;
        const enrich = (typeof r.url === "string" && listingMap.get(r.url)) || null;
        if (!enrich || enrich.expired_at || !enrich.commercial_zone_slug) continue;
        const ribassiCount = Number(r.drops_count ?? 0);
        const ribassiTxt = `${ribassiCount} ribass${ribassiCount === 1 ? "o" : "i"}`;
        const titolo = `${enrich.indirizzo ?? "Annuncio in difficoltà"} — ribasso ${dropPct.toFixed(1)}%`;
        const validSlug = isValidCommercialZoneSlug(enrich.commercial_zone_slug)
          ? enrich.commercial_zone_slug
          : null;
        items.push({
          id: `dist-${r.id}`,
          fonte: "distress",
          badge: "Distress",
          titolo,
          indirizzo: enrich.indirizzo ?? "Padova",
          zona: enrich.quartiere ?? "Padova",
          prezzo_eur: r.last_price_eur ? Number(r.last_price_eur) : null,
          mq: enrich.mq,
          url_sorgente: (r.url as string) ?? null,
          data_segnalazione: ((r.detected_at ?? new Date().toISOString()) as string).toString(),
          note: [r.fatigue_label, ribassiTxt].filter(Boolean).join(" · ") || null,
          commercial_zone_slug: validSlug,
          zone_match_method: validSlug ? "listing_slug" : "unresolved",
          zone_match_confidence: validSlug ? 0.9 : null,
        });
        totals.distress++;
      }
    }

    // 4) Patrimonio Comune di Padova (albo pretorio / dismissioni)
    const patrRes = await fetchAllRows(() =>
      supabase
        .from("normalized_opportunities")
        .select("id, title, address_text, microzone, ask_price, surface_mq, source_url, source_name, data_rilevamento, tags")
        .ilike("municipality", "padova")
        .or("tags.cs.{albo_pretorio},tags.cs.{patrimonio_comunale},source_name.ilike.%comune%,source_name.ilike.%albo%,source_name.ilike.%patrimonio%")
        .order("data_rilevamento", { ascending: false })
        .order("id", { ascending: false }) as never
    );
    if (patrRes.error) return failClosed({ error: "patrimonio_read_failed", message: patrRes.error }, 500);
    sourceCounts.patrimonio_comunale = patrRes.rows.length;
    if (patrRes.truncated) truncatedSources.push("patrimonio_comunale");

    for (const r of patrRes.rows) {
      items.push({
        id: `patr-${r.id}`,
        fonte: "patrimonio_comunale",
        badge: "Patrimonio Comunale",
        titolo: (r.title as string) ?? "Immobile Comune di Padova",
        indirizzo: (r.address_text as string) ?? "Padova",
        zona: (r.microzone as string) ?? "Padova",
        prezzo_eur: r.ask_price ? Number(r.ask_price) : null,
        mq: r.surface_mq ? Number(r.surface_mq) : null,
        url_sorgente: (r.source_url as string) ?? null,
        data_segnalazione: ((r.data_rilevamento ?? new Date().toISOString()) as string).toString(),
        note: (r.source_name as string) ?? null,
        commercial_zone_slug: null,
        zone_match_method: "unresolved",
        zone_match_confidence: null,
        __resolveInput: {
          address: r.address_text ?? "",
          microzona: r.microzone ?? "",
          zona: r.microzone ?? "",
          title: r.title ?? "",
        },
      });
      totals.patrimonio_comunale++;
    }

    // Troncamento su qualunque fonte => snapshot non probante (fail-closed).
    if (truncatedSources.length > 0) {
      return failClosed({
        error: "SOURCE_TRUNCATED",
        message: `Snapshot non completo: fonti troncate al cap ${SOURCE_CAP} (${truncatedSources.join(", ")}).`,
      }, 503);
    }

    // ── Risoluzione zona commerciale per gli item con __resolveInput ────
    // (legal_life_events + patrimonio_comunale). Distress + successioni
    // conservano il valore già impostato.
    const toResolve: number[] = [];
    const resolveInputs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < items.length; i++) {
      const ri = items[i].__resolveInput;
      if (ri) { toResolve.push(i); resolveInputs.push(ri); }
    }
    if (resolveInputs.length > 0) {
      const assigns = await assignCommercialZonesBatch(resolveInputs, omiToSlug, supabase);
      for (let k = 0; k < assigns.length; k++) {
        const idx = toResolve[k];
        const a = assigns[k];
        items[idx].commercial_zone_slug = a.commercial_zone_slug;
        items[idx].zone_match_method = a.zone_match_method;
        items[idx].zone_match_confidence = a.zone_match_confidence;
      }
    }
    for (const it of items) delete it.__resolveInput;

    // Filtro opzionale per commercial_zone_slug.
    let outItems = items;
    if (commercialZoneFilter) {
      outItems = items.filter((it) => it.commercial_zone_slug === commercialZoneFilter || it.commercial_zone_slug === null);
      // Ricalcola totals sul risultato filtrato.
      const t = { legal_life_events: 0, successioni: 0, distress: 0, patrimonio_comunale: 0, total: 0 };
      for (const it of outItems) {
        (t as Record<string, number>)[it.fonte]++;
      }
      t.total = t.legal_life_events + t.successioni + t.distress + t.patrimonio_comunale;
      // Preserva contatore aste escluse (diagnostico).
      const auct = (totals as Record<string, number>).legal_life_events_auction_excluded ?? 0;
      Object.assign(totals, t, { legal_life_events_auction_excluded: auct });
    } else {
      totals.total =
        totals.legal_life_events + totals.successioni + totals.distress + totals.patrimonio_comunale;
    }

    // Ordina per data segnalazione decrescente
    outItems.sort((a, b) => (a.data_segnalazione < b.data_segnalazione ? 1 : -1));

    // Paginazione finale sul risultato completo (total autorevole).
    const total = outItems.length;
    const pageOffset = total > 0 ? Math.min(pageOffsetReq, Math.max(0, total - 1)) : 0;
    const pageItems = outItems.slice(pageOffset, pageOffset + pageLimit);

    return json({
      ok: true,
      snapshot_complete: true,
      updated_at: new Date().toISOString(),
      commercial_zone_filter: commercialZoneFilter,
      totals,
      source_counts: sourceCounts,
      source_caps: sourceCaps,
      truncated_sources: truncatedSources,
      total,
      items_count: pageItems.length,
      limit: pageLimit,
      offset: pageOffset,
      has_more: pageOffset + pageItems.length < total,
      items: pageItems,
    });
  } catch (e) {
    return failClosed({ error: "internal_error", message: (e as Error).message }, 500);
  }
});
