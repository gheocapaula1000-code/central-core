import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const scanRunId = body.scan_run_id ?? `run_${Date.now()}`;

    if (assets.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, upserted: 0, message: "No assets to persist" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let upserted = 0;
    let errors = 0;

    for (const asset of assets) {
      if (!asset.id || !asset.title || !asset.category) continue;

      const row = {
        id: asset.id,
        title: asset.title,
        category: asset.category,
        country: asset.location?.country ?? "IT",
        region: asset.location?.region ?? asset.region ?? null,
        city: asset.location?.city ?? asset.city ?? null,
        price_eur: asset.priceEur ?? null,
        price_min_eur: asset.priceRangeEur?.min ?? null,
        price_max_eur: asset.priceRangeEur?.max ?? null,
        price_confidence: asset.priceConfidence ?? "unknown",
        surface_sqm: asset.surfaceSqm ?? null,
        score: asset.score ?? 0,
        priority: asset.priority ?? "low",
        why_now: asset.whyNow ?? null,
        opportunity: asset.opportunity ?? null,
        risk: asset.risk ?? null,
        source_category: asset.source?.category ?? asset.sourceCategory ?? "unknown",
        source_label: asset.source?.name ?? asset.sourceLabel ?? "Unknown",
        source_url: asset.sourceUrl ?? null,
        hero_image_url: asset.heroImageUrl ?? null,
        extraction_confidence: asset.extractionConfidence ?? "medium",
        location_confidence: asset.locationConfidence ?? "inferred",
        missing_fields: asset.missingFields ?? [],
        dossier_available: asset.dossierAvailable ?? false,
        convergent_signal: asset.convergentSignal ?? false,
        merge_count: asset.mergeCount ?? 1,
        merged_sources: asset.mergedSources ?? [],
        last_seen_at: new Date().toISOString(),
        last_scan_run_id: scanRunId,
        active: true,
      };

      // upsert: se esiste incrementa times_seen, altrimenti inserisce
      const { error } = await supabase
        .from("luxu_assets")
        .upsert(
          {
            ...row,
            times_seen: 1,
            first_seen_at: new Date().toISOString(),
          },
          {
            onConflict: "id",
            ignoreDuplicates: false,
          }
        );

      if (error) {
        // Se esiste già, aggiorna solo i campi variabili e incrementa times_seen
        const { error: updateError } = await supabase
          .from("luxu_assets")
          .update({
            score: row.score,
            priority: row.priority,
            why_now: row.why_now,
            opportunity: row.opportunity,
            risk: row.risk,
            price_eur: row.price_eur,
            price_confidence: row.price_confidence,
            convergent_signal: row.convergent_signal,
            merge_count: row.merge_count,
            merged_sources: row.merged_sources,
            dossier_available: row.dossier_available,
            last_seen_at: row.last_seen_at,
            last_scan_run_id: row.last_scan_run_id,
            times_seen: supabase.rpc("increment", { row_id: row.id }),
          })
          .eq("id", row.id);

        if (updateError) {
          errors++;
        } else {
          upserted++;
        }
      } else {
        upserted++;
      }
    }

    // Incrementa times_seen per gli asset già esistenti
    // usando una RPC separata più semplice
    try {
      await supabase.rpc("luxu_increment_times_seen", {
        asset_ids: assets.map((a: any) => a.id).filter(Boolean),
        scan_run: scanRunId,
      });
    } catch {
      // Non critico — times_seen è un bonus
    }

    return new Response(
      JSON.stringify({
        ok: true,
        upserted,
        errors,
        total: assets.length,
        scan_run_id: scanRunId,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
