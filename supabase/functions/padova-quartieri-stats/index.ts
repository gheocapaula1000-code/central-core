// padova-quartieri-stats — Edge Function
// Legge le viste normalizzate padova_quartieri_stats_v e padova_listings_totali_v.
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

    // 1) Righe per zona già aggregate/normalizzate
    const rows = await fetchAll<{
      zona: string | null;
      n_contendibili: number | null;
      n_annunci: number | null;
      n_agenzie: number | null;
      n_ribassi: number | null;
      n_privati: number | null;
      prezzo_min: number | null;
      prezzo_max: number | null;
    }>(() => supabase
      .from("padova_quartieri_stats_v")
      .select("zona, n_contendibili, n_annunci, n_agenzie, n_ribassi, n_privati, prezzo_min, prezzo_max"));

    // 2) Totali globali (unica riga)
    const { data: totalsRow, error: totalsErr } = await supabase
      .from("padova_listings_totali_v")
      .select("tot_annunci, tot_agenzie")
      .maybeSingle();
    if (totalsErr) throw totalsErr;

    // 3) Totali dall'anagrafe listings (mai bloccante per le zone)
    let totali: { tot_annunci: number; tot_agenzie: number } | null = null;
    try {
      const { data: totaliRow, error: totaliErr } = await supabase
        .from("padova_totali_v")
        .select("tot_annunci, tot_agenzie")
        .maybeSingle();
      if (!totaliErr && totaliRow) {
        totali = {
          tot_annunci: Number(totaliRow.tot_annunci ?? 0),
          tot_agenzie: Number(totaliRow.tot_agenzie ?? 0),
        };
      }
    } catch (e) {
      console.error(`[padova-quartieri-stats] totali error ${did}`, e);
    }

    const quartieri = rows
      .filter((r) => r.zona)
      .map((r) => ({
        quartiere: r.zona as string,
        n_contendibili: Number(r.n_contendibili ?? 0),
        n_annunci: Number(r.n_annunci ?? 0),
        n_agenzie: Number(r.n_agenzie ?? 0),
        n_ribassi: Number(r.n_ribassi ?? 0),
        n_privati: Number(r.n_privati ?? 0),
        prezzo_min: r.prezzo_min,
        prezzo_max: r.prezzo_max,
      }))
      .sort((a, b) => b.n_contendibili - a.n_contendibili);

    const totals = {
      tot_annunci: Number(totalsRow?.tot_annunci ?? 0),
      tot_agenzie: Number(totalsRow?.tot_agenzie ?? 0),
      tot_quartieri_con_contendibili: quartieri.filter((q) => q.n_contendibili > 0).length,
    };

    return new Response(JSON.stringify({
      ok: true,
      quartieri,
      ...totals,
      totali,
      data: { quartieri, totals, totali },
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
