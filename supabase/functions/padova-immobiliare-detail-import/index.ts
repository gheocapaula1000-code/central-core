// padova-immobiliare-detail-import
// Scarica dataset Apify immobiliare detail-by-url e fa UPDATE su padova_listings
// per fonte='immobiliare' match per url. NON inserisce righe nuove.
// Auth: admin JWT.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getApifyToken } from "../_shared/apify.ts";

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function s(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}
function pick(o: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function extractAgency(it: Record<string, unknown>): string | null {
  // Try many possible shapes
  const candidates: unknown[] = [
    pick(it, "agencyName", "agency_name", "agency"),
    pick(it as Record<string, unknown>, "advertiserName"),
  ];
  const adv = (it.advertiser ?? it.agency ?? it.agente) as Record<string, unknown> | undefined;
  if (adv && typeof adv === "object") {
    candidates.push(pick(adv, "displayName", "name", "label", "commercialName", "agencyName"));
    const agency = adv.agency as Record<string, unknown> | undefined;
    if (agency && typeof agency === "object") {
      candidates.push(pick(agency, "displayName", "name", "label"));
    }
    const supplier = adv.supplier as Record<string, unknown> | undefined;
    if (supplier && typeof supplier === "object") {
      candidates.push(pick(supplier, "displayName", "name", "label"));
    }
  }
  const realEstate = it.realEstateAgency as Record<string, unknown> | undefined;
  if (realEstate) candidates.push(pick(realEstate, "displayName", "name", "label"));
  const seller = it.seller as Record<string, unknown> | undefined;
  if (seller) candidates.push(pick(seller, "displayName", "name", "label"));
  for (const c of candidates) {
    const v = s(c);
    if (v && v.toLowerCase() !== "agenzie" && v.length <= 200) return v;
  }
  return null;
}

function isPrivate(it: Record<string, unknown>): boolean | null {
  const adv = (it.advertiser ?? {}) as Record<string, unknown>;
  const flags = [adv.private, adv.isPrivate, it.isPrivate, it.private];
  for (const f of flags) {
    if (typeof f === "boolean") return f;
  }
  const type = s(pick(adv, "type", "agentType")) ?? s(pick(it, "advertiserType"));
  if (type) {
    if (/priv/i.test(type)) return true;
    if (/agen|profess/i.test(type)) return false;
  }
  return null;
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

  // Run info (cost)
  const rr = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
  const runJson = await rr.json();
  const runData = runJson?.data ?? {};
  const cost = Number(runData.usageTotalUsd ?? 0);
  const status = runData.status;
  const reqFinished = runData.stats?.requestsFinished;
  const reqTotal = runData.stats?.requestsTotal;

  // Fetch dataset (pagination)
  const items: Record<string, unknown>[] = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&offset=${offset}&limit=${pageSize}&token=${encodeURIComponent(token)}`);
    if (!r.ok) { await r.body?.cancel(); break; }
    const j = await r.json();
    if (!Array.isArray(j) || j.length === 0) break;
    items.push(...j);
    if (j.length < pageSize) break;
    offset += pageSize;
    if (items.length > 10000) break;
  }

  // Map → staging objects
  const mapped = items.map((it) => {
    const properties = (it.properties as Record<string, unknown>[]) ?? null;
    const main: Record<string, unknown> = (Array.isArray(properties) && properties[0]) ? properties[0] : it;
    const location = (main.location ?? it.location ?? {}) as Record<string, unknown>;
    const price = (main.price ?? it.price ?? {}) as Record<string, unknown>;
    const features = (main.features ?? it.features ?? {}) as Record<string, unknown>;
    const agency = extractAgency(it) ?? extractAgency(main);
    const priv = isPrivate(it);
    const tipo = agency ? "AGENZIA" : (priv === true ? "PRIVATO" : (priv === false ? "AGENZIA" : null));
    const urlVal = s(it.url) ?? s(main.url) ?? s((it as Record<string, unknown>).detailUrl) ?? s((main as Record<string, unknown>).seoUrl);
    const mq = num(pick(features, "surface", "size") ?? pick(main, "surface", "size") ?? pick(it, "surface", "size"));
    const locali = num(pick(features, "rooms", "roomsNumber") ?? pick(main, "rooms"));
    const bagni = num(pick(features, "bathrooms") ?? pick(main, "bathrooms"));
    const prezzo = num(pick(price, "value", "amount") ?? pick(main, "price") ?? pick(it, "price"));
    const lat = num(location.latitude ?? location.lat);
    const lng = num(location.longitude ?? location.lng ?? location.lon);
    const indirizzo = s(location.address ?? location.normalizedAddress ?? location.street);
    return { url: urlVal, agency, tipo_lead: tipo, mq, locali, bagni, prezzo, lat, lng, indirizzo };
  }).filter((x) => !!x.url);

  // UPDATE in chunks via a transient table approach: use a temp staging via upsert into a junk table is heavy.
  // Instead, do per-row UPDATEs in batches with PostgREST.
  let updated = 0;
  for (const row of mapped) {
    const patch: Record<string, unknown> = {};
    if (row.agency) patch.agency = row.agency;
    if (row.tipo_lead) patch.tipo_lead = row.tipo_lead;
    // Coalesce-style: only set if currently null
    const { data: existing } = await sb.from("padova_listings")
      .select("id,mq,locali,bagni,prezzo,lat,lng,indirizzo")
      .eq("fonte", "immobiliare").eq("url", row.url!).maybeSingle();
    if (!existing) continue;
    if (existing.mq == null && row.mq != null) patch.mq = row.mq;
    if (existing.locali == null && row.locali != null) patch.locali = row.locali;
    if (existing.bagni == null && row.bagni != null) patch.bagni = row.bagni;
    if (existing.prezzo == null && row.prezzo != null) patch.prezzo = row.prezzo;
    if (existing.lat == null && row.lat != null) patch.lat = row.lat;
    if (existing.lng == null && row.lng != null) patch.lng = row.lng;
    if (existing.indirizzo == null && row.indirizzo) patch.indirizzo = row.indirizzo;
    if (Object.keys(patch).length === 0) continue;
    const { error } = await sb.from("padova_listings").update(patch).eq("id", existing.id);
    if (!error) updated++;
  }

  await sb.from("padova_apify_runs").update({
    status, cost_usd: cost, items_count: items.length, imported: updated,
    finished_at: new Date().toISOString(),
  }).eq("run_id", runId);

  // Verify
  const { data: verify } = await sb.rpc("exec_dummy_noop").select().limit(0).then(() => ({ data: null })).catch(() => ({ data: null }));
  void verify;
  const { count: placeholder } = await sb.from("padova_listings").select("*", { count: "exact", head: true }).eq("fonte", "immobiliare").eq("agency", "Agenzie");
  const { count: reali } = await sb.from("padova_listings").select("*", { count: "exact", head: true }).eq("fonte", "immobiliare").neq("agency", "Agenzie").not("agency", "is", null);
  const { data: distinctAgencies } = await sb.from("padova_listings").select("agency").eq("fonte", "immobiliare").neq("agency", "Agenzie").not("agency", "is", null);
  const distinct = new Set((distinctAgencies ?? []).map((r: { agency: string }) => r.agency)).size;

  return new Response(JSON.stringify({
    ok: true,
    run_status: status,
    requests_finished: reqFinished,
    requests_total: reqTotal,
    cost_usd: cost,
    items_in_dataset: items.length,
    mapped_with_url: mapped.length,
    rows_updated: updated,
    verify: {
      ancora_placeholder: placeholder ?? 0,
      agency_reali: reali ?? 0,
      agenzie_distinte: distinct,
    },
    sample_items: items.slice(0, 2),
    sample_mapped: mapped.slice(0, 3),
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
