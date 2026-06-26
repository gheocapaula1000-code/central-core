// Temporary test harness for b2b-finder-enrich v0.4. Removed after test.
Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SECRET = Deno.env.get("B2B_FINDER_SECRET")!;
  const base = `${SUPABASE_URL}/functions/v1/b2b-finder-enrich`;
  const call = async (body: unknown) => {
    const r = await fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-source-app": "b2b-finder",
        "x-internal-secret": SECRET,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(()=>null) };
  };

  const body = await req.json().catch(() => ({}));
  if (body.op === "start") {
    return new Response(JSON.stringify(await call({
      action: "start_enrichment_job",
      job_id: "abb01242-40b0-41c2-ae4b-8fd898a12147",
      mode: body.mode ?? "smart",
      limit: body.limit ?? 20,
      max_cost_eur: body.max_cost_eur ?? 0.5,
    })), { headers: { "Content-Type": "application/json" } });
  }
  if (body.op === "progress") {
    return new Response(JSON.stringify(await call({
      action: "get_enrichment_progress",
      enrichment_job_id: body.id,
    })), { headers: { "Content-Type": "application/json" } });
  }
  if (body.op === "cancel") {
    return new Response(JSON.stringify(await call({
      action: "cancel_enrichment_job",
      enrichment_job_id: body.id,
    })), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "unknown op" }), { status: 400 });
});
