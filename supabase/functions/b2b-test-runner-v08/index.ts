// Kick-off runner: triggers search+enrich for all combos, returns immediately.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SECRET = Deno.env.get("B2B_FINDER_SECRET")!;

async function callFn(name: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ANON}`,
      "x-internal-secret": SECRET,
      "x-source-app": "b2b-finder",
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let json: unknown; try { json = JSON.parse(txt); } catch { json = txt; }
  return { status: r.status, body: json };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const op = url.searchParams.get("op") ?? "kick";
  const product = "Buste Portaposate Con Tovagliolo Airlaid";
  const cities = ["Padova", "Vigonza", "Albignasego"];
  const modes: Array<"clients" | "resellers" | "suppliers"> = ["clients", "resellers", "suppliers"];
  const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (op === "kick") {
    const out: any[] = [];
    for (const city of cities) {
      for (const sm of modes) {
        const search = await callFn("b2b-finder-search", {
          product, city, province: "PD", region: "Veneto",
          search_mode: sm, dry_run: false, limit: 25,
        });
        const job_id = (search.body as any)?.job_id ?? (search.body as any)?.data?.job_id ?? null;
        let enrich: any = null;
        if (job_id) {
          enrich = await callFn("b2b-finder-enrich", { job_id, mode: "smart", max_companies: 15 });
        }
        out.push({
          city, mode: sm,
          search_status: search.status,
          search_total: (search.body as any)?.total ?? (search.body as any)?.data?.total ?? null,
          job_id,
          enrich_status: enrich?.status ?? null,
          enrichment_job_id: (enrich?.body as any)?.enrichment_job_id ?? (enrich?.body as any)?.data?.enrichment_job_id ?? null,
        });
      }
    }
    return new Response(JSON.stringify({ ok: true, kicked: out }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // op=report — aggregates results
  const report: any[] = [];
  for (const city of cities) {
    for (const sm of modes) {
      const { data } = await supabase
        .from("b2b_companies")
        .select("name,comune,phone,metadata,status,score")
        .eq("metadata->>search_mode", sm)
        .eq("metadata->>product_key", "buste_portaposate_airlaid")
        .eq("comune", city)
        .order("score", { ascending: false })
        .limit(60);
      const rows = data ?? [];
      const enriched = rows.filter(r => (r.metadata as any)?.enrichment);
      const ready = enriched.filter(r => (r.metadata as any).enrichment.status_suggestion === "Pronto Da Contattare");
      const migl = enriched.filter(r => (r.metadata as any).enrichment.status_suggestion === "Da Migliorare");
      const excl = enriched.filter(r => (r.metadata as any).enrichment.status_suggestion === "Escluso");
      report.push({
        city, mode: sm,
        total: rows.length,
        enriched: enriched.length,
        pronti_con_telefono: ready.length,
        da_migliorare: migl.length,
        esclusi: excl.length,
        examples: rows.slice(0, 5).map(c => {
          const e = (c.metadata as any)?.enrichment ?? {};
          return {
            name: c.name, comune: c.comune,
            phone: e.phone ?? c.phone,
            tipo: e.supplier_type ?? e.buyer_type ?? (c.metadata as any)?.buyer_type_hint ?? null,
            buyer_fit_score: e.buyer_fit_score ?? null,
            supplier_fit_score: e.supplier_fit_score ?? null,
            reseller_fit_score: e.reseller_fit_score ?? null,
            status_suggestion: e.status_suggestion ?? null,
            ready_to_contact: e.ready_to_contact ?? null,
            fit_reason: e.buyer_fit_reason ?? e.fit_reason ?? null,
          };
        }),
      });
    }
  }
  return new Response(JSON.stringify({ ok: true, report }, null, 2), { headers: { "Content-Type": "application/json" } });
});
