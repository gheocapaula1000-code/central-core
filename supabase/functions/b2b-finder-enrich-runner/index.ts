// One-shot test runner: search 3 comuni + start enrichment + report pre/post phone counts.
// Internal use only. Auth via x-internal-secret = B2B_FINDER_SECRET.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const FN_BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "") + "/functions/v1";
const SECRET = Deno.env.get("B2B_FINDER_SECRET") ?? "";

async function callFn(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${FN_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": SECRET,
      "x-source-app": "b2b-finder",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

Deno.serve(async (req) => {
  // Auth: gateway already verifies JWT; accept any bearer or internal secret.
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ") && req.headers.get("x-internal-secret") !== SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 });
  }
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "run";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  if (action === "report") {
    const enrichmentJobId = url.searchParams.get("enrichment_job_id");
    const comune = url.searchParams.get("comune");
    if (!enrichmentJobId || !comune) {
      return new Response(JSON.stringify({ ok: false, error: "missing params" }), { status: 400 });
    }
    const { data: job } = await supabase.from("b2b_enrichment_jobs").select("*").eq("id", enrichmentJobId).single();
    const companyIds: string[] = job?.company_ids ?? [];
    const { data: companies } = await supabase.from("b2b_companies")
      .select("id,name,phone,address,metadata")
      .in("id", companyIds);
    const total = companies?.length ?? 0;
    let withPhoneAfter = 0;
    let readyWithPhone = 0;
    let needsPhone = 0;
    const examples: any[] = [];
    for (const c of companies ?? []) {
      const enr = (c.metadata as any)?.enrichment ?? {};
      const pd = enr.phone_discovery ?? null;
      const phone = c.phone ?? enr.phone ?? null;
      if (phone) withPhoneAfter++;
      if (pd?.found && enr.status_suggestion === "Pronto Da Contattare") readyWithPhone++;
      if (!phone && enr.status_suggestion === "Da Migliorare") needsPhone++;
      if (pd?.found && examples.length < 5) {
        examples.push({
          company: c.name,
          phone: pd.phone,
          phone_href: pd.phone_href,
          source: pd.source,
          confidence: pd.confidence,
          checked_sources: pd.checked_sources,
        });
      }
    }
    return new Response(JSON.stringify({
      ok: true,
      comune,
      total,
      with_phone_after: withPhoneAfter,
      ready_with_phone: readyWithPhone,
      needs_phone_da_migliorare: needsPhone,
      job_status: job?.status,
      processed: job?.processed,
      cost_eur: job?.cost_eur,
      examples,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  // Default action: run search + enrichment for one comune
  const comune = url.searchParams.get("comune") ?? "Padova";

  // Count pre-existing phones for this comune
  const { data: preRows } = await supabase.from("b2b_companies")
    .select("id,phone").eq("comune", comune);
  const preTotal = preRows?.length ?? 0;
  const prePhone = (preRows ?? []).filter((r: any) => r.phone).length;

  // 1) Search
  const search = await callFn("/b2b-finder-search", {
    comune, provincia: "PD", vertical: "coprimacchia_tnt", dry_run: false, limit: 80,
  });
  if (search.status >= 400) {
    return new Response(JSON.stringify({ ok: false, step: "search", search }, null, 2), { status: 200 });
  }
  const jobId = search.json?.data?.job_id;

  // wait briefly for sources to land
  await new Promise((r) => setTimeout(r, 1500));

  // Count current rows for the comune (post-search, pre-enrichment)
  const { data: postSearchRows } = await supabase.from("b2b_companies")
    .select("id,phone").eq("comune", comune);
  const postSearchTotal = postSearchRows?.length ?? 0;
  const postSearchPhone = (postSearchRows ?? []).filter((r: any) => r.phone).length;

  // 2) Start enrichment job using job_id
  const enrich = await callFn("/b2b-finder-enrich", {
    action: "start_enrichment_job",
    job_id: jobId,
    mode: "smart",
    limit: 50,
    max_cost_eur: 0.4,
  });

  return new Response(JSON.stringify({
    ok: true,
    comune,
    pre: { total: preTotal, with_phone: prePhone },
    post_search: { total: postSearchTotal, with_phone: postSearchPhone, job_id: jobId, search_summary: search.json?.data?.summary ?? null },
    enrichment_started: enrich.json,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
