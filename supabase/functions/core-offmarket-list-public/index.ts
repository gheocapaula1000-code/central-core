// core-offmarket-list-public
// Endpoint pubblico (no auth) che aggrega i segnali off-market per Padova
// da 4 fonti: eventi vita legali, successioni potenziali, annunci in difficolta',
// patrimonio Comune di Padova.

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

  try {
    // 1) Legal life events (Padova, privacy-safe attivi)
    // Esclusione aste: riusa auctionExclusion.ts (guardia condivisa).

    const { data: lle } = await supabase
      .from("legal_life_event_signals")
      .select("id, signal_type, source_name, source_url, event_date, detected_at, area_or_microzone, property_hint, explanation")
      .ilike("municipality", "padova")
      .eq("is_active", true)
      .eq("privacy_safe", true)
      .eq("pii_redacted", true)
      .eq("contains_personal_data", false)
      .order("detected_at", { ascending: false })
      .limit(500);

    let lleAuctionExcluded = 0;
    for (const r of lle ?? []) {
      if (isAuctionRecord(r)) {
        lleAuctionExcluded++;
        continue;
      }
      items.push({
        id: `lle-${r.id}`,
        fonte: "legal_life_events",
        badge: "Evento Vita",
        titolo: r.explanation ?? r.signal_type ?? "Segnalazione evento di vita",
        indirizzo: r.property_hint ?? "Padova",
        zona: r.area_or_microzone ?? "Padova",
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
    (totals as Record<string, number>).legal_life_events_auction_excluded = lleAuctionExcluded;

    // 2) Successioni potenziali (aggregate only, mai nominativi/PII)
    const { data: succ } = await supabase
      .from("inheritance_pressure_signals")
      .select("id, area_label, area_type, score, signal_basis, source_urls, source_names, computed_at, indicators, standard_radar_visible, agency_private_only")
      .ilike("comune", "padova")
      .eq("is_active", true)
      .eq("standard_radar_visible", true)
      .eq("agency_private_only", false)
      .order("computed_at", { ascending: false })
      .limit(500);

    for (const r of succ ?? []) {
      if (isAuctionRecord(r)) continue;
      const url = Array.isArray(r.source_urls) && r.source_urls.length ? r.source_urls[0] : null;
      const nomeFonte = Array.isArray(r.source_names) && r.source_names.length ? r.source_names.join(", ") : null;
      items.push({
        id: `succ-${r.id}`,
        fonte: "successioni",
        badge: "Successione",
        titolo: `Pressione successoria ${r.area_label ?? "Padova"}`,
        indirizzo: r.area_label ?? "Padova",
        zona: r.area_label ?? "Padova",
        prezzo_eur: null,
        mq: null,
        url_sorgente: url,
        data_segnalazione: (r.computed_at ?? new Date().toISOString()).toString(),
        note: nomeFonte,
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
        rpcOkDist = true;
        for (const r of rpcRows as Record<string, unknown>[]) {
          if (isAuctionRecord(r)) continue;
          const slug = (r.commercial_zone_slug as string) || null;
          if (!slug) continue;
          const dropPct = Number(r.total_drop_pct) || 0;
          if (dropPct < 5) continue;
          const url = String(r.url || "");
          if (!url.startsWith("https://")) continue;
          const title = String(r.title || "Annuncio in difficoltà");
          const drops = Number(r.drops_count) || 0;
          items.push({
            id: `dist-${String(r.source_id || r.listing_id || url)}`,
            fonte: "distress",
            badge: "Distress",
            titolo: `${title} — ribasso ${dropPct}%`,
            indirizzo: title,
            zona: (r.omi_zone as string) || "Padova",
            prezzo_eur: Number(r.current_price_eur) || null,
            mq: r.mq === null || r.mq === undefined ? null : Number(r.mq),
            url_sorgente: url,
            data_segnalazione: (r.last_seen_at as string) || new Date().toISOString(),
            note: `Ribasso ${dropPct}% · ${drops} ribass${drops === 1 ? "o" : "i"}`,
            commercial_zone_slug: slug,
          });
          totals.distress++;
        }
      }
    } catch (_e) {
      // rimane fallback
    }

    if (!rpcOkDist) {
      // Fallback storico su motivated_sellers (attivo, no aste, prezzo minimo, zona da padova_listings)
      const { data: dist } = await supabase
        .from("motivated_sellers")
        .select("id, url, municipality, last_price_eur, total_drop_pct, drops_count, days_online, fatigue_label, detected_at, payload")
        .ilike("municipality", "padova")
        .eq("is_active", true)
        .or("last_price_eur.is.null,last_price_eur.gte.10000")
        .order("detected_at", { ascending: false })
        .limit(500);

      const distUrls = Array.from(
        new Set((dist ?? []).map((r) => r.url).filter((u): u is string => typeof u === "string" && u.length > 0)),
      );
      const listingMap = new Map<string, { indirizzo: string | null; quartiere: string | null; mq: number | null; commercial_zone_slug: string | null; expired_at: string | null }>();
      if (distUrls.length > 0) {
        const { data: listings } = await supabase
          .from("padova_listings")
          .select("url, indirizzo, quartiere, mq, commercial_zone_slug, expired_at")
          .in("url", distUrls);
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

      for (const r of dist ?? []) {
        if (isAuctionRecord(r)) continue;
        const dropPct = Number(r.total_drop_pct ?? 0) || 0;
        if (dropPct < 5) continue;
        const enrich = (r.url && listingMap.get(r.url)) || null;
        if (!enrich || enrich.expired_at || !enrich.commercial_zone_slug) continue;
        const ribassiCount = r.drops_count ?? 0;
        const ribassiTxt = `${ribassiCount} ribass${ribassiCount === 1 ? "o" : "i"}`;
        const titolo = `${enrich.indirizzo ?? "Annuncio in difficoltà"} — ribasso ${dropPct.toFixed(1)}%`;
        items.push({
          id: `dist-${r.id}`,
          fonte: "distress",
          badge: "Distress",
          titolo,
          indirizzo: enrich.indirizzo ?? "Padova",
          zona: enrich.quartiere ?? "Padova",
          prezzo_eur: r.last_price_eur ? Number(r.last_price_eur) : null,
          mq: enrich.mq,
          url_sorgente: r.url ?? null,
          data_segnalazione: (r.detected_at ?? new Date().toISOString()).toString(),
          note: [r.fatigue_label, ribassiTxt].filter(Boolean).join(" · ") || null,
          commercial_zone_slug: enrich.commercial_zone_slug,
        });
        totals.distress++;
      }
    }



    // 4) Patrimonio Comune di Padova (albo pretorio / dismissioni)
    const { data: patr } = await supabase
      .from("normalized_opportunities")
      .select("id, title, address_text, microzone, ask_price, surface_mq, source_url, source_name, data_rilevamento, tags")
      .ilike("municipality", "padova")
      .or("tags.cs.{albo_pretorio},tags.cs.{patrimonio_comunale},source_name.ilike.%comune%,source_name.ilike.%albo%,source_name.ilike.%patrimonio%")
      .order("data_rilevamento", { ascending: false })
      .limit(500);

    for (const r of patr ?? []) {
      items.push({
        id: `patr-${r.id}`,
        fonte: "patrimonio_comunale",
        badge: "Patrimonio Comunale",
        titolo: r.title ?? "Immobile Comune di Padova",
        indirizzo: r.address_text ?? "Padova",
        zona: r.microzone ?? "Padova",
        prezzo_eur: r.ask_price ? Number(r.ask_price) : null,
        mq: r.surface_mq ? Number(r.surface_mq) : null,
        url_sorgente: r.source_url ?? null,
        data_segnalazione: (r.data_rilevamento ?? new Date().toISOString()).toString(),
        note: r.source_name ?? null,
      });
      totals.patrimonio_comunale++;
    }

    totals.total =
      totals.legal_life_events + totals.successioni + totals.distress + totals.patrimonio_comunale;

    // Ordina per data segnalazione decrescente
    items.sort((a, b) => (a.data_segnalazione < b.data_segnalazione ? 1 : -1));

    return json({
      ok: true,
      updated_at: new Date().toISOString(),
      totals,
      items,
    });
  } catch (e) {
    return json({
      ok: false,
      error: "internal_error",
      message: (e as Error).message,
      updated_at: new Date().toISOString(),
      totals,
      items: [],
    }, 500);
  }
});
