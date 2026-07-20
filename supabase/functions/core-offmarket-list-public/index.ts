// core-offmarket-list-public
// Endpoint pubblico (no auth) che aggrega i segnali off-market per Padova
// da 4 fonti: eventi vita legali, successioni potenziali, annunci in difficolta',
// patrimonio Comune di Padova.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { isAuctionRecord } from "../_shared/auctionExclusion.ts";

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
    // Esclusione esplicita di tutte le aste: ci sono verticali dedicati e Civiko One
    // serve agenti generalisti, non operatori d'asta.
    const AUCTION_DOMAINS = [
      "asteimmobili.it",
      "astalegale.net",
      "astagiudiziaria",
      "astetelematiche",
      "portalevenditepubbliche",
      "spazioaste",
      "gobidaste",
      "garaimmobiliare",
    ];
    const AUCTION_KEYWORDS = [
      "asta",
      "aste",
      "vendita giudiziaria",
      "vendite giudiziarie",
      "esecuzione immobiliare",
      "esecuzioni immobiliari",
      "perizia",
      "lotto",
      "tribunale",
      "procedura esecutiva",
      "fallimentare",
      "concordato",
    ];
    const isAuctionRecord = (r: {
      signal_type?: string | null;
      source_name?: string | null;
      source_url?: string | null;
      explanation?: string | null;
      property_hint?: string | null;
    }) => {
      if ((r.signal_type ?? "").toUpperCase().includes("AUCTION")) return true;
      const haystack = [
        r.source_name ?? "",
        r.source_url ?? "",
        r.explanation ?? "",
        r.property_hint ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (AUCTION_DOMAINS.some((d) => haystack.includes(d))) return true;
      if (AUCTION_KEYWORDS.some((k) => new RegExp(`\\b${k}\\b`, "i").test(haystack))) return true;
      return false;
    };

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
      });
      totals.legal_life_events++;
    }
    (totals as Record<string, number>).legal_life_events_auction_excluded = lleAuctionExcluded;

    // 2) Successioni potenziali (inheritance_pressure_signals)
    const { data: succ } = await supabase
      .from("inheritance_pressure_signals")
      .select("id, area_label, area_type, score, signal_basis, source_urls, source_names, computed_at, indicators")
      .ilike("comune", "padova")
      .eq("is_active", true)
      .order("computed_at", { ascending: false })
      .limit(500);

    for (const r of succ ?? []) {
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

    // 3) Distress - motivated_sellers attivi a Padova
    // Filtro prezzi anomali: escludi last_price_eur < 10000 (parser errors come 1.450€ con -99.6%)
    const { data: dist } = await supabase
      .from("motivated_sellers")
      .select("id, url, municipality, last_price_eur, total_drop_pct, drops_count, days_online, fatigue_label, detected_at, payload")
      .ilike("municipality", "padova")
      .eq("is_active", true)
      .or("last_price_eur.is.null,last_price_eur.gte.10000")
      .order("detected_at", { ascending: false })
      .limit(500);

    // Arricchimento titoli/indirizzi via join su padova_listings (motivated_sellers non ha title/address)
    const distUrls = Array.from(
      new Set((dist ?? []).map((r) => r.url).filter((u): u is string => typeof u === "string" && u.length > 0)),
    );
    const listingMap = new Map<string, { indirizzo: string | null; quartiere: string | null; mq: number | null }>();
    if (distUrls.length > 0) {
      const { data: listings } = await supabase
        .from("padova_listings")
        .select("url, indirizzo, quartiere, mq")
        .in("url", distUrls);
      for (const l of listings ?? []) {
        if (l.url) listingMap.set(l.url, { indirizzo: l.indirizzo ?? null, quartiere: l.quartiere ?? null, mq: l.mq ?? null });
      }
    }

    const extractListingIdFromUrl = (u: string | null | undefined): string | null => {
      if (!u) return null;
      const m = u.match(/\/(?:immobili|annunci|annuncio)\/(\d+)/i);
      if (m) return m[1];
      const tail = u.replace(/\/+$/, "").split("/").pop() ?? "";
      return tail.length > 0 ? tail.slice(0, 40) : null;
    };
    const hostFromUrl = (u: string | null | undefined): string | null => {
      if (!u) return null;
      try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; }
    };

    for (const r of dist ?? []) {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const enrich = (r.url && listingMap.get(r.url)) || null;
      const indirizzoReale =
        (enrich?.indirizzo ?? null) ||
        ((payload.indirizzo as string) ?? (payload.address as string) ?? null);
      const quartiere =
        (enrich?.quartiere ?? null) ||
        ((payload.zona as string) ?? (payload.quartiere as string) ?? null);
      const mq = enrich?.mq ?? (payload.mq as number | null) ?? null;

      const dropTxt = r.total_drop_pct ? `Ribasso ${Number(r.total_drop_pct).toFixed(1)}%` : null;
      const giorni = r.days_online ? `${r.days_online} giorni online` : null;
      const ribassiCount = r.drops_count ?? 0;
      const ribassiTxt = `${ribassiCount} ribass${ribassiCount === 1 ? "o" : "i"}`;
      const note = [r.fatigue_label, dropTxt, giorni].filter(Boolean).join(" - ") || null;

      // Titolo reale: priorità indirizzo > host+listingId > fallback generico
      let titolo: string;
      if (indirizzoReale && indirizzoReale.trim().length > 0) {
        const parts = [indirizzoReale.trim()];
        if (mq) parts.push(`${mq} mq`);
        parts.push(ribassiTxt);
        titolo = parts.join(" · ");
      } else {
        const host = hostFromUrl(r.url);
        const lid = extractListingIdFromUrl(r.url);
        if (host && lid) {
          titolo = `Annuncio in difficoltà · ${host} #${lid} (${ribassiTxt})`;
        } else {
          titolo = `Annuncio in difficoltà (${ribassiTxt})`;
        }
      }

      items.push({
        id: `dist-${r.id}`,
        fonte: "distress",
        badge: "Distress",
        titolo,
        indirizzo: indirizzoReale ?? "Padova",
        zona: quartiere ?? "Padova",
        prezzo_eur: r.last_price_eur ? Number(r.last_price_eur) : null,
        mq,
        url_sorgente: r.url ?? null,
        data_segnalazione: (r.detected_at ?? new Date().toISOString()).toString(),
        note,
      });
      totals.distress++;
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
