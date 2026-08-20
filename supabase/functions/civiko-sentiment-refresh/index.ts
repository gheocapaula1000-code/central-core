// civiko-sentiment-refresh
// Recomputes Padova commercial-zone microzone_sentiment from real DB inputs.
// Missing inputs → quality parziale / null scores. Never fabricates.

import { createClient } from "npm:@supabase/supabase-js@2";
import { isJobSecretAuthorized, jobAuthFailure } from "../_shared/jobAuth.ts";
import {
  OFFICIAL_ZONE_SLUGS,
  averageNumeric,
  computeZoneSentiment,
  hasZoneScopedSentimentInput,
  inferZoneFromText,
  type SentimentAxisInput,
} from "../_shared/padovaUrbanLayers.ts";
import { commercialZoneForQuartiere } from "../_shared/civikoCommercialZoneByQuartiere.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const jobSecret = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!isJobSecretAuthorized(req.headers, jobSecret)) {
    const auth = jobAuthFailure(Boolean(jobSecret));
    return json(auth.status, { ok: false, error: auth.error });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const nowIso = new Date().toISOString();
  const errors: string[] = [];

  try {
    const { data: existing, error: e1 } = await sb.from("microzone_sentiment")
      .select("comune,area_label,commercial_zone_slug,environment_score,air_quality_score,green_score,services_score,school_access_score,urban_decay_risk_score")
      .ilike("comune", "Padova")
      .limit(2000);
    if (e1) errors.push(`microzone_sentiment:${e1.message}`);

    const listingCount = new Map<string, number>();
    for (const slug of OFFICIAL_ZONE_SLUGS) {
      const { count, error } = await sb.from("padova_listings")
        .select("id", { count: "exact", head: true })
        .eq("commercial_zone_slug", slug)
        .ilike("comune", "Padova");
      if (error) {
        errors.push(`padova_listings:${slug}:${error.message}`);
        continue;
      }
      if ((count ?? 0) > 0) listingCount.set(slug, count!);
    }
    // Quartiere fallback only for rows that still lack a slug — real labels, no invented zones.
    const { data: unzoned, error: e2 } = await sb.from("padova_listings")
      .select("quartiere")
      .ilike("comune", "Padova")
      .is("commercial_zone_slug", null)
      .not("quartiere", "is", null)
      .limit(4000);
    if (e2) errors.push(`padova_listings_unzoned:${e2.message}`);
    for (const row of unzoned ?? []) {
      const slug = commercialZoneForQuartiere(row.quartiere);
      if (!slug) continue;
      listingCount.set(slug, (listingCount.get(slug) ?? 0) + 1);
    }

    const { data: permits, error: e3 } = await sb.from("sue_padova_permits")
      .select("commercial_zone_slug,area_name")
      .limit(5000);
    if (e3) errors.push(`sue_padova_permits:${e3.message}`);

    const { data: signals, error: e4 } = await sb.from("territorial_signals")
      .select("municipality,title,description")
      .ilike("municipality", "Padova")
      .limit(2000);
    if (e4) errors.push(`territorial_signals:${e4.message}`);

    const { data: localSignals, error: e4b } = await sb.from("local_signals")
      .select("commercial_zone_slug,neighborhood,title")
      .ilike("municipality", "Padova")
      .limit(2000);
    if (e4b) errors.push(`local_signals:${e4b.message}`);

    const { data: elderly, error: e5 } = await sb.from("padova_elderly_population")
      .select("area_name,over_75_rate")
      .limit(500);
    if (e5) errors.push(`padova_elderly_population:${e5.message}`);

    const permitCount = new Map<string, number>();
    for (const row of permits ?? []) {
      const slug = row.commercial_zone_slug || commercialZoneForQuartiere(row.area_name);
      if (!slug) continue;
      permitCount.set(slug, (permitCount.get(slug) ?? 0) + 1);
    }

    const signalCount = new Map<string, number>();
    for (const row of signals ?? []) {
      const slug = commercialZoneForQuartiere(row.title) || inferZoneFromText(String(row.description ?? ""));
      if (!slug) continue;
      signalCount.set(slug, (signalCount.get(slug) ?? 0) + 1);
    }
    for (const row of localSignals ?? []) {
      const slug = row.commercial_zone_slug
        || commercialZoneForQuartiere(row.neighborhood)
        || inferZoneFromText(String(row.title ?? ""));
      if (!slug) continue;
      signalCount.set(slug, (signalCount.get(slug) ?? 0) + 1);
    }

    const elderlyByZone = new Map<string, number>();
    for (const row of elderly ?? []) {
      const slug = commercialZoneForQuartiere(row.area_name);
      const rate = Number(row.over_75_rate);
      if (!slug || !Number.isFinite(rate)) continue;
      elderlyByZone.set(slug, rate);
    }

    const rows = OFFICIAL_ZONE_SLUGS.flatMap((slug) => {
      const zoneMs = (existing ?? []).filter((r) => r.commercial_zone_slug === slug);
      const input: SentimentAxisInput = {
        // Zone-scoped axes only. Do not copy the comune-level Padova row onto 8 slugs.
        environment_score: averageNumeric(zoneMs.map((r) => r.environment_score)),
        air_quality_score: averageNumeric(zoneMs.map((r) => r.air_quality_score)),
        green_score: averageNumeric(zoneMs.map((r) => r.green_score)),
        services_score: averageNumeric(zoneMs.map((r) => r.services_score)),
        school_access_score: averageNumeric(zoneMs.map((r) => r.school_access_score)),
        listing_count: listingCount.has(slug) ? listingCount.get(slug)! : null,
        permit_count: permitCount.has(slug) ? permitCount.get(slug)! : null,
        territorial_signal_count: signalCount.has(slug) ? signalCount.get(slug)! : null,
        elderly_over75_rate: elderlyByZone.get(slug) ?? null,
      };
      if (!hasZoneScopedSentimentInput(input)) return [];
      return [computeZoneSentiment(slug, input, nowIso)];
    });

    let written = 0;
    if (rows.length > 0) {
      const { error } = await sb.from("microzone_sentiment").upsert(rows, { onConflict: "fingerprint" });
      if (error) {
        errors.push(`upsert:${error.message}`);
        return json(502, { ok: false, error: error.message, records_processed: 0, errors });
      }
      written = rows.length;
    }

    return json(200, {
      ok: true,
      records_processed: written,
      empty: written === 0,
      skipped_without_zone_inputs: OFFICIAL_ZONE_SLUGS.length - written,
      zones: rows.map((r) => ({
        slug: r.commercial_zone_slug,
        sentiment: r.sentiment_score_total,
        confidence: r.confidence_score,
        quality: r.quality,
        axes: r.data_basis,
      })),
      errors: errors.slice(0, 8),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg.slice(0, 200), records_processed: 0 });
  }
});
