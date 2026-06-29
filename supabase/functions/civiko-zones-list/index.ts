// civiko-zones-list — public listing of commercial zones with occupancy status.
// Privacy: does NOT expose trial_agency_id / occupied_agency_id.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const QUARTIERI_BY_SLUG: Record<string, string[]> = {
  "centro-storico": ["Centro Storico", "Riviere", "Carmine", "Savonarola", "S.Sofia"],
  "palestro-sacra-famiglia": ["Palestro", "Sacra Famiglia"],
  "portello-stazione-fiera": ["Portello", "Stazione", "Scrovegni", "Fiera", "Direzionale"],
  "madonna-pellegrina-bassanello": ["Madonna Pellegrina", "S.Rita", "Bassanello", "Guizza", "Voltabarozzo"],
  "arcella-nord-torre": ["Arcella Nord", "Mortise", "Altichiero", "Pontevigodarzere", "Torre"],
  "prima-arcella-direzionale": ["Prima Arcella", "Borgomagno"],
  "paltana-brusegana-ovest": ["Chiesanuova", "Brusegana", "Paltana", "Mandria", "Voltabrusegana"],
  "ponte-brenta-forcellini": ["Ponte di Brenta", "S.Lazzaro", "Forcellini", "Terranegra"],
  "camin-zip": ["Camin", "Zona Industriale", "ZIP"],
  "sud-rurale": ["Salboro", "Rurale Sud"],
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const debug_id = crypto.randomUUID();

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const { data, error } = await sb
      .from("civiko_commercial_zones")
      .select(
        "slug,nome,tier,canone_mese_eur,provvigioni_anno_eur,contendibili_count,status,trial_reserved_until,occupied_since",
      )
      .order("canone_mese_eur", { ascending: false });

    if (error) {
      return json({ ok: false, error: { code: "DB_ERROR", message: error.message }, debug_id }, 500);
    }

    const zones = (data ?? []).map((z) => ({
      slug: z.slug,
      nome: z.nome,
      tier: z.tier,
      canone_mese_eur: z.canone_mese_eur,
      provvigioni_anno_eur: z.provvigioni_anno_eur,
      contendibili_count: z.contendibili_count,
      status: z.status,
      trial_reserved_until: z.trial_reserved_until,
      quartieri_principali: QUARTIERI_BY_SLUG[z.slug] ?? [],
    }));

    return json({ ok: true, data: { zones, count: zones.length }, debug_id });
  } catch (e) {
    return json(
      { ok: false, error: { code: "INTERNAL_ERROR", message: (e as Error).message }, debug_id },
      500,
    );
  }
});
