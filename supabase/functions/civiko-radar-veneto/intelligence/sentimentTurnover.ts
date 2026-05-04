// Microzone sentiment engine (real-data only).
// Combines: istat_comuni (demographics/elderly proxy), ispra_rischio (env risk),
// mim_schools (school access density), omi_valori (market liquidity proxy),
// territorial_signals (urban planning impact).
// Re-normalizes weights when axes are missing; lowers confidence accordingly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const PROVS = ["VE","VR","VI","PD","TV","BL","RO"];

interface RunOpts {
  province: string[];
  comuni?: string[];
  dryRun: boolean;
  import: boolean;
}
export interface SentimentReport {
  ok: boolean;
  comuni_processed: number;
  rows_written: number;
  axes_used: Record<string, number>;
  errors: string[];
  top: Array<{ comune: string; provincia: string; sentiment: number; confidence: number }>;
}

function supa() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
}

function clamp(n: number, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }
function fingerprint(prov: string, comune: string) { return `mzs:${prov}:${comune.toLowerCase().trim()}`; }

export async function runMicrozoneSentiment(opts: RunOpts): Promise<SentimentReport> {
  const report: SentimentReport = { ok: false, comuni_processed: 0, rows_written: 0, axes_used: {}, errors: [], top: [] };
  const sb = supa();
  if (!sb) { report.errors.push("supabase missing"); return report; }
  const provs = opts.province.length ? opts.province : PROVS;

  // Pull base sets (paginated)
  const { data: istat, error: e1 } = await sb.from("istat_comuni")
    .select("comune,provincia,popolazione,percentuale_over65,percentuale_over85,indice_vecchiaia,eta_media")
    .ilike("regione", "%veneto%")
    .range(0, 999);
  if (e1) report.errors.push(`istat: ${e1.message}`);

  const { data: ispra } = await sb.from("ispra_rischio")
    .select("comune,frana_p3_perc,frana_p4_perc,idro_p3_perc")
    .range(0, 4999);
  const isprabyComune = new Map<string, any>();
  for (const r of (ispra ?? [])) isprabyComune.set(String(r.comune).toLowerCase(), r);

  const { data: schools } = await sb.from("mim_schools")
    .select("comune,provincia").in("provincia", provs).range(0, 9999);
  const schoolsCount = new Map<string, number>();
  for (const s of (schools ?? [])) {
    const k = `${s.provincia}:${String(s.comune).toLowerCase()}`;
    schoolsCount.set(k, (schoolsCount.get(k) ?? 0) + 1);
  }

  const { data: omi } = await sb.from("omi_valori")
    .select("provincia,comune_descrizione,compr_min,compr_max")
    .ilike("regione", "%veneto%")
    .not("compr_max", "is", null).range(0, 9999);
  const omiByComune = new Map<string, { avg: number; n: number }>();
  for (const r of (omi ?? [])) {
    const k = `${r.provincia}:${String(r.comune_descrizione).toLowerCase()}`;
    const mid = ((Number(r.compr_min) || 0) + (Number(r.compr_max) || 0)) / 2;
    if (!mid) continue;
    const cur = omiByComune.get(k) ?? { avg: 0, n: 0 };
    cur.avg = (cur.avg * cur.n + mid) / (cur.n + 1);
    cur.n += 1;
    omiByComune.set(k, cur);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const r of (istat ?? [])) {
    const provRaw = String(r.provincia ?? "");
    const prov = provRaw.toUpperCase().slice(0, 2);
    if (!provs.includes(prov)) continue;
    const comune = String(r.comune ?? "").trim();
    if (!comune) continue;
    if (opts.comuni?.length && !opts.comuni.map((c) => c.toLowerCase()).includes(comune.toLowerCase())) continue;

    const isr = isprabyComune.get(comune.toLowerCase());
    const schoolsN = schoolsCount.get(`${prov}:${comune.toLowerCase()}`) ?? null;
    const omiVal = omiByComune.get(`${prov}:${comune.toLowerCase()}`) ?? null;

    const axes: Record<string, number | null> = {
      environment_score: isr ? clamp(100 - ((Number(isr.frana_p3_perc) || 0) + (Number(isr.frana_p4_perc) || 0) + (Number(isr.idro_p3_perc) || 0)) * 5) : null,
      services_score: schoolsN != null ? clamp(40 + Math.log2(1 + schoolsN) * 12) : null,
      school_access_score: schoolsN != null ? clamp(30 + Math.log2(1 + schoolsN) * 15) : null,
      transit_access_score: null,
      green_score: null,
      safety_proxy_score: null,
      parking_score: null,
      tourism_pressure_score: null,
      nightlife_pressure_score: null,
      urban_decay_risk_score: r.indice_vecchiaia != null ? clamp(Number(r.indice_vecchiaia) / 4) : null,
      noise_score: null,
      air_quality_score: null,
    };
    // Demand fit
    const elderly = Number(r.percentuale_over65) || 0;
    const family_fit_score = clamp(80 - elderly * 1.2 + (schoolsN ? Math.log2(1 + schoolsN) * 5 : 0));
    const investor_fit_score = omiVal ? clamp(50 + Math.log10(omiVal.avg) * 8) : null;
    const student_fit_score = schoolsN != null ? clamp(30 + Math.log2(1 + schoolsN) * 18) : null;

    const weights: Record<string, number> = {
      environment_score: 0.18, services_score: 0.16, school_access_score: 0.14,
      transit_access_score: 0.14, green_score: 0.10, safety_proxy_score: 0.10,
      parking_score: 0.08, noise_score: 0.05, air_quality_score: 0.05,
    };
    let totW = 0, total = 0, axesUsed = 0;
    for (const [k, w] of Object.entries(weights)) {
      const v = axes[k];
      if (v != null) { totW += w; total += v * w; axesUsed++; report.axes_used[k] = (report.axes_used[k] ?? 0) + 1; }
    }
    const sentiment = totW > 0 ? clamp(total / totW) : 0;
    const confidence = clamp((axesUsed / Object.keys(weights).length) * 100);

    const refs: any[] = [];
    if (isr) refs.push({ source_name: "ispra_rischio", source_type: "geo_environment" });
    if (schoolsN != null) refs.push({ source_name: "mim_schools", source_type: "mobility_services_poi" });
    if (omiVal) refs.push({ source_name: "omi_valori", source_type: "omi_market" });
    refs.push({ source_name: "istat_comuni", source_type: "demographic_turnover" });

    rows.push({
      comune, provincia: prov, area_label: comune, area_type: "comune",
      ...axes,
      family_fit_score, student_fit_score, investor_fit_score,
      sentiment_score_total: sentiment,
      confidence_score: confidence,
      quality: confidence >= 60 ? "reale" : "parziale",
      source_refs: refs,
      data_basis: refs.map((r) => r.source_name),
      fingerprint: fingerprint(prov, comune),
      computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    report.comuni_processed++;
  }

  if (!opts.dryRun && opts.import && rows.length) {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await sb.from("microzone_sentiment").upsert(chunk, { onConflict: "fingerprint" });
      if (error) { report.errors.push(`upsert ms: ${error.message}`); break; }
      report.rows_written += chunk.length;
    }
  }

  report.top = [...rows]
    .sort((a, b) => Number(b.sentiment_score_total) - Number(a.sentiment_score_total))
    .slice(0, 10)
    .map((r) => ({ comune: String(r.comune), provincia: String(r.provincia), sentiment: Number(r.sentiment_score_total), confidence: Number(r.confidence_score) }));
  report.ok = true;
  return report;
}

export interface TurnoverReport {
  ok: boolean;
  comuni_processed: number;
  rows_written: number;
  errors: string[];
  top: Array<{ comune: string; provincia: string; turnover: number; confidence: number }>;
}

export async function runTurnoverSignals(opts: RunOpts): Promise<TurnoverReport> {
  const report: TurnoverReport = { ok: false, comuni_processed: 0, rows_written: 0, errors: [], top: [] };
  const sb = supa();
  if (!sb) { report.errors.push("supabase missing"); return report; }
  const provs = opts.province.length ? opts.province : PROVS;

  const { data: istat, error } = await sb.from("istat_comuni")
    .select("comune,provincia,popolazione,percentuale_over65,percentuale_over85,indice_vecchiaia,eta_media")
    .ilike("regione", "%veneto%")
    .range(0, 999);
  if (error) { report.errors.push(`istat: ${error.message}`); return report; }

  const rows: Array<Record<string, unknown>> = [];
  for (const r of (istat ?? [])) {
    const prov = String(r.provincia ?? "").toUpperCase().slice(0, 2);
    if (!provs.includes(prov)) continue;
    const comune = String(r.comune ?? "").trim();
    if (!comune) continue;
    if (opts.comuni?.length && !opts.comuni.map((c) => c.toLowerCase()).includes(comune.toLowerCase())) continue;

    const elderly = Number(r.percentuale_over65) || 0;
    const over85 = Number(r.percentuale_over85) || 0;
    const elderly_ratio = clamp(elderly);
    const single_household_ratio = null;     // censimento abitazioni: pending import
    const non_occupied_ratio = null;
    const old_building_ratio = null;
    const second_home_proxy = null;
    const low_rotation_proxy = null;

    const weights: Record<string, number> = {
      elderly: 0.45, over85: 0.30, vecchiaia: 0.25,
    };
    const axes: Record<string, number | null> = {
      elderly: elderly || null,
      over85: over85 || null,
      vecchiaia: r.indice_vecchiaia != null ? clamp(Number(r.indice_vecchiaia) / 4) : null,
    };
    let tw = 0, t = 0, used = 0;
    for (const [k, w] of Object.entries(weights)) {
      const v = axes[k]; if (v != null) { tw += w; t += v * w; used++; }
    }
    const turnover = tw > 0 ? clamp(t / tw) : 0;
    const confidence = clamp((used / Object.keys(weights).length) * 60); // cap 60: missing housing axes
    rows.push({
      comune, provincia: prov, area_label: comune,
      elderly_ratio, single_household_ratio, non_occupied_ratio, old_building_ratio,
      second_home_proxy, low_rotation_proxy,
      distress_aggregate: null,
      turnover_potential_score: turnover,
      confidence_score: confidence,
      quality: "parziale",
      source_refs: [{ source_name: "istat_comuni", source_type: "demographic_turnover" }],
      data_basis: ["istat_comuni"],
      fingerprint: `tov:${prov}:${comune.toLowerCase().trim()}`,
      computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    report.comuni_processed++;
  }

  if (!opts.dryRun && opts.import && rows.length) {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error: e } = await sb.from("turnover_signals").upsert(chunk, { onConflict: "fingerprint" });
      if (e) { report.errors.push(`upsert tov: ${e.message}`); break; }
      report.rows_written += chunk.length;
    }
  }

  report.top = [...rows]
    .sort((a, b) => Number(b.turnover_potential_score) - Number(a.turnover_potential_score))
    .slice(0, 10)
    .map((r) => ({ comune: String(r.comune), provincia: String(r.provincia), turnover: Number(r.turnover_potential_score), confidence: Number(r.confidence_score) }));
  report.ok = true;
  return report;
}
