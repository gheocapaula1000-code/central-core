// Temporary internal runner to validate B2B Finder v0.8 (suppliers mode) live.
// Calls b2b-finder-search (dry + save) and b2b-finder-enrich with smart mode.
// Uses B2B_FINDER_SECRET from env. Public path enabled only via VERIFY-JWT off.
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
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let json: unknown; try { json = JSON.parse(txt); } catch { json = txt; }
  return { status: r.status, body: json };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const product = "Buste Portaposate Con Tovagliolo Airlaid";
  const cities = ["Padova", "Vigonza", "Albignasego"];
  const modes: Array<"clients" | "resellers" | "suppliers"> = ["clients", "resellers", "suppliers"];

  const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const report: any[] = [];
  for (const city of cities) {
    for (const sm of modes) {
      // 1) save (dry_run=false)
      const search = await callFn("b2b-finder-search", {
        product, city, province: "Padova", region: "Veneto",
        search_mode: sm, dry_run: false, limit: 25,
      });
      const job_id = (search.body as any)?.job_id ?? null;
      let enrich: any = null;
      if (job_id) {
        enrich = await callFn("b2b-finder-enrich", {
          job_id, mode: "smart", max_companies: 15,
        });
      }
      // 2) read aggregate
      const enrichJob = (enrich?.body as any)?.enrichment_job_id ?? null;
      let companies: any[] = [];
      if (job_id) {
        // poll briefly
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 4000));
          const { data: j } = await supabase
            .from("b2b_enrichment_jobs").select("status").eq("id", enrichJob).maybeSingle();
          if (j?.status === "completed" || j?.status === "failed") break;
        }
        const { data } = await supabase
          .from("b2b_companies")
          .select("name,comune,phone,metadata,status,score")
          .eq("metadata->>search_mode", sm)
          .eq("metadata->>product_key", "buste_portaposate_airlaid")
          .eq("comune", city)
          .order("score", { ascending: false })
          .limit(60);
        companies = data ?? [];
      }
      report.push({
        city, mode: sm,
        search_status: search.status,
        search_total: (search.body as any)?.total ?? null,
        enrich_status: enrich?.status ?? null,
        enrich_summary: (enrich?.body as any)?.summary ?? null,
        companies_count: companies.length,
        sample: companies.slice(0, 6).map(c => ({
          name: c.name,
          comune: c.comune,
          phone: c.phone,
          buyer_type: (c.metadata as any)?.enrichment?.buyer_type ?? (c.metadata as any)?.buyer_type_hint,
          supplier_type: (c.metadata as any)?.enrichment?.supplier_type ?? null,
          ready: (c.metadata as any)?.enrichment?.ready_to_contact ?? null,
          status_suggestion: (c.metadata as any)?.enrichment?.status_suggestion ?? null,
          buyer_fit: (c.metadata as any)?.enrichment?.buyer_fit_score ?? null,
          supplier_fit: (c.metadata as any)?.enrichment?.supplier_fit_score ?? null,
          reseller_fit: (c.metadata as any)?.enrichment?.reseller_fit_score ?? null,
          fit_reason: (c.metadata as any)?.enrichment?.buyer_fit_reason ?? null,
        })),
      });
    }
  }
  return new Response(JSON.stringify({ ok: true, report }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
