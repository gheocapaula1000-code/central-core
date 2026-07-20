// padova-privati-list — Edge Function
// Read-only: ritorna i privati reali da padova_listings (tipo_lead in
// PRIVATO/privato/privato_stanco), SOLO comune='Padova' per default.
// I lead di altri comuni della provincia restano in tabella ma non escono
// da questo endpoint (che alimenta la PWA Padova).
// Auth: tramite core-proxy (Authorization Bearer ANON). Nessun nuovo secret.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, handleOptions } from "../_shared/http.ts";

const BANNED = /\b(AI|IA|intelligenza|stima|perizia|valutazione|valore reale|prezzo giusto|garantito)\b/gi;
function sanitize<T>(v: T): T {
  if (typeof v === "string") return v.replace(BANNED, "rilevato") as unknown as T;
  if (Array.isArray(v)) return v.map(sanitize) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = sanitize(val);
    return out as unknown as T;
  }
  return v;
}

const SELECT_COLS =
  "fonte,url,telefono,mq,locali,bagni,prezzo,lat,lng,indirizzo," +
  "quartiere,imported_at,tipo_lead,comune,omi_zone,commercial_zone_slug," +
  "zone_match_method,zone_match_confidence";

serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const cors = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    let payload: {
      quartiere?: string;
      commercial_zone_slug?: string;
      solo_con_telefono?: boolean;
      offset?: number;
      limit?: number;
    } = {};
    try { if (req.method === "POST") payload = await req.json(); } catch { /* empty */ }

    const offset = Math.max(0, Number(payload.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Number(payload.limit ?? 200)));

    // Default: solo Padova città.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = (supabase.from("padova_listings") as any)
      .select(SELECT_COLS, { count: "exact" })
      .in("tipo_lead", ["PRIVATO", "privato", "privato_stanco"])
      .eq("comune", "Padova");

    if (payload.commercial_zone_slug) {
      q = q.eq("commercial_zone_slug", payload.commercial_zone_slug);
    } else if (payload.quartiere) {
      q = q.eq("quartiere", payload.quartiere);
    }
    if (payload.solo_con_telefono) q = q.not("telefono", "is", null);

    q = q.order("telefono", { ascending: false, nullsFirst: false })
         .order("prezzo", { ascending: true, nullsFirst: false })
         .range(offset, offset + limit - 1);

    const { data, count, error } = await q;
    if (error) return json({ error: true, code: "DB_ERROR", message: error.message }, 500);

    // Count con_telefono globale (rispettando i filtri applicati)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let telQ: any = (supabase.from("padova_listings") as any)
      .select("id", { count: "exact", head: true })
      .in("tipo_lead", ["PRIVATO", "privato", "privato_stanco"])
      .eq("comune", "Padova")
      .not("telefono", "is", null);
    if (payload.commercial_zone_slug) telQ = telQ.eq("commercial_zone_slug", payload.commercial_zone_slug);
    else if (payload.quartiere) telQ = telQ.eq("quartiere", payload.quartiere);
    const { count: conTel } = await telQ;

    const privati = sanitize(data ?? []);
    const body = {
      ok: true,
      privati,
      total: count ?? privati.length,
      con_telefono: conTel ?? 0,
      offset,
      limit,
      data: { privati, total: count ?? privati.length, con_telefono: conTel ?? 0 },
    };
    return json(body, 200);
  } catch (e) {
    return json({ error: true, code: "INTERNAL", message: e instanceof Error ? e.message : "error" }, 500);
  }
});
