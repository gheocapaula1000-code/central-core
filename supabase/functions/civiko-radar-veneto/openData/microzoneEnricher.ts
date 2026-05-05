// ═══════════════════════════════════════════════════════════════
// Enrich microzone_sentiment from territorial_signals already imported
// (Geoportale Veneto + Open Data Veneto)
//
// Derives: risk_score, risk_inverse_score (in source_refs), green_score,
//          environment_score, territorial_signal_score, sentiment_score_total,
//          confidence_score
//
// No new fetches. No invented data. Updates existing rows by fingerprint.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { VENETO_COMUNI } from "./venetoComuni.ts";

const ALLOWED_PROV = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);

const RISK_TYPES = new Set(["risk_constraint_dataset", "seismic_risk_dataset", "planning_constraints_dataset"]);
const GREEN_TYPES = new Set(["protected_area_dataset", "environment_dataset"]);
const TS_TYPES = new Set([
  "public_services_dataset","mobility_dataset","urban_planning_dataset",
  "environment_dataset","risk_constraint_dataset","roads_dataset",
  "seismic_risk_dataset","protected_area_dataset","planning_constraints_dataset",
]);

const WEIGHTS = {
  air_quality_score: 0.35,
  environment_score: 0.25,
  green_score: 0.15,
  risk_inverse_score: 0.15,
  territorial_signal_score: 0.10,
};

export interface EnrichParams { dryRun?: boolean; import?: boolean; province?: string[]; }

function normProv(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const u = p.trim().toUpperCase();
  return ALLOWED_PROV.has(u) ? u : null;
}
function canonicalComune(name: unknown, prov: string | null): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const raw = name.trim();
  if (VENETO_COMUNI[raw]) return raw;
  const lower = raw.toLowerCase();
  for (const k of Object.keys(VENETO_COMUNI)) {
    if (k.toLowerCase() === lower && (!prov || VENETO_COMUNI[k] === prov)) return k;
  }
  if (prov && raw.length > 1) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return null;
}
function clamp(n: number, lo = 0, hi = 100): number { return Math.max(lo, Math.min(hi, Math.round(n))); }

export async function runEnrichMicrozoneFromTerritorial(params: EnrichParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const provFilter = (params.province ?? Array.from(ALLOWED_PROV))
    .map((p) => p.toUpperCase()).filter((p) => ALLOWED_PROV.has(p));

  const warnings: string[] = []; const errors: string[] = [];
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // ── Aggregate territorial_signals per (prov,comune) ──
  const counts = new Map<string, { risk: number; green: number; ts: number; types: Set<string> }>();
  let from = 0; const STEP = 1000;
  while (true) {
    const { data, error } = await supa.from("territorial_signals")
      .select("province, municipality, signal_type")
      .in("province", provFilter)
      .not("municipality", "is", null)
      .range(from, from + STEP - 1);
    if (error) { errors.push(`ts_query: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const prov = normProv(r.province); if (!prov) continue;
      const com = canonicalComune(r.municipality, prov); if (!com) continue;
      const k = `${prov}|${com.toLowerCase()}`;
      const c = counts.get(k) ?? { risk: 0, green: 0, ts: 0, types: new Set<string>() };
      if (RISK_TYPES.has(r.signal_type)) c.risk++;
      if (GREEN_TYPES.has(r.signal_type)) c.green++;
      if (TS_TYPES.has(r.signal_type)) c.ts++;
      c.types.add(r.signal_type);
      counts.set(k, c);
    }
    if (data.length < STEP) break;
    from += STEP;
  }

  // ── Load microzone_sentiment rows ──
  const rows: any[] = [];
  let off = 0;
  while (true) {
    const { data, error } = await supa.from("microzone_sentiment")
      .select("id, comune, provincia, air_quality_score, environment_score, green_score, sentiment_score_total, confidence_score, source_refs, data_basis, fingerprint")
      .in("provincia", provFilter)
      .range(off, off + STEP - 1);
    if (error) { errors.push(`ms_query: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < STEP) break;
    off += STEP;
  }

  const before = {
    avg_sentiment: avg(rows, "sentiment_score_total"),
    avg_confidence: avg(rows, "confidence_score"),
    with_green: rows.filter((r) => r.green_score != null).length,
    with_env: rows.filter((r) => r.environment_score != null).length,
  };

  let withRisk = 0, withGreen = 0, withEnv = 0, withTs = 0, enrichable = 0;
  const updates: any[] = [];
  const sample: any[] = [];

  for (const r of rows) {
    const k = `${r.provincia}|${(r.comune ?? "").toLowerCase()}`;
    const c = counts.get(k);
    let risk_score: number | null = null;
    let risk_inverse: number | null = null;
    let green: number | null = r.green_score != null ? Number(r.green_score) : null;
    let ts_score: number | null = null;

    if (c?.risk && c.risk > 0) {
      risk_score = clamp(20 + c.risk * 8); // 1→28, 5→60, 10→100 cap
      risk_inverse = 100 - risk_score;
      withRisk++;
    }
    if (c?.green && c.green > 0) {
      green = clamp(50 + c.green * 12);
      withGreen++;
    }
    if (c?.ts && c.ts > 0) {
      ts_score = clamp(35 + c.ts * 5);
      withTs++;
    }

    const air = r.air_quality_score != null ? Number(r.air_quality_score) : null;

    // environment_score = composition of air + green + risk_inverse if available
    let env: number | null = null;
    const envParts: number[] = [];
    if (air != null) envParts.push(air);
    if (green != null) envParts.push(green);
    if (risk_inverse != null) envParts.push(risk_inverse);
    if (envParts.length > 0) { env = clamp(envParts.reduce((a, b) => a + b, 0) / envParts.length); withEnv++; }

    // sentiment_score_total weighted with renormalization
    const comps: Array<[number, number]> = [];
    if (air != null) comps.push([air, WEIGHTS.air_quality_score]);
    if (env != null) comps.push([env, WEIGHTS.environment_score]);
    if (green != null) comps.push([green, WEIGHTS.green_score]);
    if (risk_inverse != null) comps.push([risk_inverse, WEIGHTS.risk_inverse_score]);
    if (ts_score != null) comps.push([ts_score, WEIGHTS.territorial_signal_score]);
    let sentiment: number | null = null;
    if (comps.length > 0) {
      const wsum = comps.reduce((a, [, w]) => a + w, 0);
      sentiment = clamp(comps.reduce((a, [v, w]) => a + v * w, 0) / wsum);
    }

    let confidence = r.confidence_score != null ? Number(r.confidence_score) : 0.65;
    if (risk_score != null) confidence += 0.05;
    if (green != null && r.green_score == null) confidence += 0.05;
    if (ts_score != null) confidence += 0.05;
    confidence = Math.min(0.85, Number(confidence.toFixed(2)));

    const newRefs = Array.isArray(r.source_refs) ? [...r.source_refs] : [];
    const dbset = new Set<string>(Array.isArray(r.data_basis) ? r.data_basis : []);
    if (c) {
      newRefs.push({
        source: "territorial_signals",
        risk_signals: c.risk, green_signals: c.green, total_signals: c.ts,
        signal_types: Array.from(c.types),
      });
      dbset.add("geoportale_veneto");
      dbset.add("territorial_signals");
      if (c.risk > 0) dbset.add("risk_constraints");
      if (c.green > 0) dbset.add("green_areas");
    }

    const changed = (risk_score != null) || (ts_score != null) ||
      (green != null && green !== (r.green_score ?? null)) ||
      (env != null && env !== (r.environment_score ?? null)) ||
      (sentiment != null && sentiment !== (r.sentiment_score_total ?? null)) ||
      (confidence !== Number(r.confidence_score));

    if (!changed) continue;
    enrichable++;

    const upd = {
      id: r.id,
      // never overwrite air_quality_score
      green_score: green,
      environment_score: env,
      sentiment_score_total: sentiment,
      confidence_score: confidence,
      source_refs: newRefs,
      data_basis: Array.from(dbset),
      // store risk_score in source_refs (no DB column written, schema-safe)
    };
    // Embed risk in source_refs as well (no schema change)
    if (risk_score != null) (upd.source_refs as any[]).push({ source: "derived", risk_score, risk_inverse_score: risk_inverse, territorial_signal_score: ts_score });

    updates.push(upd);
    if (sample.length < 10) sample.push({
      comune: r.comune, provincia: r.provincia,
      before: { sentiment: r.sentiment_score_total, confidence: r.confidence_score, green: r.green_score, env: r.environment_score },
      after: { sentiment, confidence, green, env, risk_score, ts_score },
    });
  }

  // ── Persist ──
  let updated = 0;
  if (doImport && updates.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const slice = updates.slice(i, i + CHUNK);
      // upsert per-id
      for (const u of slice) {
        const { error } = await supa.from("microzone_sentiment").update({
          green_score: u.green_score,
          environment_score: u.environment_score,
          sentiment_score_total: u.sentiment_score_total,
          confidence_score: u.confidence_score,
          source_refs: u.source_refs,
          data_basis: u.data_basis,
          updated_at: new Date().toISOString(),
        }).eq("id", u.id);
        if (error) { errors.push(`update_${u.id}: ${error.message}`); continue; }
        updated++;
      }
    }
  }

  // After preview metrics
  const previewRows = rows.map((r) => {
    const u = updates.find((x) => x.id === r.id);
    return u ? { ...r, ...u } : r;
  });
  const after = {
    avg_sentiment: avg(previewRows, "sentiment_score_total"),
    avg_confidence: avg(previewRows, "confidence_score"),
    with_green: previewRows.filter((r) => r.green_score != null).length,
    with_env: previewRows.filter((r) => r.environment_score != null).length,
  };

  return {
    ok: errors.length === 0,
    dryRun, importExecuted: doImport,
    records_scanned: rows.length,
    records_enrichable: enrichable,
    with_risk_score: withRisk,
    with_green_score: withGreen,
    with_environment_score: withEnv,
    with_territorial_signal_score: withTs,
    avg_sentiment_before: before.avg_sentiment,
    avg_sentiment_after_preview: after.avg_sentiment,
    avg_confidence_before: before.avg_confidence,
    avg_confidence_after_preview: after.avg_confidence,
    records_updated: updated,
    sample_changes: sample,
    warnings, errors,
  };
}

function avg(rows: any[], field: string): number | null {
  const vals = rows.map((r) => r[field]).filter((v) => v != null).map((v) => Number(v));
  if (!vals.length) return null;
  return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
}
