// civiko-cambi-agenzia-list
// Endpoint pubblico white-label: elenca i cambi agenzia recenti a Padova
// come lead autonomo (indipendente dai contendibili).
// Query params: quartiere?, zona_omi?, days=30, limit=50

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

  const url = new URL(req.url);
  const quartiere = url.searchParams.get("quartiere");
  const zonaOmi = url.searchParams.get("zona_omi");
  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    let q = supabase
      .from("padova_cambi_agenzia")
      .select("id, data_cambio, portale, agenzia_precedente, agenzia_nuova, titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali, contendibile_overlap")
      .eq("is_active", true)
      .gte("data_cambio", sinceIso)
      .order("data_cambio", { ascending: false })
      .limit(limit);

    if (quartiere) q = q.ilike("quartiere", quartiere);
    if (zonaOmi) q = q.ilike("zona_omi", zonaOmi);

    const { data, error } = await q;
    if (error) throw error;

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
        titolo: r.titolo ?? "Immobile a Padova",
        indirizzo: r.indirizzo ?? "Padova",
        quartiere: r.quartiere ?? null,
        zona_omi: r.zona_omi ?? null,
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
      total: items.length,
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
