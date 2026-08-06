// civiko-cambi-agenzia-list
// Endpoint pubblico white-label: elenca i cambi agenzia recenti a Padova
// come lead autonomo (indipendente dai contendibili).
//
// Contratto conteggi (autorevole):
//  - `total` è il COUNT esatto lato database con gli stessi filtri, non la
//    lunghezza della pagina restituita;
//  - `offset` è realmente applicato via range() ed è bounded dal total;
//  - `items_count`, `has_more` e `snapshot_complete` descrivono la pagina.
//
// Nessun placeholder: titolo/indirizzo assenti restano null (stato DND),
// mai riempiti con "Immobile a Padova" o "Padova".
//
// Query params: quartiere?, zona_omi?, days=30, limit=50, offset=0

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Normalizza un testo opzionale: mai placeholder, mai stringa vuota. */
export function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length ? t : null;
}

export function boundedLimit(raw: string | null): number {
  const n = parseInt(raw ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

export function boundedOffset(raw: string | null, total: number): number {
  const n = parseInt(raw ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (total <= 0) return 0;
  // offset oltre il totale => ultima posizione valida, mai range fuori scala
  return Math.min(n, Math.max(0, total - 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const quartiere = url.searchParams.get("quartiere");
  const zonaOmi = url.searchParams.get("zona_omi");
  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
  const limit = boundedLimit(url.searchParams.get("limit"));

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Stessa query, stessi filtri: count exact autorevole nella query dei dati.
    let q = supabase
      .from("padova_cambi_agenzia")
      .select(
        "id, data_cambio, portale, agenzia_precedente, agenzia_nuova, titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali, contendibile_overlap",
        { count: "exact" },
      )
      .eq("is_active", true)
      .gte("data_cambio", sinceIso)
      .order("data_cambio", { ascending: false })
      .order("id", { ascending: false });

    if (quartiere) q = q.ilike("quartiere", quartiere);
    if (zonaOmi) q = q.ilike("zona_omi", zonaOmi);

    // Il totale serve per limitare l'offset: prima si conta, poi si pagina.
    let countQ = supabase
      .from("padova_cambi_agenzia")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .gte("data_cambio", sinceIso);
    if (quartiere) countQ = countQ.ilike("quartiere", quartiere);
    if (zonaOmi) countQ = countQ.ilike("zona_omi", zonaOmi);
    const { count: preCount, error: countErr } = await countQ;
    if (countErr) throw countErr;
    const total = typeof preCount === "number" ? preCount : 0;

    const offset = boundedOffset(url.searchParams.get("offset"), total);

    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    const authoritativeTotal = typeof count === "number" ? count : total;
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
        // Nessun dato inventato: assente resta assente.
        titolo: nullableText(r.titolo),
        indirizzo: nullableText(r.indirizzo),
        quartiere: nullableText(r.quartiere),
        zona_omi: nullableText(r.zona_omi),
        prezzo_eur: r.prezzo_eur !== null ? Number(r.prezzo_eur) : null,
        mq: r.mq !== null ? Number(r.mq) : null,
        locali: r.locali ?? null,
        contendibile_overlap: !!r.contendibile_overlap,
      };
    });

    return json({
      ok: true,
      updated_at: new Date().toISOString(),
      window_days: days,
      // total = COUNT esatto sui filtri, indipendente dalla paginazione.
      total: authoritativeTotal,
      items_count: items.length,
      limit,
      offset,
      has_more: offset + items.length < authoritativeTotal,
      snapshot_complete: authoritativeTotal === items.length,
      items,
    });
  } catch (e) {
    return json({
      ok: false,
      error: "internal_error",
      message: (e as Error).message,
      items: [],
    }, 500);
  }
});
