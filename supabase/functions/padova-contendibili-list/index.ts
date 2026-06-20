// padova-contendibili-list — Edge Function
// Ritorna le righe da public.padova_contendibili con filtri opzionali.
// Auth: verify_jwt=false (default Lovable). Chiamata via core-proxy della PWA.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-source-app",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const BANNED = /\b(AI|IA|intelligenza|stima|perizia|valutazione|valore reale|prezzo giusto|garantito|garantita|garantiti|garantite)\b/gi;
function sanitize(s: unknown): unknown {
  if (typeof s === "string") return s.replace(BANNED, "rilevato");
  if (Array.isArray(s)) return s.map(sanitize);
  if (s && typeof s === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) o[k] = sanitize(v);
    return o;
  }
  return s;
}

const debugId = () => crypto.randomUUID().slice(0, 8);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const did = debugId();

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const quartiere = (body.quartiere ?? url.searchParams.get("quartiere") ?? null) as string | null;
    const min_agenzie = Number(body.min_agenzie ?? url.searchParams.get("min_agenzie") ?? 2) || 2;
    const limit = Math.min(Math.max(Number(body.limit ?? url.searchParams.get("limit") ?? 500) || 500, 1), 1000);
    const offset = Math.max(Number(body.offset ?? url.searchParams.get("offset") ?? 0) || 0, 0);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let q = supabase
      .from("padova_contendibili")
      .select("chiave_match, n_agenzie, agenzie, fonti, confidenza, prezzo_min, prezzo_max, mq, locali, bagni, quartiere, lat, lng, urls, prezzo_medio_zona_eur_mq, prezzo_immobile_eur_mq, differenza_zona_pct, giorni_sul_mercato, data_primo_annuncio", { count: "exact" })
      .gte("n_agenzie", min_agenzie);
    if (quartiere) q = q.eq("quartiere", quartiere);

    // Ordinamento: n_agenzie DESC, poi rank confidenza via secondary sort lato JS (Postgres CASE non semplice qui)
    q = q.order("n_agenzie", { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    const rank: Record<string, number> = { ALTA: 0, MEDIA: 1, DA_CONFERMARE: 2 };
    const rows = (data ?? []).slice().sort((a, b) => {
      if (b.n_agenzie !== a.n_agenzie) return b.n_agenzie - a.n_agenzie;
      return (rank[a.confidenza] ?? 9) - (rank[b.confidenza] ?? 9);
    });

    // hot_3plus = totale (non solo pagina) con n_agenzie>=3
    const { count: hot } = await supabase
      .from("padova_contendibili")
      .select("chiave_match", { count: "exact", head: true })
      .gte("n_agenzie", 3);

    const payload = sanitize({
      ok: true,
      data: {
        items: rows,
        total: count ?? rows.length,
        hot_3plus: hot ?? 0,
        offset,
        limit,
      },
      debug_id: did,
    });

    return new Response(JSON.stringify(payload), { status: 200, headers: CORS });
  } catch (e) {
    console.error(`[padova-contendibili-list] ${did}`, e);
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" },
    }), { status: 500, headers: CORS });
  }
});
