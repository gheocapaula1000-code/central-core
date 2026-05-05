// ═══════════════════════════════════════════════════════════════
// Enrich microzone_sentiment with risk data from ispra_rischio
// (already in DB — no fetch). Real ISPRA national table joined by comune.
//
// - risk_score = clamp(15 + max(idro_p3, frana_p4)*1.5 + (idro_p2 + frana_p3)*0.4, 0, 90)
// - risk_inverse_score = 100 - risk_score
// - if all risk fields null/0 and pop_idro_p1=0 → null (do not invent)
// - never overwrite air_quality_score
// - store risk in source_refs (schema-safe), data_basis updated
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_PROV = new Set(["VE", "VR", "VI", "PD", "TV", "BL", "RO"]);

// ── normalization & aliases (Veneto-only, conservative) ──
// Fold: lowercase, NFD strip accents, normalize curly quotes,
// drop trailing apostrophe (Arsie' → arsie, Arsiè → arsie),
// drop all apostrophes/dots, collapse spaces.
function normFold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201B\u0060\u00B4]/g, "'")
    .toLowerCase()
    .replace(/['.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// Manual aliases for renames/suffix divergences (microzone → ispra canonical).
// All targets verified to exist in ispra_rischio for Veneto.
const COMUNE_ALIASES: Record<string, string> = {
  "brenzone": "brenzone sul garda",
  "costermano": "costermano sul garda",
  "negrar": "negrar di valpolicella",
  "vodo di cadore": "vodo cadore",
};
function aliasKey(folded: string): string {
  return COMUNE_ALIASES[folded] ?? folded;
}


const WEIGHTS = {
  air_quality_score: 0.35,
  environment_score: 0.25,
  green_score: 0.15,
  risk_inverse_score: 0.15,
  territorial_signal_score: 0.10,
};

export interface IspraEnrichParams { dryRun?: boolean; import?: boolean; province?: string[]; }

function n(v: any): number | null { if (v == null) return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
function clamp(x: number, lo = 0, hi = 100): number { return Math.max(lo, Math.min(hi, Math.round(x))); }
function avgField(rows: any[], f: string): number | null {
  const v = rows.map((r) => r[f]).filter((x) => x != null).map(Number);
  if (!v.length) return null;
  return Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2));
}

export function calculateIspraRiskScore(row: {
  idro_p2_perc?: any; idro_p3_perc?: any; frana_p3_perc?: any; frana_p4_perc?: any;
  pop_idro_p1?: any;
}): number | null {
  const idro_p2 = n(row.idro_p2_perc) ?? 0;
  const idro_p3 = n(row.idro_p3_perc) ?? 0;
  const frana_p3 = n(row.frana_p3_perc) ?? 0;
  const frana_p4 = n(row.frana_p4_perc) ?? 0;
  const pop_idro_p1 = n(row.pop_idro_p1) ?? 0;
  if (idro_p2 === 0 && idro_p3 === 0 && frana_p3 === 0 && frana_p4 === 0 && pop_idro_p1 === 0) return null;
  const score = 15 + Math.max(idro_p3, frana_p4) * 1.5 + (idro_p2 + frana_p3) * 0.4;
  return clamp(score, 0, 90);
}

export function calculateRiskInverseScore(risk: number | null): number | null {
  return risk == null ? null : 100 - risk;
}

export async function joinIspraToMicrozoneSentiment(supa: any, provFilter: string[]) {
  const ispra: any[] = [];
  let off = 0; const STEP = 1000;
  while (true) {
    const { data, error } = await supa.from("ispra_rischio")
      .select("comune, codice_istat, idro_p2_perc, idro_p3_perc, frana_p3_perc, frana_p4_perc, pop_idro_p1")
      .range(off, off + STEP - 1);
    if (error) throw new Error(`ispra: ${error.message}`);
    if (!data || !data.length) break;
    ispra.push(...data);
    if (data.length < STEP) break;
    off += STEP;
  }
  const idx = new Map<string, any>();
  for (const r of ispra) {
    if (typeof r.comune === "string" && r.comune.trim()) {
      const raw = r.comune.trim().toLowerCase();
      idx.set(raw, r);
      const folded = normFold(r.comune);
      if (!idx.has(folded)) idx.set(folded, r);
    }
  }

  const ms: any[] = [];
  off = 0;
  while (true) {
    const { data, error } = await supa.from("microzone_sentiment")
      .select("id, comune, provincia, air_quality_score, environment_score, green_score, sentiment_score_total, confidence_score, source_refs, data_basis, fingerprint")
      .in("provincia", provFilter)
      .eq("is_active", true)
      .range(off, off + STEP - 1);
    if (error) throw new Error(`ms: ${error.message}`);
    if (!data || !data.length) break;
    ms.push(...data);
    if (data.length < STEP) break;
    off += STEP;
  }
  return { ispra, idx, ms };
}

export function recalculateEnvironmentScore(air: number | null, green: number | null, risk_inv: number | null): number | null {
  const parts: number[] = [];
  if (air != null) parts.push(air);
  if (green != null) parts.push(green);
  if (risk_inv != null) parts.push(risk_inv);
  if (!parts.length) return null;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length);
}

export function recalculateSentimentScore(air: number | null, env: number | null, green: number | null, risk_inv: number | null, ts_score: number | null): number | null {
  const c: Array<[number, number]> = [];
  if (air != null) c.push([air, WEIGHTS.air_quality_score]);
  if (env != null) c.push([env, WEIGHTS.environment_score]);
  if (green != null) c.push([green, WEIGHTS.green_score]);
  if (risk_inv != null) c.push([risk_inv, WEIGHTS.risk_inverse_score]);
  if (ts_score != null) c.push([ts_score, WEIGHTS.territorial_signal_score]);
  if (!c.length) return null;
  const w = c.reduce((a, [, x]) => a + x, 0);
  return clamp(c.reduce((a, [v, x]) => a + v * x, 0) / w);
}

export async function runIspraRiskEnrichment(params: IspraEnrichParams) {
  const dryRun = params.dryRun !== false;
  const doImport = params.import === true && !dryRun;
  const provFilter = (params.province ?? Array.from(ALLOWED_PROV))
    .map((p) => p.toUpperCase()).filter((p) => ALLOWED_PROV.has(p));

  const warnings: string[] = []; const errors: string[] = [];
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let ispraRows: any[]; let idx: Map<string, any>; let ms: any[];
  try { ({ ispra: ispraRows, idx, ms } = await joinIspraToMicrozoneSentiment(supa, provFilter)); }
  catch (e: any) { return { ok: false, dryRun, importExecuted: false, errors: [e?.message ?? String(e)], warnings }; }

  const before = {
    avg_sentiment: avgField(ms, "sentiment_score_total"),
    avg_confidence: avgField(ms, "confidence_score"),
    riskCoverage: ms.filter((r) => Array.isArray(r.source_refs) && (r.source_refs as any[]).some((s: any) => s?.risk_score != null)).length,
  };

  const updates: any[] = [];
  const sample: any[] = [];
  const notJoinable: any[] = [];
  const previewScores: { comune: string; provincia: string; risk: number }[] = [];
  let joinable = 0, riskNull = 0, risk75plus = 0, risk90 = 0;

  for (const r of ms) {
    const key = (r.comune ?? "").toString().trim().toLowerCase();
    const ir = key ? idx.get(key) : null;
    if (!ir) {
      if (notJoinable.length < 30) notJoinable.push({ id: r.id, comune: r.comune, provincia: r.provincia });
      continue;
    }
    joinable++;

    const risk = calculateIspraRiskScore(ir);
    const risk_inv = calculateRiskInverseScore(risk);
    if (risk == null) riskNull++;
    else {
      if (risk >= 75) risk75plus++;
      if (risk >= 90) risk90++;
      previewScores.push({ comune: r.comune, provincia: r.provincia, risk });
    }

    const air = n(r.air_quality_score);
    const greenExisting = n(r.green_score);
    let ts_score: number | null = null;
    if (Array.isArray(r.source_refs)) {
      for (const s of r.source_refs as any[]) {
        if (s?.territorial_signal_score != null) { ts_score = Number(s.territorial_signal_score); break; }
      }
    }

    const env = recalculateEnvironmentScore(air, greenExisting, risk_inv);
    const sentiment = recalculateSentimentScore(air, env, greenExisting, risk_inv, ts_score);

    const baseRefs = (Array.isArray(r.source_refs) ? r.source_refs : []).filter((s: any) => !(s && (s.source === "derived" || s.source === "ispra_rischio")));
    const newRefs = [...baseRefs, {
      source: "ispra_rischio",
      risk_score: risk,
      risk_inverse_score: risk_inv,
      idro_p2_perc: n(ir.idro_p2_perc),
      idro_p3_perc: n(ir.idro_p3_perc),
      frana_p3_perc: n(ir.frana_p3_perc),
      frana_p4_perc: n(ir.frana_p4_perc),
      codice_istat: ir.codice_istat ?? null,
    }];
    if (ts_score != null) newRefs.push({ source: "derived", territorial_signal_score: ts_score });

    const dbset = new Set<string>(Array.isArray(r.data_basis) ? r.data_basis : []);
    if (risk != null) {
      dbset.add("ispra_rischio");
      dbset.add("hydrogeological_risk");
      dbset.add("rischio_idrogeologico");
      if ((n(ir.frana_p3_perc) ?? 0) > 0 || (n(ir.frana_p4_perc) ?? 0) > 0) {
        dbset.add("landslide_risk");
        dbset.add("rischio_frane");
      }
    }

    let confidence = n(r.confidence_score) ?? 0.6;
    const hadRisk = (Array.isArray(r.source_refs) ? r.source_refs : []).some((s: any) => s?.risk_score != null);
    if (risk != null && !hadRisk) confidence = Math.min(0.9, confidence + 0.05);
    confidence = Number(confidence.toFixed(2));

    const changed = (risk != null) ||
      (env != null && env !== n(r.environment_score)) ||
      (sentiment != null && sentiment !== n(r.sentiment_score_total));
    if (!changed) continue;

    const upd = {
      id: r.id,
      environment_score: env,
      sentiment_score_total: sentiment,
      confidence_score: confidence,
      source_refs: newRefs,
      data_basis: Array.from(dbset),
      _risk: risk, _risk_inv: risk_inv,
    };
    updates.push(upd);
    if (sample.length < 10) sample.push({
      comune: r.comune, provincia: r.provincia,
      before: { sentiment: r.sentiment_score_total, confidence: r.confidence_score, env: r.environment_score },
      after: { sentiment, confidence, env, risk_score: risk, risk_inverse: risk_inv },
    });
  }

  if (risk90 > Math.max(50, joinable * 0.25)) {
    warnings.push(`saturation_warning: ${risk90} comuni a risk_score>=90 (>${Math.round(joinable * 0.25)}). Verificare formula.`);
  }

  let updated = 0;
  if (doImport && updates.length > 0) {
    for (const u of updates) {
      const { error } = await supa.from("microzone_sentiment").update({
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

  const previewRows = ms.map((r) => {
    const u = updates.find((x) => x.id === r.id);
    return u ? { ...r, environment_score: u.environment_score, sentiment_score_total: u.sentiment_score_total, confidence_score: u.confidence_score, source_refs: u.source_refs } : r;
  });
  const after = {
    avg_sentiment: avgField(previewRows, "sentiment_score_total"),
    avg_confidence: avgField(previewRows, "confidence_score"),
    riskCoverage: previewRows.filter((r) => Array.isArray(r.source_refs) && (r.source_refs as any[]).some((s: any) => s?.risk_score != null)).length,
  };

  previewScores.sort((a, b) => b.risk - a.risk);
  const top10High = previewScores.slice(0, 10);
  const top10Low = previewScores.slice(-10).reverse();

  const riskVals = updates.map((u) => u._risk).filter((x) => x != null) as number[];
  const riskInvVals = updates.map((u) => u._risk_inv).filter((x) => x != null) as number[];

  return {
    ok: errors.length === 0,
    dryRun, importExecuted: doImport,
    province: provFilter,
    ispra_rows_loaded: ispraRows.length,
    records_scanned: ms.length,
    records_joinable: joinable,
    records_not_joinable: ms.length - joinable,
    riskCoverage_before: before.riskCoverage,
    riskCoverage_after_preview: after.riskCoverage,
    avg_risk_score_preview: riskVals.length ? Number((riskVals.reduce((a, b) => a + b, 0) / riskVals.length).toFixed(2)) : null,
    avg_risk_inverse_preview: riskInvVals.length ? Number((riskInvVals.reduce((a, b) => a + b, 0) / riskInvVals.length).toFixed(2)) : null,
    avg_sentiment_before: before.avg_sentiment,
    avg_sentiment_after_preview: after.avg_sentiment,
    avg_confidence_before: before.avg_confidence,
    avg_confidence_after_preview: after.avg_confidence,
    count_risk_null: riskNull,
    count_risk_75_plus: risk75plus,
    count_risk_90_plus: risk90,
    top_10_highest_risk: top10High,
    top_10_lowest_risk: top10Low,
    sample_changes: sample,
    not_joinable_sample: notJoinable,
    records_updated: updated,
    warnings, errors,
  };
}

export function summarizeIspraCoverage(result: any) {
  return {
    riskCoverage: result?.riskCoverage_after_preview ?? 0,
    avgRiskScore: result?.avg_risk_score_preview ?? null,
    avgSentimentScore: result?.avg_sentiment_after_preview ?? null,
    dataConfidenceAvg: result?.avg_confidence_after_preview ?? null,
  };
}
