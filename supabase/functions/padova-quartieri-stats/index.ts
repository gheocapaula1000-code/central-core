// padova-quartieri-stats — Edge Function
// Aggrega per quartiere: contendibili, annunci, contesi 3+, agenzie distinte, fascia prezzo.
// Auth: verify_jwt=false. Chiamata via core-proxy della PWA.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret, x-source-app",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const debugId = () => crypto.randomUUID().slice(0, 8);

async function fetchAll<T>(query: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await query().range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const did = debugId();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) contendibili (tutte le 235 righe)
    const contendibili = await fetchAll<{
      quartiere: string | null; n_agenzie: number; agenzie: string[] | null;
      prezzo_min: number | null; prezzo_max: number | null;
    }>(() => supabase
      .from("padova_contendibili")
      .select("quartiere, n_agenzie, agenzie, prezzo_min, prezzo_max"));

    // 2) annunci (padova_listings) — quartiere, agency, fonte
    const listings = await fetchAll<{ quartiere: string | null; agency: string | null }>(
      () => supabase.from("padova_listings").select("quartiere, agency"),
    );

    type Acc = {
      quartiere: string;
      n_contendibili: number;
      n_contesi_3plus: number;
      n_annunci: number;
      agenzie: Set<string>;
      prezzo_min: number | null;
      prezzo_max: number | null;
    };
    const byQ = new Map<string, Acc>();
    const ensure = (q: string): Acc => {
      let a = byQ.get(q);
      if (!a) {
        a = { quartiere: q, n_contendibili: 0, n_contesi_3plus: 0, n_annunci: 0, agenzie: new Set(), prezzo_min: null, prezzo_max: null };
        byQ.set(q, a);
      }
      return a;
    };

    for (const c of contendibili) {
      if (!c.quartiere) continue;
      const a = ensure(c.quartiere);
      a.n_contendibili += 1;
      if (c.n_agenzie >= 3) a.n_contesi_3plus += 1;
      if (c.prezzo_min != null) a.prezzo_min = a.prezzo_min == null ? c.prezzo_min : Math.min(a.prezzo_min, c.prezzo_min);
      if (c.prezzo_max != null) a.prezzo_max = a.prezzo_max == null ? c.prezzo_max : Math.max(a.prezzo_max, c.prezzo_max);
    }

    for (const l of listings) {
      if (!l.quartiere) continue;
      const a = ensure(l.quartiere);
      a.n_annunci += 1;
      if (l.agency && l.agency !== "Agenzie") a.agenzie.add(l.agency.trim().toLowerCase());
    }

    const quartieri = Array.from(byQ.values())
      .map((a) => ({
        quartiere: a.quartiere,
        n_contendibili: a.n_contendibili,
        n_annunci: a.n_annunci,
        n_contesi_3plus: a.n_contesi_3plus,
        n_agenzie: a.agenzie.size,
        prezzo_min: a.prezzo_min,
        prezzo_max: a.prezzo_max,
      }))
      .sort((a, b) => b.n_contendibili - a.n_contendibili);

    // Totali Padova
    const totAgenzieGlobal = new Set<string>();
    for (const l of listings) if (l.agency && l.agency !== "Agenzie") totAgenzieGlobal.add(l.agency.trim().toLowerCase());

    const totals = {
      tot_annunci: listings.length,
      tot_contendibili: contendibili.length,
      tot_contesi_3plus: contendibili.filter((c) => c.n_agenzie >= 3).length,
      tot_agenzie: totAgenzieGlobal.size,
      tot_quartieri: quartieri.length,
    };

    return new Response(JSON.stringify({
      ok: true,
      data: { quartieri, totals },
      debug_id: did,
    }), { status: 200, headers: CORS });
  } catch (e) {
    console.error(`[padova-quartieri-stats] ${did}`, e);
    return new Response(JSON.stringify({
      ok: false, data: null, debug_id: did,
      error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" },
    }), { status: 500, headers: CORS });
  }
});
