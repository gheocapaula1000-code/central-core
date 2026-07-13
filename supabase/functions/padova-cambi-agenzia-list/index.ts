// padova-cambi-agenzia-list — Edge Function
// Ritorna le righe da public.padova_cambi_agenzia con is_active = true.
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
    const limit = Math.min(
      Math.max(Number(body.limit ?? url.searchParams.get("limit") ?? 100) || 100, 1),
      1000,
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error, count } = await supabase
      .from("padova_cambi_agenzia")
      .select(
        "id, titolo, indirizzo, quartiere, zona_omi, prezzo_eur, mq, locali, agenzia_precedente, agenzia_nuova, data_cambio, portale, contendibile_overlap",
        { count: "exact" },
      )
      .eq("is_active", true)
      .order("data_cambio", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const rows = data ?? [];

    const payload = sanitize({
      ok: true,
      data: {
        items: rows,
        total: count ?? rows.length,
        limit,
      },
      debug_id: did,
    });

    return new Response(JSON.stringify(payload), { status: 200, headers: CORS });
  } catch (e) {
    console.error(`[padova-cambi-agenzia-list] ${did}`, e);
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" },
    }), { status: 500, headers: CORS });
  }
});
