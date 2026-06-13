// public-padova-quartieri-stats — preview pubblica, no auth
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { publicHeaders, checkRateLimit, rateLimited, fetchAll } from "../_shared/public-stats-utils.ts";

serve(async (req) => {
  const headers = publicHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED" } }), { status: 405, headers });
  }
  const rl = checkRateLimit(req, "pub-quartieri");
  if (!rl.ok) return rateLimited(req, rl.retryAfter);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const contendibili = await fetchAll<{ quartiere: string | null; n_agenzie: number }>(
      () => supabase.from("padova_contendibili").select("quartiere, n_agenzie"),
    );
    const listings = await fetchAll<{ quartiere: string | null; agency: string | null }>(
      () => supabase.from("padova_listings").select("quartiere, agency"),
    );

    type Acc = { quartiere: string; contendibili: number; annunci: number; agenzie: Set<string> };
    const byQ = new Map<string, Acc>();
    const ensure = (q: string): Acc => {
      let a = byQ.get(q);
      if (!a) { a = { quartiere: q, contendibili: 0, annunci: 0, agenzie: new Set() }; byQ.set(q, a); }
      return a;
    };

    for (const c of contendibili) if (c.quartiere) ensure(c.quartiere).contendibili += 1;
    for (const l of listings) {
      if (!l.quartiere) continue;
      const a = ensure(l.quartiere);
      a.annunci += 1;
      if (l.agency && l.agency !== "Agenzie") a.agenzie.add(l.agency.trim().toLowerCase());
    }

    const quartieri = Array.from(byQ.values())
      .filter((a) => a.contendibili > 0)
      .map((a) => ({
        quartiere: a.quartiere,
        contendibili: a.contendibili,
        annunci: a.annunci,
        agenzie: a.agenzie.size,
      }))
      .sort((a, b) => (b.contendibili - a.contendibili) || (b.annunci - a.annunci));

    const body = {
      tot_annunci: listings.length,
      tot_contendibili: contendibili.length,
      tot_quartieri_con_contendibili: quartieri.length,
      quartieri,
    };
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "unknown" } }),
      { status: 500, headers },
    );
  }
});
