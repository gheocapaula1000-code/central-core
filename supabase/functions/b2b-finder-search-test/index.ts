// Temporary internal test runner for b2b-finder-search.
// Calls /b2b-finder-search dry_run for a list of comuni and returns
// compact diagnostics for the geographic scope fix.

const FN_BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "") + "/functions/v1";
const SECRET = Deno.env.get("B2B_FINDER_SECRET") ?? "";

async function callSearch(city: string, limit = 50) {
  const r = await fetch(`${FN_BASE}/b2b-finder-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": SECRET,
      "x-source-app": "b2b-finder",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({
      mode: "buyers",
      product: "Coprimacchia TNT Colorati 100x100 cm",
      province: "PD",
      city,
      limit,
      dry_run: true,
    }),
  });
  const json: any = await r.json().catch(() => null);
  const d = json?.data ?? {};
  const results: any[] = Array.isArray(d.results) ? d.results : [];
  const matchCity = (rc: string) =>
    String(rc ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = matchCity(city);
  const inRequested = results.filter((x) => matchCity(x.result_city) === wanted).length;
  const outOfScope = results.filter((x) => x.in_scope === false).length;
  return {
    city,
    http_status: r.status,
    requested_city: d.requested_city ?? null,
    resolved_scope_key: d.resolved_scope_key ?? null,
    bbox_geographic_scope: d.geographic_scope ?? null,
    raw_count: d.raw_count ?? null,
    filtered_out_of_zone_count: d.filtered_out_of_zone_count ?? null,
    total_found: d.total_found ?? 0,
    sample_count: results.length,
    in_requested_city: inRequested,
    out_of_scope_count: outOfScope,
    first_10: results.slice(0, 10).map((x) => ({
      name: x.name,
      result_city: x.result_city,
      in_scope: x.in_scope,
      geo_match_reason: x.geo_match_reason,
      distance_km: x.distance_from_scope_center_km,
      lat: x.lat,
      lng: x.lng,
    })),
    error: json?.error ?? null,
  };
}

Deno.serve(async () => {
  const cities = ["Padova", "Vigonza", "Albignasego", "Rubano", "Ponte San Nicolò"];
  const out: any[] = [];
  for (const c of cities) {
    try {
      out.push(await callSearch(c, 50));
    } catch (e) {
      out.push({ city: c, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Overlap check: are Vigonza/Albignasego returning identical first names as Padova?
  const byCity = Object.fromEntries(out.map((r) => [r.city, new Set((r.first_10 ?? []).map((x: any) => x.name))]));
  const padovaSet: Set<string> = byCity["Padova"] ?? new Set();
  const overlap = (k: string) => {
    const s: Set<string> = byCity[k] ?? new Set();
    let n = 0;
    for (const x of s) if (padovaSet.has(x)) n++;
    return { city: k, top10_overlap_with_padova: n, top10_total: s.size };
  };
  return new Response(JSON.stringify({
    ok: true,
    tests: out,
    overlap_check: ["Vigonza", "Albignasego", "Rubano", "Ponte San Nicolò"].map(overlap),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
