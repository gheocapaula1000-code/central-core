// civiko-private-leads-price-snapshot
//
// Esegue lo snapshot giornaliero del prezzo per i lead Subito in
// padova_listings e promuove a "privato_stanco" gli annunci che hanno
// almeno 7 giorni di storia E un ribasso cumulato >= 5% dal prezzo
// massimo storico.
//
// Schedulato ogni notte alle 03:00 UTC (dopo il pull Subito 02:25 e
// dopo civiko-private-leads-classify 02:50).

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

const RIBASSO_PCT = 5;
const MIN_AGE_DAYS = 7;
const CIVIKO_SCOPE_SLUGS = [
  "centro-storico", "nord-arcella", "est-brenta", "nord-est",
  "sud-est-sant-osvaldo", "sud-voltabarozzo-guizza",
  "sud-ovest-mandria", "ovest-chiesanuova-brentelle",
];

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
  const today = new Date().toISOString().slice(0, 10);
  const threshold72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

  // 0) Conta tutti i lead Subito che passano i filtri storici (senza filtri di vitalità)
  const { count: candidates_total, error: countErr } = await sb
    .from("padova_listings")
    .select("id", { count: "exact", head: true })
    .eq("fonte", "subito")
    .eq("comune", "Padova")
    .in("commercial_zone_slug", CIVIKO_SCOPE_SLUGS)
    .in("tipo_lead", ["privato", "privato_stanco", "PRIVATO"])
    .gt("prezzo", 0);

  if (countErr) {
    return new Response(JSON.stringify({ ok: false, error: countErr.message, stage: "count" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const candidatesTotal = candidates_total ?? 0;
  if (candidatesTotal === 0) {
    return new Response(JSON.stringify({ ok: false, error: "no_private_candidates", stage: "count" }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 1) Snapshot di tutti i lead Subito con prezzo valido, ancora vivi e visti nelle ultime 72h
  type Row = {
    id: number;
    prezzo: number | null;
    tipo_lead: string | null;
    expired_at: string | null;
    last_seen_at: string | null;
  };
  const all: Row[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb
      .from("padova_listings")
      .select("id, prezzo, tipo_lead, expired_at, last_seen_at")
      .eq("fonte", "subito")
      .eq("comune", "Padova")
      .in("commercial_zone_slug", CIVIKO_SCOPE_SLUGS)
      .in("tipo_lead", ["privato", "privato_stanco", "PRIVATO"])
      .is("expired_at", null)
      .gte("last_seen_at", threshold72h)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const snapshots = all
    .filter((r) => typeof r.prezzo === "number" && r.prezzo! > 0)
    .map((r) => ({ listing_id: r.id, prezzo: r.prezzo!, snapshot_date: today }));

  const skipped_stale = candidatesTotal - snapshots.length;
  if (snapshots.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "no_fresh_private_snapshots", candidates_total: candidatesTotal }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let snapshot_inseriti = 0;
  for (let i = 0; i < snapshots.length; i += 500) {
    const slice = snapshots.slice(i, i + 500);
    const { error, count } = await sb
      .from("padova_listings_price_history")
      .upsert(slice, { onConflict: "listing_id,snapshot_date", ignoreDuplicates: true, count: "exact" });
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message, stage: "snapshot" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    snapshot_inseriti += count ?? slice.length;
  }

  const snapshotted = snapshot_inseriti;
  const duplicates_ignored = snapshots.length - snapshot_inseriti;
  const { count: snapshotRowsToday, error: snapshotCountErr } = await sb
    .from("padova_listings_price_history")
    .select("id", { count: "exact", head: true })
    .eq("snapshot_date", today);
  if (snapshotCountErr || (snapshotRowsToday ?? 0) === 0) {
    return new Response(JSON.stringify({ ok: false, error: "snapshot_verification_failed", stage: "snapshot_verify" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 2) Trova lead con anzianità storica >= 7 giorni e ribasso >= 5% dal massimo storico
  const { data: candidates, error: candErr } = await sb.rpc("padova_listings_price_drop_candidates", {
    p_min_age_days: MIN_AGE_DAYS,
    p_drop_pct: RIBASSO_PCT,
  });

  let promossi = 0;
  let candidati_totali = 0;
  if (candErr) {
    return new Response(JSON.stringify({ ok: false, error: "price_drop_candidates_failed", stage: "candidates" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } else if (Array.isArray(candidates)) {
    candidati_totali = candidates.length;
    const candidateIds = (candidates as Array<{ listing_id: number }>).map((c) => c.listing_id);
    let ids: number[] = [];
    if (candidateIds.length > 0) {
      const { data: scopedRows, error: scopeErr } = await sb.from("padova_listings")
        .select("id")
        .in("id", candidateIds)
        .eq("comune", "Padova")
        .in("commercial_zone_slug", CIVIKO_SCOPE_SLUGS)
        .is("expired_at", null);
      if (scopeErr) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_scope_failed", stage: "candidates" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      ids = (scopedRows ?? []).map((row) => Number(row.id)).filter(Number.isFinite);
    }
    if (ids.length > 0) {
      const { error: updErr, count } = await sb
        .from("padova_listings")
        .update({ tipo_lead: "privato_stanco" }, { count: "exact" })
        .in("id", ids)
        .neq("tipo_lead", "privato_stanco");
      if (updErr) {
        return new Response(JSON.stringify({ ok: false, error: updErr.message, stage: "promote" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      promossi = count ?? 0;
    }
  }

  // 3) Aggiorna lo stato run nel watchdog
  const { count: stancoCount, error: stancoErr } = await sb
    .from("padova_listings")
    .select("id", { count: "exact", head: true })
    .eq("fonte", "subito")
    .eq("comune", "Padova")
    .in("commercial_zone_slug", CIVIKO_SCOPE_SLUGS)
    .eq("tipo_lead", "privato_stanco");
  if (stancoErr) {
    return new Response(JSON.stringify({ ok: false, error: "stanco_count_failed", stage: "verify" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { error: statusErr } = await sb.from("private_leads_run_status").insert({
    source: "subito_price_snapshot",
    opportunita_totali: snapshots.length,
    privato_stanco_count: stancoCount ?? 0,
    status: "snapshot_done",
    error_message: null,
    duration_ms: Date.now() - started,
    notes: {
      snapshot_date: today,
      snapshot_inseriti,
      candidates_total: candidatesTotal,
      skipped_stale,
      snapshotted,
      duplicates_ignored,
      candidati_ribasso: candidati_totali,
      promossi_a_privato_stanco: promossi,
      soglia_ribasso_pct: RIBASSO_PCT,
      anzianita_storia_min_gg: MIN_AGE_DAYS,
    },
  });
  if (statusErr) {
    return new Response(JSON.stringify({ ok: false, error: "run_status_write_failed", stage: "audit" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    duration_ms: Date.now() - started,
    snapshot_date: today,
    snapshot_inseriti,
    snapshot_rows_today: snapshotRowsToday ?? 0,
    candidates_total: candidatesTotal,
    skipped_stale,
    snapshotted,
    duplicates_ignored,
    candidati_ribasso: candidati_totali,
    promossi_a_privato_stanco: promossi,
    privato_stanco_totale_subito: stancoCount ?? 0,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
