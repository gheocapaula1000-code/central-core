// b2b-supplier-runner — kicks supplier searches across scopes for
// "Buste Portaposate Con Tovagliolo Airlaid" and aggregates a report.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

const PRODUCT = "Buste Portaposate Con Tovagliolo Airlaid";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const op = url.searchParams.get("op") ?? "kick";
  const supabase = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  if (op === "kick") {
    // 3 comuni × scope region + 1 scope italy (deduplicato via productKey/search_mode)
    const combos: Array<{ city: string; supplier_scope: "region" | "italy" }> = [
      { city: "Padova", supplier_scope: "region" },
      { city: "Vigonza", supplier_scope: "region" },
      { city: "Albignasego", supplier_scope: "region" },
      { city: "Padova", supplier_scope: "italy" },
    ];
    const task = (async () => {
      await Promise.all(combos.map(async (c) => {
        try {
          const search = await callFn("b2b-finder-search", {
            product: PRODUCT,
            city: c.city,
            province: "PD",
            region: "Veneto",
            search_mode: "suppliers",
            supplier_scope: c.supplier_scope,
            dry_run: false,
            limit: 50,
          });
          const jid = (search.body as any)?.data?.job_id ?? null;
          if (jid) {
            await callFn("b2b-finder-enrich", { job_id: jid, mode: "smart", max_companies: 20 });
          }
        } catch (_) { /* ignore */ }
      }));
    })();
    // @ts-ignore EdgeRuntime
    EdgeRuntime.waitUntil(task);
    return new Response(JSON.stringify({ ok: true, kicked: combos.length }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (op === "report") {
    // Aggregate all supplier companies for buste_portaposate_airlaid
    const { data: rows } = await supabase
      .from("b2b_companies")
      .select("name,comune,provincia,phone,website,status,score,metadata")
      .eq("metadata->>search_mode", "suppliers")
      .eq("metadata->>product_key", "buste_portaposate_airlaid")
      .order("score", { ascending: false })
      .limit(500);

    const list = rows ?? [];
    const withPhone = list.filter((r) => !!r.phone).length;
    const withSite = list.filter((r) => !!r.website).length;
    const enriched = list.filter((r) => (r.metadata as any)?.enrichment);
    const ready = enriched.filter(
      (r) => (r.metadata as any).enrichment?.status_suggestion === "Pronto Da Contattare",
    );
    // Excluded "Cliente Finale" check
    const wronglyClient = enriched.filter((r) => {
      const e: any = (r.metadata as any).enrichment;
      const bt = (e?.buyer_type ?? (r.metadata as any)?.buyer_type_hint ?? "").toLowerCase();
      return bt.includes("cliente finale") || bt === "restaurant";
    });

    // Cost
    const { data: ledger } = await supabase
      .from("b2b_usage_ledger")
      .select("cost_eur,job_id,provider,action,metadata")
      .order("created_at", { ascending: false })
      .limit(500);
    const supplierJobs = new Set(
      (await supabase
        .from("b2b_search_jobs")
        .select("id,filters,vertical")
        .eq("vertical", "buste_portaposate_airlaid")
        .order("created_at", { ascending: false })
        .limit(100)).data?.filter((j: any) => j.filters?.search_mode === "suppliers").map((j: any) => j.id) ?? [],
    );
    const cost = (ledger ?? [])
      .filter((l: any) => supplierJobs.has(l.job_id))
      .reduce((acc: number, l: any) => acc + Number(l.cost_eur ?? 0), 0);

    const examples = list.slice(0, 10).map((r) => {
      const e: any = (r.metadata as any)?.enrichment ?? {};
      return {
        name: r.name,
        citta: r.comune,
        provincia: r.provincia,
        website: e.official_website ?? r.website ?? null,
        phone: e.phone ?? r.phone ?? null,
        supplier_type: e.supplier_type ?? (r.metadata as any)?.buyer_type_hint ?? null,
        supplier_fit_reason: e.supplier_fit_reason ?? e.fit_reason ?? null,
        supplier_fit_score: e.supplier_fit_score ?? null,
        ready_to_contact: e.ready_to_contact ?? null,
        supplier_scope: (r.metadata as any)?.supplier_scope ?? null,
      };
    });

    return new Response(
      JSON.stringify(
        {
          ok: true,
          product: PRODUCT,
          totale_fornitori: list.length,
          con_telefono: withPhone,
          con_sito: withSite,
          enriched: enriched.length,
          pronti_da_contattare: ready.length,
          erroneamente_clienti_finali: wronglyClient.length,
          costo_enrichment_eur: Number(cost.toFixed(4)),
          examples,
        },
        null,
        2,
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ ok: false, error: "unknown op" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
});
