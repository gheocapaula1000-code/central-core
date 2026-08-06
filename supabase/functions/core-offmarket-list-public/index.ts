// core-offmarket-list-public
// Endpoint Core autenticato che aggrega i segnali off-market per Padova
// da 4 fonti: eventi vita legali, successioni potenziali, annunci in difficolta',
// patrimonio Comune di Padova.

import { isAuctionRecord } from "../_shared/auctionExclusion.ts";
import {
  VALID_COMMERCIAL_ZONE_SLUGS,
  isValidCommercialZoneSlug,
  buildOmiToSlugMap,
  assignCommercialZonesBatch,
  type ActiveZoneRow,
  type CommercialZoneSlug,
} from "../_shared/commercialZoneMapping.ts";
import {
  authorizeCivikoSnapshot,
  CIVIKO_SNAPSHOT_CORS as CORS,
  snapshotAccessError,
} from "../civiko-authorized-snapshot/access.ts";

type Item = {
  id: string;
  fonte: "legal_life_events" | "successioni" | "distress" | "patrimonio_comunale";
  badge: "Evento Vita" | "Successione" | "Distress" | "Patrimonio Comunale";
  titolo: string | null;
  indirizzo: string | null;
  zona: string | null;
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

const SOURCE_PAGE_SIZE = 500;
const MAX_SOURCE_ROWS = 20_000;
const OUTPUT_LIMIT_MAX = 500;

type PageResult<T> = { data: T[] | null; error: unknown };

/** Pagina una sorgente fino a EOF; qualunque errore/troncamento chiude lo snapshot. */
async function fetchAllSourceRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < MAX_SOURCE_ROWS; from += SOURCE_PAGE_SIZE) {
    const { data, error } = await page(from, from + SOURCE_PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) throw new Error("source_query_failed");
    out.push(...data);
    if (data.length < SOURCE_PAGE_SIZE) return out;
  }
  throw new Error("source_snapshot_cap_reached");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const access = await authorizeCivikoSnapshot(req);
  if (!access.ok) return snapshotAccessError(access);
  const supabase = access.client;

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
  // authorizeCivikoSnapshot already enforces assignment/admin scope; repeat
  // the containment check here so later refactors cannot widen the query.
  if (commercialZoneFilter && !access.slugs.includes(commercialZoneFilter)) {
    return json({ ok: false, error: "ZONE_NOT_ASSIGNED" }, 403);
  }
  const effectiveZoneFilter = commercialZoneFilter ??
    (!access.isAdmin ? access.slugs[0] : null);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
  const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), OUTPUT_LIMIT_MAX)
    : 200;
  const offset = Number.isFinite(offsetRaw)
    ? Math.min(Math.max(offsetRaw, 0), 1_000_000)
    : 0;

  // Carica una sola volta le zone commerciali attive.
  const { data: zonesRows, error: zonesError } = await supabase
    .from("civiko_commercial_zones")
    .select("slug, omi_codes, attiva")
    .eq("attiva", true);
  if (zonesError || !Array.isArray(zonesRows)) {
    return json({
      ok: false,
      error: "zone_snapshot_unavailable",
      snapshot_complete: false,
      total: null,
      items_count: 0,
      items: [],
      data: { snapshot_complete: false, total: null, items_count: 0, items: [] },
    }, 502);
  }
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
  const sourceCounts = {
    legal_life_events: 0,
    successioni: 0,
    distress: 0,
    patrimonio_comunale: 0,
  };
  const sourceCaps = {
    page_size: SOURCE_PAGE_SIZE,
    max_source_rows: MAX_SOURCE_ROWS,
    distress_rpc_limit: SOURCE_PAGE_SIZE,
    distress_rpc_cap_reached: false,
  };
  const diagnostics = { legal_life_events_auction_excluded: 0 };

  try {
    // 1) Legal life events (Padova, privacy-safe attivi)
    // Esclusione aste: riusa auctionExclusion.ts (guardia condivisa).

    const lle = await fetchAllSourceRows<any>((from, to) => supabase
      .from("legal_life_event_signals")
      .select("id, signal_type, source_name, source_url, event_date, detected_at, area_or_microzone, property_hint, explanation")
      .ilike("municipality", "padova")
      .eq("is_active", true)
      .eq("privacy_safe", true)
      .eq("pii_redacted", true)
      .eq("contains_personal_data", false)
      .order("detected_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to));
    sourceCounts.legal_life_events = lle.length;

    let lleAuctionExcluded = 0;
    for (const r of lle) {
      if (isAuctionRecord(r)) {
        lleAuctionExcluded++;
        continue;
      }
      items.push({
        id: `lle-${r.id}`,
        fonte: "legal_life_events",
        badge: "Evento Vita",
        titolo: r.explanation ?? r.signal_type ?? null,
        indirizzo: r.property_hint ?? null,
        zona: r.area_or_microzone ?? null,
        prezzo_eur: null,
        mq: null,
        url_sorgente: r.source_url ?? null,
        data_segnalazione: (r.event_date ?? r.detected_at ?? new Date().toISOString()).toString(),
        note: r.source_name ?? null,
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
    diagnostics.legal_life_events_auction_excluded = lleAuctionExcluded;

    // 2) Successioni potenziali (aggregate only, mai nominativi/PII)
    const succ = await fetchAllSourceRows<any>((from, to) => supabase
      .from("inheritance_pressure_signals")
      .select("id, area_label, area_type, score, signal_basis, source_urls, source_names, computed_at, indicators, standard_radar_visible, agency_private_only")
      .ilike("comune", "padova")
      .eq("is_active", true)
      .eq("standard_radar_visible", true)
      .eq("agency_private_only", false)
      .order("computed_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to));
    sourceCounts.successioni = succ.length;

    for (const r of succ) {
      if (isAuctionRecord(r)) continue;
      const url = Array.isArray(r.source_urls) && r.source_urls.length ? r.source_urls[0] : null;
      const nomeFonte = Array.isArray(r.source_names) && r.source_names.length ? r.source_names.join(", ") : null;
      items.push({
        id: `succ-${r.id}`,
        fonte: "successioni",
        badge: "Successione",
        titolo: r.area_label ?? null,
        indirizzo: null,
        zona: r.area_label ?? null,
        prezzo_eur: null,
        mq: null,
        url_sorgente: url,
        data_segnalazione: (r.computed_at ?? new Date().toISOString()).toString(),
        note: nomeFonte,
        // Successioni aggregate: MAI assegnate a una zona esatta.
        commercial_zone_slug: null,
        zone_match_method: "unresolved",
        zone_match_confidence: null,
      });
      totals.successioni++;
    }

    // 3) Distress — fonte primaria RPC get_padova_verified_price_drops.
    // Fallback sicuro su motivated_sellers solo se la RPC non esiste.
    let rpcOkDist = false;
    try {
      const { data: rpcRows, error: rpcErr } = await supabase.rpc(
        "get_padova_verified_price_drops",
        { p_limit: 500, p_min_drop_pct: 5, p_max_age_days: 14 },
      );
      if (!rpcErr && Array.isArray(rpcRows)) {
        if (rpcRows.length >= SOURCE_PAGE_SIZE) {
          sourceCaps.distress_rpc_cap_reached = true;
          throw new Error("distress_snapshot_cap_reached");
        }
        rpcOkDist = true;
        sourceCounts.distress = rpcRows.length;
        for (const r of rpcRows as Record<string, unknown>[]) {
          if (isAuctionRecord(r)) continue;
          const slug = (r.commercial_zone_slug as string) || null;
          if (!slug) continue;
          const dropPct = Number(r.total_drop_pct) || 0;
          if (dropPct < 5) continue;
          const url = String(r.url || "");
          if (!url.startsWith("https://")) continue;
          const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
          const drops = Number(r.drops_count) || 0;
          const validSlug = isValidCommercialZoneSlug(slug) ? slug : null;
          items.push({
            id: `dist-${String(r.source_id || r.listing_id || url)}`,
            fonte: "distress",
            badge: "Distress",
            titolo: title ? `${title} — ribasso ${dropPct}%` : null,
            indirizzo: null,
            zona: typeof r.omi_zone === "string" && r.omi_zone.trim() ? r.omi_zone : null,
            prezzo_eur: Number(r.current_price_eur) || null,
            mq: r.mq === null || r.mq === undefined ? null : Number(r.mq),
            url_sorgente: url,
            data_segnalazione: (r.last_seen_at as string) || new Date().toISOString(),
            note: `Ribasso ${dropPct}% · ${drops} ribass${drops === 1 ? "o" : "i"}`,
            commercial_zone_slug: validSlug,
            zone_match_method: validSlug ? "rpc_verified_drop" : "unresolved",
            zone_match_confidence: validSlug ? 0.95 : null,
          });
          totals.distress++;
        }
      }
    } catch (error) {
      // Un cap raggiunto non puo' degradare al fallback: renderebbe il totale
      // apparentemente completo ma semanticamente diverso dalla fonte primaria.
      if (error instanceof Error && error.message === "distress_snapshot_cap_reached") throw error;
      // Errori/assenza della RPC possono usare il fallback storico completo.
    }

    if (!rpcOkDist) {
      // Fallback storico su motivated_sellers (attivo, no aste, prezzo minimo, zona da padova_listings)
      const dist = await fetchAllSourceRows<any>((from, to) => supabase
        .from("motivated_sellers")
        .select("id, url, municipality, last_price_eur, total_drop_pct, drops_count, days_online, fatigue_label, detected_at, payload")
        .ilike("municipality", "padova")
        .eq("is_active", true)
        .or("last_price_eur.is.null,last_price_eur.gte.10000")
        .order("detected_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to));
      sourceCounts.distress = dist.length;

      const distUrls = Array.from(
        new Set(dist.map((r) => r.url).filter((u): u is string => typeof u === "string" && u.length > 0)),
      );
      const listingMap = new Map<string, { indirizzo: string | null; quartiere: string | null; mq: number | null; commercial_zone_slug: string | null; expired_at: string | null }>();
      for (let i = 0; i < distUrls.length; i += 100) {
        const chunk = distUrls.slice(i, i + 100);
        const { data: listings, error: listingsError } = await supabase
          .from("padova_listings")
          .select("url, indirizzo, quartiere, mq, commercial_zone_slug, expired_at")
          .in("url", chunk);
        if (listingsError || !Array.isArray(listings)) throw new Error("distress_enrichment_failed");
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

      for (const r of dist) {
        if (isAuctionRecord(r)) continue;
        const dropPct = Number(r.total_drop_pct ?? 0) || 0;
        if (dropPct < 5) continue;
        const enrich = (r.url && listingMap.get(r.url)) || null;
        if (!enrich || enrich.expired_at || !enrich.commercial_zone_slug) continue;
        const ribassiCount = r.drops_count ?? 0;
        const ribassiTxt = `${ribassiCount} ribass${ribassiCount === 1 ? "o" : "i"}`;
        const titolo = enrich.indirizzo
          ? `${enrich.indirizzo} — ribasso ${dropPct.toFixed(1)}%`
          : null;
        const validSlug = isValidCommercialZoneSlug(enrich.commercial_zone_slug)
          ? enrich.commercial_zone_slug
          : null;
        items.push({
          id: `dist-${r.id}`,
          fonte: "distress",
          badge: "Distress",
          titolo,
          indirizzo: enrich.indirizzo ?? null,
          zona: enrich.quartiere ?? null,
          prezzo_eur: r.last_price_eur ? Number(r.last_price_eur) : null,
          mq: enrich.mq,
          url_sorgente: r.url ?? null,
          data_segnalazione: (r.detected_at ?? new Date().toISOString()).toString(),
          note: [r.fatigue_label, ribassiTxt].filter(Boolean).join(" · ") || null,
          commercial_zone_slug: validSlug,
          zone_match_method: validSlug ? "listing_slug" : "unresolved",
          zone_match_confidence: validSlug ? 0.9 : null,
        });
        totals.distress++;
      }
    }



    // 4) Patrimonio Comune di Padova (albo pretorio / dismissioni)
    const patr = await fetchAllSourceRows<any>((from, to) => supabase
      .from("normalized_opportunities")
      .select("id, title, address_text, microzone, ask_price, surface_mq, source_url, source_name, data_rilevamento, tags")
      .ilike("municipality", "padova")
      .or("tags.cs.{albo_pretorio},tags.cs.{patrimonio_comunale},source_name.ilike.%comune%,source_name.ilike.%albo%,source_name.ilike.%patrimonio%")
      .order("data_rilevamento", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to));
    sourceCounts.patrimonio_comunale = patr.length;

    for (const r of patr) {
      items.push({
        id: `patr-${r.id}`,
        fonte: "patrimonio_comunale",
        badge: "Patrimonio Comunale",
        titolo: r.title ?? null,
        indirizzo: r.address_text ?? null,
        zona: r.microzone ?? null,
        prezzo_eur: r.ask_price ? Number(r.ask_price) : null,
        mq: r.surface_mq ? Number(r.surface_mq) : null,
        url_sorgente: r.source_url ?? null,
        data_segnalazione: (r.data_rilevamento ?? new Date().toISOString()).toString(),
        note: r.source_name ?? null,
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
    // Every visible snapshot, including owner/admin full-city, is restricted
    // to Padova's literal exact-8 scope. NULL/unknown zones remain quarantined.
    let outItems = items.filter((it) =>
      it.commercial_zone_slug !== null && access.slugs.includes(it.commercial_zone_slug)
    );
    if (effectiveZoneFilter) {
      // Tenant snapshots never inherit NULL-zone rows: a missing assignment
      // cannot be interpreted as belonging to the requested zone.
      outItems = items.filter((it) => it.commercial_zone_slug === effectiveZoneFilter);
    } else {
      // Absence of a filter is full-city and was already restricted to admin.
      if (!access.isAdmin) throw new Error("tenant_full_city_forbidden");
    }
    // Ricalcola sempre i totals sullo stesso exact-scope degli item visibili.
    const visibleTotals = {
      legal_life_events: 0,
      successioni: 0,
      distress: 0,
      patrimonio_comunale: 0,
      total: 0,
    };
    for (const it of outItems) (visibleTotals as Record<string, number>)[it.fonte]++;
    visibleTotals.total = visibleTotals.legal_life_events + visibleTotals.successioni +
      visibleTotals.distress + visibleTotals.patrimonio_comunale;
    Object.assign(totals, visibleTotals);

    // Ordina per data segnalazione decrescente
    outItems.sort((a, b) => {
      if (a.data_segnalazione === b.data_segnalazione) return a.id.localeCompare(b.id);
      return a.data_segnalazione < b.data_segnalazione ? 1 : -1;
    });

    const total = outItems.length;
    // Invariante autorevole: il totale pubblico e' sempre la somma delle
    // quattro categorie dopo gli stessi filtri degli item restituiti.
    if (totals.total !== total || totals.total !==
      totals.legal_life_events + totals.successioni + totals.distress + totals.patrimonio_comunale) {
      throw new Error("offmarket_total_invariant_failed");
    }
    const pageItems = outItems.slice(offset, offset + limit);
    const itemsCount = pageItems.length;
    const hasMore = offset + itemsCount < total;
    const snapshot = {
      items: pageItems,
      totals,
      total,
      items_count: itemsCount,
      offset,
      limit,
      has_more: hasMore,
      snapshot_complete: true,
      scope: {
        municipality: "Padova",
        commercial_zone_slugs: access.slugs,
        full_city: access.isAdmin && access.slugs.length === 8,
      },
      source_counts: sourceCounts,
      source_caps: sourceCaps,
      diagnostics,
    };

    return json({
      ok: true,
      updated_at: new Date().toISOString(),
      commercial_zone_filter: effectiveZoneFilter,
      ...snapshot,
      data: snapshot,
    });
  } catch (e) {
    const code = e instanceof Error && e.message.includes("cap_reached")
      ? "snapshot_cap_reached"
      : "authoritative_snapshot_failed";
    console.error(`[core-offmarket-list-public] ${code}`);
    return json({
      ok: false,
      error: code,
      updated_at: new Date().toISOString(),
      snapshot_complete: false,
      total: null,
      items_count: 0,
      has_more: false,
      totals,
      source_counts: sourceCounts,
      source_caps: sourceCaps,
      diagnostics,
      items: [],
      data: {
        snapshot_complete: false,
        total: null,
        items_count: 0,
        has_more: false,
        totals,
        source_counts: sourceCounts,
        source_caps: sourceCaps,
        diagnostics,
        items: [],
      },
    }, code === "snapshot_cap_reached" ? 503 : 502);
  }
});
