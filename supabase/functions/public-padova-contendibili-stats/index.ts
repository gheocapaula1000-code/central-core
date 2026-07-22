// public-padova-contendibili-stats — preview pubblica, no auth
// Solo aggregati, NESSUNA lista dettagliata.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { publicHeaders, checkRateLimit, rateLimited } from "../_shared/public-stats-utils.ts";

serve(async (req) => {
  const headers = publicHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }), { status: 405, headers });
  }
  const rl = checkRateLimit(req, "pub-contendibili");
  if (!rl.ok) return rateLimited(req, rl.retryAfter);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const [{ count: total }, { count: hot3 }, { count: totAnnunci }, qResp] = await Promise.all([
      supabase.from("padova_contendibili_by_zone_v").select("chiave_match", { count: "exact", head: true }),
      supabase.from("padova_contendibili_by_zone_v").select("chiave_match", { count: "exact", head: true }).gte("n_agenzie", 3),
      supabase.from("padova_listings").select("id", { count: "exact", head: true }),
      supabase.from("padova_contendibili_by_zone_v").select("quartiere").not("quartiere", "is", null),
    ]);

    const quartieriSet = new Set<string>();
    for (const r of (qResp.data ?? [])) if (r.quartiere) quartieriSet.add(r.quartiere);

    const body = {
      total: total ?? 0,
      hot_3plus: hot3 ?? 0,
      tot_quartieri: quartieriSet.size,
      tot_annunci: totAnnunci ?? 0,
    };
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" } }),
      { status: 500, headers },
    );
  }
});
