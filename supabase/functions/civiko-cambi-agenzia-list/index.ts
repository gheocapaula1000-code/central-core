// civiko-cambi-agenzia-list
// Snapshot autorevole dei cambi agenzia. Server-to-server Civiko One only;
// full-city esclusivamente per owner/admin risolto lato Core.
// Query params: commercial_zone_slug?, quartiere?, zona_omi?, days=30,
// limit=50, offset=0.

import {
  authorizeCivikoSnapshot,
  CIVIKO_SNAPSHOT_CORS as CORS,
  snapshotAccessError,
} from "../civiko-authorized-snapshot/access.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const quartiere = url.searchParams.get("quartiere");
  const zonaOmi = url.searchParams.get("zona_omi");
  const literalFilter = (value: string | null): string | null => {
    if (value == null || value.trim() === "") return null;
    const clean = value.trim();
    if (clean.length > 120 || /[%_]/.test(clean)) return "__INVALID__";
    return clean;
  };
  const quartiereExact = literalFilter(quartiere);
  const zonaOmiExact = literalFilter(zonaOmi);
  if (quartiereExact === "__INVALID__" || zonaOmiExact === "__INVALID__") {
    return json({ ok: false, error: "invalid_literal_filter" }, 400);
  }
  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.min(Math.max(offsetRaw, 0), 1_000_000) : 0;

  const access = await authorizeCivikoSnapshot(req);
  if (!access.ok) return snapshotAccessError(access);
  const supabase = access.client;

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    let q = supabase
      .from("padova_cambi_agenzia")
      .select("id, data_cambio, portale, agenzia_precedente, agenzia_nuova, titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali, contendibile_overlap, commercial_zone_slug", { count: "exact" })
      .eq("is_active", true)
      .gte("data_cambio", sinceIso)
      .in("commercial_zone_slug", access.slugs)
      .order("data_cambio", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (quartiereExact) q = q.eq("quartiere", quartiereExact);
    if (zonaOmiExact) q = q.eq("zona_omi", zonaOmiExact);

    const { data, error, count } = await q;
    if (error || count === null) throw new Error("authoritative_query_failed");

    const now = Date.now();
    const items = (data ?? []).map((r) => {
      const dc = r.data_cambio ? new Date(r.data_cambio).getTime() : now;
      const giorniFa = Math.max(0, Math.floor((now - dc) / (24 * 60 * 60 * 1000)));
      return {
        id: r.id,
        data_cambio: r.data_cambio,
        giorni_fa: giorniFa,
        portale: r.portale ?? null,
        agenzia_nuova: r.agenzia_nuova,
        agenzia_precedente: r.agenzia_precedente,
        // Null e' informazione onesta/DND; mai inventare un titolo/indirizzo.
        titolo: r.titolo ?? null,
        indirizzo: r.indirizzo ?? null,
        quartiere: r.quartiere ?? null,
        zona_omi: r.zona_omi ?? null,
        commercial_zone_slug: r.commercial_zone_slug,
        prezzo_eur: r.prezzo_eur !== null ? Number(r.prezzo_eur) : null,
        mq: r.mq !== null ? Number(r.mq) : null,
        locali: r.locali ?? null,
        contendibile_overlap: !!r.contendibile_overlap,
      };
    });

    const total = count;
    const itemsCount = items.length;
    const hasMore = offset + itemsCount < total;
    const snapshot = {
      items,
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
    };
    return json({
      ok: true,
      updated_at: new Date().toISOString(),
      window_days: days,
      ...snapshot,
      data: snapshot,
    });
  } catch (e) {
    console.error("[civiko-cambi-agenzia-list] authoritative query failed");
    return json({
      ok: false,
      error: "authoritative_query_failed",
      snapshot_complete: false,
      total: null,
      items_count: 0,
      has_more: false,
      items: [],
      data: { items: [], total: null, items_count: 0, snapshot_complete: false },
    }, 502);
  }
});
