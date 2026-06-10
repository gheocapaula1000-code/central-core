// padova-immobiliare-detail-import
// Scarica dataset Apify immobiliare detail-by-url, stage in
// padova_immobiliare_detail_staging, poi UPDATE padova_listings via RPC SQL.
// Auth: admin JWT.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function s(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

interface MainFeature { type?: string; label?: string; compactLabel?: string }

function parseItem(it: Record<string, unknown>, runId: string) {
  const url = s(it.input_url) ?? s(it.url);
  const advertiser = (it.advertiser ?? {}) as Record<string, unknown>;
  const agencyObj = (advertiser.agency ?? {}) as Record<string, unknown>;
  const agency = s(agencyObj.displayName) ?? s(agencyObj.name);
  const advType = s(agencyObj.type) ?? s(advertiser.type);
  let tipo_lead: string | null = null;
  if (agency) tipo_lead = "AGENZIA";
  else if (advType && /priv/i.test(advType)) tipo_lead = "PRIVATO";
  else if (Object.keys(advertiser).length > 0 && !agency) tipo_lead = "PRIVATO";

  const props = (it.properties as Record<string, unknown>[]) ?? [];
  const main = (props[0] ?? {}) as Record<string, unknown>;
  const loc = (main.location ?? {}) as Record<string, unknown>;
  const lat = num(loc.latitude);
  const lng = num(loc.longitude);
  const addrParts = [s(loc.address), s(loc.microzone), s(loc.city)].filter(Boolean);
  const indirizzo = addrParts.length ? addrParts.join(", ") : null;

  const price = (it.price ?? main.price ?? {}) as Record<string, unknown>;
  const prezzo = num(price.value);

  const mf = (main.mainFeatures ?? []) as MainFeature[];
  const find = (t: string) => mf.find((f) => f.type === t);
  const mq = num(find("surface")?.label ?? main.surface);
  const locali = num(find("rooms")?.compactLabel ?? find("rooms")?.label ?? main.rooms ?? main.bedRoomsNumber);
  const bagni = num(find("bathrooms")?.compactLabel ?? find("bathrooms")?.label ?? main.bathrooms);

  return { run_id: runId, url, agency, tipo_lead, mq, locali, bagni, prezzo, lat, lng, indirizzo };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return new Response(JSON.stringify({ ok: false, error: "missing_jwt" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const sbUser = createClient(sbUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: u } = await sbUser.auth.getUser();
  if (!u?.user) return new Response(JSON.stringify({ ok: false, error: "invalid_jwt" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const sb = createClient(sbUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", u.user.id);
  if (!(roles ?? []).some((r: { role: string }) => r.role === "admin"))
    return new Response(JSON.stringify({ ok: false, error: "not_admin" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const token = getApifyToken();
  if (!token) return new Response(JSON.stringify({ ok: false, error: "apify_token_missing" }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const url = new URL(req.url);
  const datasetId = url.searchParams.get("dataset_id") ?? "RNEK8yjTrRoPkqaNq";
  const runId = url.searchParams.get("run_id") ?? "UeRxNkDY2equWlK20";

  const rr = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  const runJson = await rr.json();
  const runData = runJson?.data ?? {};
  const cost = Number(runData.usageTotalUsd ?? 0);
  const status = runData.status;
  const reqFinished = runData.stats?.requestsFinished;
  const reqTotal = runData.stats?.requestsTotal;

  // Fetch all items
  const items: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&offset=${offset}&limit=1000&token=${encodeURIComponent(token)}`);
    if (!r.ok) { await r.body?.cancel(); break; }
    const j = await r.json();
    if (!Array.isArray(j) || j.length === 0) break;
    items.push(...j);
    if (j.length < 1000) break;
    offset += 1000;
  }

  const mapped = items.map((it) => parseItem(it, runId)).filter((x) => !!x.url);

  // Clear prior staging for this run, then bulk insert
  await sb.from("padova_immobiliare_detail_staging").delete().eq("run_id", runId);
  for (let i = 0; i < mapped.length; i += 500) {
    await sb.from("padova_immobiliare_detail_staging").insert(mapped.slice(i, i + 500));
  }

  // Run UPDATE via SQL function. Use rpc if exists, else fallback through direct SQL using PostgREST is impossible.
  // Use rpc 'exec_sql' if available — instead, do per-row UPDATE here through PostgREST UPDATEs grouped.
  // Group by URL → patch
  let updated = 0;
  for (const row of mapped) {
    const patch: Record<string, unknown> = {};
    if (row.agency) patch.agency = row.agency;
    if (row.tipo_lead) patch.tipo_lead = row.tipo_lead;
    if (row.mq != null) patch.mq = row.mq;
    if (row.locali != null) patch.locali = row.locali;
    if (row.bagni != null) patch.bagni = row.bagni;
    if (row.prezzo != null) patch.prezzo = row.prezzo;
    if (row.lat != null) patch.lat = row.lat;
    if (row.lng != null) patch.lng = row.lng;
    if (row.indirizzo) patch.indirizzo = row.indirizzo;
    if (Object.keys(patch).length === 0) continue;
    // Only set numeric fields if currently null (COALESCE semantics): do two updates? Simpler:
    // do agency/tipo_lead unconditionally, then a second update for nulls only via .is('mq', null)
    const { data: upd1 } = await sb.from("padova_listings")
      .update({ agency: patch.agency, tipo_lead: patch.tipo_lead })
      .eq("fonte", "immobiliare").eq("url", row.url!)
      .select("id");
    if (!upd1 || upd1.length === 0) continue;
    updated += upd1.length;
    // Coalesce numeric/text fields
    const numericFields: Array<keyof typeof patch> = ["mq", "locali", "bagni", "prezzo", "lat", "lng", "indirizzo"];
    for (const f of numericFields) {
      if (patch[f] == null) continue;
      await sb.from("padova_listings")
        .update({ [f]: patch[f] })
        .eq("fonte", "immobiliare").eq("url", row.url!)
        .is(f as string, null);
    }
  }

  await sb.from("padova_apify_runs").update({
    status, cost_usd: cost, items_count: items.length, imported: updated,
    finished_at: new Date().toISOString(),
  }).eq("run_id", runId);

  // Verify
  const { count: placeholder } = await sb.from("padova_listings").select("*", { count: "exact", head: true }).eq("fonte", "immobiliare").eq("agency", "Agenzie");
  const { count: reali } = await sb.from("padova_listings").select("*", { count: "exact", head: true }).eq("fonte", "immobiliare").neq("agency", "Agenzie").not("agency", "is", null);
  const { data: distinctAgencies } = await sb.from("padova_listings").select("agency").eq("fonte", "immobiliare").neq("agency", "Agenzie").not("agency", "is", null);
  const distinct = new Set((distinctAgencies ?? []).map((r: { agency: string }) => r.agency)).size;
  const { count: privato } = await sb.from("padova_listings").select("*", { count: "exact", head: true }).eq("fonte", "immobiliare").eq("tipo_lead", "PRIVATO");

  return new Response(JSON.stringify({
    ok: true,
    run_status: status,
    requests_finished: reqFinished,
    requests_total: reqTotal,
    cost_usd_run: cost,
    items_in_dataset: items.length,
    mapped_with_url: mapped.length,
    rows_updated: updated,
    verifica: {
      ancora_placeholder: placeholder ?? 0,
      agency_reali: reali ?? 0,
      agenzie_distinte: distinct,
      privato_immobiliare: privato ?? 0,
    },
    sample_mapped: mapped.slice(0, 5),
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
