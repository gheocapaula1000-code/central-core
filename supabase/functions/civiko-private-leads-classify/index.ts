// civiko-private-leads-classify
// Downstream del pull notturno Subito (civiko-private-leads-nightly).
//
// Legge gli ultimi annunci da padova_subito_staging (default: ultime 36 ore,
// override via body.since_hours), filtra i soli annunci di privati
// (advertiser_company === false), estrae i campi normalizzati, classifica
// ciascun lead come "privato" o "privato_stanco" (>=60 giorni di anzianità o
// ribasso cumulato >=5%) e fa upsert in padova_listings su (fonte, url).
//
// Zonizzazione: SOLO per i lead con comune normalizzato === "padova"
// invoca resolvePadovaOmiBatch e mappa il codice OMI ottenuto sulla zona
// commerciale reale (civiko_commercial_zones.omi_codes @> [code]). Le fonti
// che non dichiarano esplicitamente Padova città sono scartate fail-closed.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyPrivateLead } from "../_shared/leadClassification.ts";
import {
  resolvePadovaOmiBatch,
  UNRESOLVED_OMI_CODE,
} from "../_shared/padovaOmiResolver.ts";

type Json = Record<string, unknown>;

function n(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const v = parseFloat(m);
  return isFinite(v) ? Math.round(v) : null;
}

/** Parsing sicuro di lat/lng (accetta stringhe con virgola, ritorna null se non valido). */
export function safeFloat(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return isFinite(s) ? s : null;
  const raw = String(s).trim().replace(",", ".");
  if (!raw) return null;
  const v = parseFloat(raw);
  return isFinite(v) ? v : null;
}

/** Normalizza il nome del comune: trim, lowercase, no accenti, no doppi spazi. */
export function normalizeComune(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function pickUrl(r: Json): string | null {
  const u = (r["urls_default"] ?? r["urls_mobile"]) as string | undefined;
  if (!u) return null;
  return String(u).split("?")[0].split("#")[0].trim() || null;
}

function pickComune(raw: Json): string | null {
  const t = raw["geo_town_value"] ?? raw["geo_city_value"];
  const s = t ? String(t).trim() : "";
  return s || null;
}

function pickIndirizzo(raw: Json): string | null {
  const addr = raw["geo_map_address"];
  if (addr && String(addr).trim()) return String(addr).trim();
  return pickComune(raw);
}

function pickCap(raw: Json): string | null {
  const direct = raw["geo_zip"] ?? raw["cap"] ?? raw["zip"];
  if (direct) {
    const s = String(direct).replace(/\D/g, "");
    if (s.length === 5) return s;
  }
  const addr = String(raw["geo_map_address"] ?? "");
  const m = addr.match(/\b(351\d{2})\b/);
  return m ? m[1] : null;
}

/** Mappa un codice OMI valido su una zona commerciale attiva. */
function mapOmiToZone(
  omi: string,
  zones: Array<{ slug: string; nome: string; omi_codes: string[] | null }>,
): { slug: string; nome: string } | null {
  const code = omi.trim().toUpperCase();
  for (const z of zones) {
    const codes = (z.omi_codes ?? []).map((c) => String(c).trim().toUpperCase());
    if (codes.includes(code)) return { slug: z.slug, nome: z.nome };
  }
  return null;
}

/** Traduce la reason del resolver in un metodo compatto e stabile. */
export function reasonToMethod(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (r === "point_in_polygon") return "point_in_polygon";
  if (r === "precomputed_omi") return "precomputed_omi";
  if (r === "alias_match") return "alias";
  if (r.startsWith("cap_hint")) return "cap_hint";
  return "unresolved";
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
  let scartati_no_padova_provincia = 0;
  let scartati_no_padova_citta = 0;
  let upserted = 0;
  let n_privato = 0;
  let n_privato_stanco = 0;
  let n_padova_citta = 0;
  let n_zonizzati = 0;
  let n_unresolved = 0;
  const errors: string[] = [];

  // Dedup per url all'interno del batch
  const byUrl = new Map<string, { raw: Json; fetched_at: string }>();
  for (const r of rows) {
    const raw = r.raw_json ?? {};
    if (raw["advertiser_company"] !== false) { scartati_agenzia++; continue; }
    const url = pickUrl(raw);
    if (!url) { scartati_no_url++; continue; }
    // Solo annunci provincia Padova
    if (raw["geo_city_istat"] && String(raw["geo_city_istat"]) !== "028") {
      scartati_no_padova_provincia++; continue;
    }
    const prev = byUrl.get(url);
    if (!prev || prev.fetched_at < r.fetched_at) byUrl.set(url, { raw, fetched_at: r.fetched_at });
  }

  // Costruisci i record base (senza zonizzazione) + traccia quali sono Padova città
  type BaseRec = {
    url: string;
    raw: Json;
    prezzo: number | null;
    mq: number | null;
    locali: number | null;
    bagni: number | null;
    telefono: string | null;
    tipo_lead: "privato" | "privato_stanco";
    comune: string | null;
    indirizzo: string | null;
    lat: number | null;
    lng: number | null;
    cap: string | null;
    title: string | null;
    body: string | null;
    isPadova: boolean;
    comuneKnown: boolean;
  };


  const base: BaseRec[] = [];
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

    const comune = pickComune(raw);
    const isPadova = normalizeComune(comune) === "padova";
    const comuneKnown = !!comune && comune.trim() !== "";
    if (isPadova) n_padova_citta++;

    base.push({
      url, raw, prezzo, mq, locali, bagni, telefono,
      tipo_lead: cls.tipo_lead as "privato" | "privato_stanco",
      comune,
      indirizzo: pickIndirizzo(raw),
      lat: safeFloat(raw["geo_map_latitude"]),
      lng: safeFloat(raw["geo_map_longitude"]),
      cap: pickCap(raw),
      title: (raw["subject"] ?? raw["title"]) ? String(raw["subject"] ?? raw["title"]) : null,
      body: (raw["body"] ?? raw["description"]) ? String(raw["body"] ?? raw["description"]) : null,
      isPadova,
      comuneKnown,
    });
  }

  // Perimetro definitivo: la fonte più recente deve dichiarare Padova città.
  // Coordinate/PIP non possono promuovere un comune mancante o diverso.
  const basePadova = base.filter((b) => b.isPadova);
  scartati_no_padova_citta = base.length - basePadova.length;
  n_privato = basePadova.filter((b) => b.tipo_lead === "privato").length;
  n_privato_stanco = basePadova.filter((b) => b.tipo_lead === "privato_stanco").length;
  n_padova_citta = basePadova.length;
  const resolvableRecs = basePadova;

  // Carica UNA sola volta le zone commerciali attive
  let zones: Array<{ slug: string; nome: string; omi_codes: string[] | null }> = [];
  if (resolvableRecs.length > 0) {
    const { data: zData, error: zErr } = await sb
      .from("civiko_commercial_zones")
      .select("slug, nome, omi_codes, attiva")
      .eq("attiva", true);
    if (zErr) {
      errors.push(`zones_load: ${zErr.message}`);
    } else {
      zones = ((zData ?? []) as Array<Record<string, unknown>>).map((z) => ({
        slug: String(z.slug ?? ""),
        nome: String(z.nome ?? ""),
        omi_codes: Array.isArray(z.omi_codes) ? (z.omi_codes as string[]) : null,
      }));
    }
  }

  // Prepara input per il resolver
  const resolverInput = resolvableRecs.map((r) => ({
    lat: r.lat, lng: r.lng,
    indirizzo: r.indirizzo,
    address: r.indirizzo,
    title: r.title,
    description: r.body,
    quartiere: null,
    cap: r.cap,
    zip: r.cap,
  }));

  const resolutions = resolvableRecs.length > 0
    ? await resolvePadovaOmiBatch(
        resolverInput as unknown as Array<Record<string, unknown>>,
        sb as unknown as {
          rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
        },
        (rr) => ({
          lat: (rr as Record<string, unknown>).lat as number | null,
          lng: (rr as Record<string, unknown>).lng as number | null,
        }),
      )
    : [];

  // Mappa risoluzione → record base
  type ZoneAssignment = {
    comune: string | null;
    omi_zone: string | null;
    commercial_zone_slug: string | null;
    quartiere: string | null;
    method: string;
    confidence: number | null;
    resolved_at: string;
  };
  const zoneByUrl = new Map<string, ZoneAssignment>();
  const nowIso = new Date().toISOString();
  const MIN_CONF = 0.70;
  const STRONG_METHODS = new Set(["point_in_polygon", "precomputed_omi", "alias"]);

  for (let i = 0; i < resolvableRecs.length; i++) {
    const rec = resolvableRecs[i];
    const res = resolutions[i];
    const method = reasonToMethod(res?.omi_zone_reason);
    const confidence = typeof res?.omi_zone_confidence === "number" ? res.omi_zone_confidence : null;
    const validCode = res?.omi_zone_code && res.omi_zone_code !== UNRESOLVED_OMI_CODE
      ? res.omi_zone_code
      : null;

    // Assign commercial zone only when strong method + confidence >= 0.70 + code active.
    if (validCode && STRONG_METHODS.has(method) && confidence !== null && confidence >= MIN_CONF) {
      const zoneHit = mapOmiToZone(validCode, zones);
      if (zoneHit) {
        n_zonizzati++;
        zoneByUrl.set(rec.url, {
          comune: "Padova",
          omi_zone: validCode,
          commercial_zone_slug: zoneHit.slug,
          quartiere: zoneHit.nome,
          method, confidence, resolved_at: nowIso,
        });
        continue;
      }
    }
    // cap_hint (or below-threshold / no-mapping): keep method+confidence but no slug/quartiere/omi_zone.
    if (method === "cap_hint") {
      zoneByUrl.set(rec.url, {
        comune: rec.isPadova ? "Padova" : rec.comune,
        omi_zone: null, commercial_zone_slug: null, quartiere: null,
        method: "cap_hint", confidence, resolved_at: nowIso,
      });
      continue;
    }
    n_unresolved++;
    zoneByUrl.set(rec.url, {
      comune: rec.isPadova ? "Padova" : rec.comune,
      omi_zone: null, commercial_zone_slug: null, quartiere: null,
      method: "unresolved", confidence: null, resolved_at: nowIso,
    });
  }


  // Costruisci record finali per upsert
  const records: Array<Record<string, unknown>> = basePadova.map((b) => {
    const z = zoneByUrl.get(b.url);
    const zoneFields = z
      ? {
          comune: z.comune,
          omi_zone: z.omi_zone,
          commercial_zone_slug: z.commercial_zone_slug,
          quartiere: z.quartiere,
          zone_match_method: z.method,
          zone_match_confidence: z.confidence,
          zone_resolved_at: z.resolved_at,
        }
      : {
          comune: b.comune,
          omi_zone: null,
          commercial_zone_slug: null,
          quartiere: null,
          zone_match_method: null,
          zone_match_confidence: null,
          zone_resolved_at: null,
        };


    return {
      fonte: "subito",
      url: b.url,
      agency: null,
      tipo_lead: b.tipo_lead,
      telefono: b.telefono,
      mq: b.mq,
      locali: b.locali,
      bagni: b.bagni,
      prezzo: b.prezzo,
      lat: b.lat,
      lng: b.lng,
      indirizzo: b.indirizzo,
      raw_json: { ...b.raw, _classification: { tipo_lead: b.tipo_lead } },
      ...zoneFields,
    };
  });

  for (let i = 0; i < records.length; i += 200) {
    const slice = records.slice(i, i + 200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.from("padova_listings") as any)
      .upsert(slice, { onConflict: "fonte,url", ignoreDuplicates: false });
    if (error) {
      errors.push(error.message);
    } else {
      upserted += slice.length;
    }
  }

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
      scartati_no_padova: scartati_no_padova_provincia,
      scartati_no_padova_citta,
      upserted,
      privato: n_privato,
      privato_stanco: n_privato_stanco,
      padova_citta: n_padova_citta,
      zonizzati: n_zonizzati,
      zone_unresolved: n_unresolved,
    },
  });

  return new Response(JSON.stringify({
    ok: true,
    duration_ms: Date.now() - started,
    since_iso: sinceIso,
    totale_staging,
    scartati_agenzia,
    scartati_no_url,
    scartati_no_padova_provincia,
    privati_unici: byUrl.size,
    padova_citta: n_padova_citta,
    zonizzati: n_zonizzati,
    zone_unresolved: n_unresolved,
    upserted,
    privato: n_privato,
    privato_stanco: n_privato_stanco,
    errors,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
