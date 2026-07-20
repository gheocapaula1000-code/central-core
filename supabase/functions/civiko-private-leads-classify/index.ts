// civiko-private-leads-classify
// Downstream del pull notturno Subito (civiko-private-leads-nightly).
//
// Legge gli ultimi annunci da padova_subito_staging (default: ultime 36 ore,
// override via body.since_hours), filtra i soli annunci di privati
// (advertiser_company === false), estrae i campi normalizzati, classifica
// ciascun lead come "privato" o "privato_stanco" (>=60 giorni di anzianità o
// ribasso cumulato >=5%) e fa upsert in padova_listings su (fonte, url).
//
// Aggiorna anche private_leads_run_status (riga 'subito') con i conteggi reali
// così la sezione fonti notturne del cron-health mostra "X opportunità trovate,
// Y privato_stanco" subito dopo l'esecuzione.
//
// Schedulato ogni notte alle 02:50 UTC via pg_cron (25 min dopo il pull Subito).

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyPrivateLead } from "../_shared/leadClassification.ts";

type Json = Record<string, unknown>;

function n(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const v = parseFloat(m);
  return isFinite(v) ? Math.round(v) : null;
}

function pickUrl(r: Json): string | null {
  const u = (r["urls_default"] ?? r["urls_mobile"]) as string | undefined;
  if (!u) return null;
  return String(u).split("?")[0].split("#")[0].trim() || null;
}

function pickIndirizzo(r: Json): string | null {
  const town = (r["geo_town_value"] ?? r["geo_city_value"]) as string | undefined;
  return town ? String(town) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!jobSecret || req.headers.get("x-job-secret") !== jobSecret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const started = Date.now();
  let sinceHours = 36;
  let sourceRunId: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.since_hours === "number" && body.since_hours > 0) sinceHours = body.since_hours;
    if (typeof body?.source_run_id === "string" && body.source_run_id.trim()) {
      sourceRunId = body.source_run_id.trim();
    }
  } catch { /* body opzionale */ }

  const sinceIso = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  // Estrai staging con paginazione
  const rows: Array<{ id: number; raw_json: Json; fetched_at: string }> = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb
      .from("padova_subito_staging")
      .select("id, raw_json, fetched_at")
      .gte("fetched_at", sinceIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as Array<{ id: number; raw_json: Json; fetched_at: string }>));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Skip se nessuno staging recente: NON registrare "classified" ma "skipped_no_data"
  if (rows.length === 0) {
    await sb.from("private_leads_run_status").insert({
      source: "subito",
      opportunita_totali: 0,
      privato_stanco_count: 0,
      status: "skipped_no_data",
      error_message: null,
      duration_ms: Date.now() - started,
      notes: {
        since_hours: sinceHours,
        source_run_id: sourceRunId,
        reason: "no_recent_subito_staging",
      },
    });
    return new Response(JSON.stringify({
      ok: true, skipped: true, reason: "no_recent_subito_staging",
      since_iso: sinceIso, source_run_id: sourceRunId,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let totale_staging = rows.length;
  let scartati_agenzia = 0;
  let scartati_no_url = 0;
  let scartati_no_padova = 0;
  let upserted = 0;
  let n_privato = 0;
  let n_privato_stanco = 0;
  const errors: string[] = [];

  // Dedup per url all'interno del batch (più annunci stesso urn): tieni il più recente
  const byUrl = new Map<string, { raw: Json; fetched_at: string }>();
  for (const r of rows) {
    const raw = r.raw_json ?? {};
    if (raw["advertiser_company"] !== false) { scartati_agenzia++; continue; }
    const url = pickUrl(raw);
    if (!url) { scartati_no_url++; continue; }
    // Solo annunci provincia Padova (geo_city_istat = "028")
    if (raw["geo_city_istat"] && String(raw["geo_city_istat"]) !== "028") { scartati_no_padova++; continue; }
    const prev = byUrl.get(url);
    if (!prev || prev.fetched_at < r.fetched_at) byUrl.set(url, { raw, fetched_at: r.fetched_at });
  }

  // Upsert a batch di 200
  const records: Array<Record<string, unknown>> = [];
  for (const [url, { raw }] of byUrl) {
    const datePub = raw["date"] ? String(raw["date"]).replace(" ", "T") + "Z" : null;
    const prezzo = n(raw["features_price_values"]);
    const mq = n(raw["features_size_values"]);
    const locali = n(raw["features_room_values"]);
    const bagni = n(raw["features_bathrooms_values"]);
    const telefono = raw["phone_number"] ? String(raw["phone_number"]) : null;

    const cls = classifyPrivateLead({
      firstSeenAt: datePub,
      isPrivato: true,
      prezzoAttuale: prezzo ?? null,
      prezzoOriginale: null,
    });

    if (cls.tipo_lead === "privato_stanco") n_privato_stanco++; else n_privato++;

    records.push({
      fonte: "subito",
      url,
      agency: null,
      tipo_lead: cls.tipo_lead,
      telefono,
      mq,
      locali,
      bagni,
      prezzo,
      lat: null,
      lng: null,
      indirizzo: pickIndirizzo(raw),
      quartiere: null,
      raw_json: { ...raw, _classification: cls },
    });
  }

  for (let i = 0; i < records.length; i += 200) {
    const slice = records.slice(i, i + 200);
    const { error } = await sb
      .from("padova_listings")
      .upsert(slice, { onConflict: "fonte,url", ignoreDuplicates: false });
    if (error) {
      errors.push(error.message);
    } else {
      upserted += slice.length;
    }
  }

  // Aggiorna lo stato run più recente di subito con i conteggi reali
  const totale_privati = n_privato + n_privato_stanco;
  await sb.from("private_leads_run_status").insert({
    source: "subito",
    opportunita_totali: totale_privati,
    privato_stanco_count: n_privato_stanco,
    status: errors.length ? "classified_with_errors" : "classified",
    error_message: errors.length ? errors.slice(0, 3).join(" | ").slice(0, 500) : null,
    duration_ms: Date.now() - started,
    notes: {
      since_hours: sinceHours,
      source_run_id: sourceRunId,
      totale_staging,
      scartati_agenzia,
      scartati_no_url,
      scartati_no_padova,
      upserted,
      privato: n_privato,
      privato_stanco: n_privato_stanco,
    },
  });

  return new Response(JSON.stringify({
    ok: true,
    duration_ms: Date.now() - started,
    since_iso: sinceIso,
    totale_staging,
    scartati_agenzia,
    scartati_no_url,
    scartati_no_padova,
    privati_unici: byUrl.size,
    upserted,
    privato: n_privato,
    privato_stanco: n_privato_stanco,
    errors,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
