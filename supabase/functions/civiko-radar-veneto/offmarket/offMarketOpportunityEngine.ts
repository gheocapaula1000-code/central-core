// ═══════════════════════════════════════════════════════════════
// offMarketOpportunityEngine.ts
// Modulo proprietario Civiko per scoring opportunità off-market
// e acquisizione incarichi a livello comune (Veneto).
//
// HARD RULES:
// - Solo dati aggregati già presenti nel DB.
// - Nessun dato personale, nessun targeting individuale.
// - Nessun necrologio, eredi, famiglie, nomi, indirizzi privati.
// - Nessun valore inventato. Componenti mancanti => peso=0 e
//   confidence_score ridotto, quality marcata "parziale".
// - Pesi rinormalizzati sui soli componenti disponibili.
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ── Types ───────────────────────────────────────────────────────
export interface OffMarketRequest {
  dryRun?: boolean;
  import?: boolean;
  commit?: boolean;
  province?: string[];
  comuni?: string[];
  minConfidence?: number;
}

export interface ScoreBundle {
  off_market_potential_score: number;
  acquisition_priority_score: number;
  owner_education_score: number;
  microzone_heat_score: number;
  family_attractiveness_score: number;
  investor_attractiveness_score: number;
  exclusive_pitch_score: number;
  valuation_campaign_score: number;
  confidence_score: number;
  quality: "parziale" | "buona" | "completa";
  positive_factors: string[];
  negative_factors: string[];
  missing_factors: string[];
  recommended_actions: ActionItem[];
  scripts: ScriptItem[];
  data_basis: string[];
}

export interface ActionItem {
  type: string;
  headline: string;
  whyNow: string;
  recommendedMove: string;
  target: "proprietari_generici" | "famiglie" | "investitori" | "zona";
  confidence: "low" | "medium" | "high";
}

export interface ScriptItem {
  type: string;
  text: string;
}

export interface CommuneRow {
  comune: string;
  provincia: string;
  // ISTAT
  popolazione?: number | null;
  indice_vecchiaia?: number | null;
  percentuale_over65?: number | null;
  percentuale_over85?: number | null;
  eta_media?: number | null;
  // ISPRA
  idro_p3_perc?: number | null;
  frana_p3_perc?: number | null;
  frana_p4_perc?: number | null;
  // OMI
  omi_records?: number;
  // Microzone sentiment aggregates (avg per comune)
  sentiment_score_total?: number | null;
  green_score?: number | null;
  air_quality_score?: number | null;
  environment_score?: number | null;
  microzone_count?: number;
  microzone_confidence?: number | null;
  // Territorial signals
  territorial_count?: number;
  // Listings (offerta)
  listing_count?: number;
  // Pressione successoria aggregata
  inheritance_score?: number | null;
  estate_turnover_score?: number | null;
}

export interface OffMarketReport {
  ok: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  records_scanned: number;
  records_scoreable: number;
  records_skipped: number;
  records_upserted: number;
  evidence_upserted?: number;
  avg_off_market_potential: number;
  avg_acquisition_priority: number;
  avg_microzone_heat: number;
  top_20_comuni_by_offmarket: Array<{ comune: string; provincia: string; score: number; confidence: number }>;
  top_20_comuni_by_acquisition: Array<{ comune: string; provincia: string; score: number; confidence: number }>;
  top_20_comuni_by_family: Array<{ comune: string; provincia: string; score: number; confidence: number }>;
  top_20_comuni_by_investor: Array<{ comune: string; provincia: string; score: number; confidence: number }>;
  sample_scores: Array<{ comune: string; provincia: string; scores: ScoreBundle }>;
  missing_factors_distribution: Record<string, number>;
  warnings: string[];
  errors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────
const VENETO_PROVINCES = ["VE", "VR", "VI", "PD", "TV", "BL", "RO"];

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function clamp(v: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
function r1(v: number): number { return Math.round(v * 10) / 10; }

/** Weighted score: only available components contribute, weights renormalized. */
function weightedScore(parts: Array<{ value: number | null | undefined; weight: number; key: string }>): {
  score: number; missing: string[]; used: string[];
} {
  let totW = 0, totV = 0;
  const missing: string[] = [];
  const used: string[] = [];
  for (const p of parts) {
    if (p.value == null || !Number.isFinite(p.value)) {
      missing.push(p.key);
      continue;
    }
    totW += p.weight;
    totV += clamp(p.value) * p.weight;
    used.push(p.key);
  }
  if (totW === 0) return { score: 0, missing, used };
  return { score: r1(totV / totW), missing, used };
}

function fingerprintFor(row: CommuneRow): string {
  return `oos|veneto|${row.provincia}|${row.comune.toLowerCase().trim()}`;
}

// ── Loader: aggrega tutti i dati per comune Veneto ──────────────
async function loadCommuneRows(supa: SupabaseClient, provFilter: string[], comFilter?: string[]): Promise<CommuneRow[]> {
  const provs = provFilter.filter((p) => VENETO_PROVINCES.includes(p));
  if (provs.length === 0) return [];

  // 1) Spine: microzone_sentiment ha (comune, provincia) coerenti per Veneto.
  //    Aggrega via DISTINCT per ottenere lista comuni.
  const istat: Record<string, CommuneRow> = {};
  {
    let from = 0;
    for (;;) {
      const { data, error } = await supa.from("microzone_sentiment")
        .select("comune,provincia")
        .in("provincia", provs)
        .range(from, from + 999);
      if (error) throw new Error(`spine: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, unknown>>) {
        const com = String(r.comune ?? "").trim();
        const pr = String(r.provincia ?? "").trim().toUpperCase();
        if (!com || !pr) continue;
        if (comFilter && !comFilter.map((c) => c.toLowerCase()).includes(com.toLowerCase())) continue;
        const key = `${pr}|${com.toLowerCase()}`;
        if (!istat[key]) istat[key] = { comune: com, provincia: pr };
      }
      if (data.length < 1000) break;
      from += 1000;
    }
  }

  // 1b) Enrichment ISTAT (provincia null nel DB → match per nome comune)
  {
    const comuni = Array.from(new Set(Object.values(istat).map((r) => r.comune)));
    for (let i = 0; i < comuni.length; i += 200) {
      const ch = comuni.slice(i, i + 200);
      const { data, error } = await supa.from("istat_comuni")
        .select("comune,popolazione,indice_vecchiaia,percentuale_over65,percentuale_over85,eta_media")
        .in("comune", ch);
      if (error) continue;
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        for (const k of Object.keys(istat)) {
          if (istat[k].comune.toLowerCase() === String(r.comune).toLowerCase()) {
            istat[k].popolazione = (r.popolazione as number) ?? istat[k].popolazione ?? null;
            istat[k].indice_vecchiaia = (r.indice_vecchiaia as number) ?? istat[k].indice_vecchiaia ?? null;
            istat[k].percentuale_over65 = (r.percentuale_over65 as number) ?? istat[k].percentuale_over65 ?? null;
            istat[k].percentuale_over85 = (r.percentuale_over85 as number) ?? istat[k].percentuale_over85 ?? null;
            istat[k].eta_media = (r.eta_media as number) ?? istat[k].eta_media ?? null;
          }
        }
      }
    }
  }

  const result = istat;

  // 2) ISPRA rischio (no provincia): match per nome comune (case-insensitive)
  {
    const comuni = Array.from(new Set(Object.values(result).map((r) => r.comune)));
    if (comuni.length > 0) {
      // chunk to avoid IN(...) too large
      const chunks: string[][] = [];
      for (let i = 0; i < comuni.length; i += 200) chunks.push(comuni.slice(i, i + 200));
      for (const ch of chunks) {
        const { data, error } = await supa.from("ispra_rischio")
          .select("comune,idro_p3_perc,frana_p3_perc,frana_p4_perc")
          .in("comune", ch);
        if (error) { continue; }
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
          for (const key of Object.keys(result)) {
            if (result[key].comune.toLowerCase() === String(r.comune).toLowerCase()) {
              result[key].idro_p3_perc = (r.idro_p3_perc as number) ?? null;
              result[key].frana_p3_perc = (r.frana_p3_perc as number) ?? null;
              result[key].frana_p4_perc = (r.frana_p4_perc as number) ?? null;
            }
          }
        }
      }
    }
  }

  // 3) OMI valori (count per comune)
  {
    let f = 0;
    for (;;) {
      const { data, error } = await supa.from("omi_valori")
        .select("comune_descrizione,provincia")
        .in("provincia", provs)
        .range(f, f + 999);
      if (error) break;
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, unknown>>) {
        const key = `${r.provincia}|${String(r.comune_descrizione).toLowerCase().trim()}`;
        if (result[key]) result[key].omi_records = (result[key].omi_records ?? 0) + 1;
      }
      if (data.length < 1000) break;
      f += 1000;
    }
  }

  // 4) microzone_sentiment aggregato per comune (paginato)
  {
    let f = 0;
    const agg: Record<string, { sum: number; n: number; green: number[]; air: number[]; env: number[]; conf: number[] }> = {};
    for (;;) {
      const { data, error } = await supa.from("microzone_sentiment")
        .select("comune,provincia,sentiment_score_total,green_score,air_quality_score,environment_score,confidence_score")
        .in("provincia", provs)
        .range(f, f + 999);
      if (error) break;
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, unknown>>) {
        const key = `${r.provincia}|${String(r.comune).toLowerCase().trim()}`;
        if (!result[key]) continue;
        if (!agg[key]) agg[key] = { sum: 0, n: 0, green: [], air: [], env: [], conf: [] };
        const a = agg[key];
        a.n++;
        if (r.sentiment_score_total != null) a.sum += Number(r.sentiment_score_total);
        if (r.green_score != null) a.green.push(Number(r.green_score));
        if (r.air_quality_score != null) a.air.push(Number(r.air_quality_score));
        if (r.environment_score != null) a.env.push(Number(r.environment_score));
        if (r.confidence_score != null) a.conf.push(Number(r.confidence_score));
      }
      if (data.length < 1000) break;
      f += 1000;
    }
    const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    for (const [key, a] of Object.entries(agg)) {
      result[key].microzone_count = a.n;
      result[key].sentiment_score_total = a.n ? a.sum / a.n : null;
      result[key].green_score = avg(a.green);
      result[key].air_quality_score = avg(a.air);
      result[key].environment_score = avg(a.env);
      result[key].microzone_confidence = avg(a.conf);
    }
  }

  // 5) territorial_signals count per comune
  {
    let f = 0;
    const counts: Record<string, number> = {};
    for (;;) {
      const { data, error } = await supa.from("territorial_signals")
        .select("municipality,province")
        .in("province", provs)
        .range(f, f + 999);
      if (error) break;
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, unknown>>) {
        const key = `${r.province}|${String(r.municipality).toLowerCase().trim()}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      if (data.length < 1000) break;
      f += 1000;
    }
    for (const [k, v] of Object.entries(counts)) if (result[k]) result[k].territorial_count = v;
  }

  // 6) listing_price_snapshots (offerta)
  {
    const counts: Record<string, number> = {};
    let f = 0;
    for (;;) {
      const { data, error } = await supa.from("listing_price_snapshots")
        .select("municipality,province")
        .in("province", provs)
        .range(f, f + 999);
      if (error) break;
      if (!data || data.length === 0) break;
      for (const r of data as Array<Record<string, unknown>>) {
        const key = `${r.province}|${String(r.municipality).toLowerCase().trim()}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      if (data.length < 1000) break;
      f += 1000;
    }
    for (const [k, v] of Object.entries(counts)) if (result[k]) result[k].listing_count = v;
  }

  // 7) inheritance_pressure_signals + estate_turnover_zones (aggregati)
  for (const [tbl, field] of [["inheritance_pressure_signals", "inheritance_score"], ["estate_turnover_zones", "estate_turnover_score"]] as const) {
    const { data, error } = await supa.from(tbl)
      .select("comune,provincia,score")
      .in("provincia", provs);
    if (error) continue;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${r.provincia}|${String(r.comune).toLowerCase().trim()}`;
      if (result[key]) (result[key] as Record<string, unknown>)[field] = (r.score as number) ?? null;
    }
  }

  return Object.values(result);
}

// ── Score computation ───────────────────────────────────────────
export function computeScoresForCommune(row: CommuneRow): ScoreBundle {
  const positive: string[] = [];
  const negative: string[] = [];
  const missing: string[] = [];

  // Derivati normalizzati 0-100 (no invenzioni: null se mancante)
  const aging = row.indice_vecchiaia != null ? clamp((row.indice_vecchiaia / 300) * 100) : null;
  const over85 = row.percentuale_over85 != null ? clamp(row.percentuale_over85 * 10) : null;
  const over65 = row.percentuale_over65 != null ? clamp(row.percentuale_over65 * 2) : null;
  const omiAvail = row.omi_records != null && row.omi_records > 0 ? clamp(Math.log2((row.omi_records ?? 1) + 1) * 12) : null;
  const territorialAvail = row.territorial_count != null ? clamp(Math.log2((row.territorial_count ?? 0) + 1) * 14) : null;
  const sentiment = row.sentiment_score_total != null ? clamp(row.sentiment_score_total) : null;
  const green = row.green_score != null ? clamp(row.green_score) : null;
  const air = row.air_quality_score != null ? clamp(row.air_quality_score) : null;
  const env = row.environment_score != null ? clamp(row.environment_score) : null;

  // Rischio inverso (lower idro+frana => higher score)
  let riskInverse: number | null = null;
  if (row.idro_p3_perc != null || row.frana_p3_perc != null || row.frana_p4_perc != null) {
    const idro = row.idro_p3_perc ?? 0;
    const frana = (row.frana_p3_perc ?? 0) + (row.frana_p4_perc ?? 0);
    const raw = idro * 4 + frana * 6;
    riskInverse = clamp(100 - raw);
  }

  // Bassa offerta (inverse of listing density per 1k pop)
  let lowOffer: number | null = null;
  if (row.popolazione && row.popolazione > 0) {
    const density = ((row.listing_count ?? 0) / (row.popolazione / 1000));
    lowOffer = clamp(100 - density * 30);
  }

  const inheritance = row.inheritance_score != null ? clamp(row.inheritance_score) : null;
  const estate = row.estate_turnover_score != null ? clamp(row.estate_turnover_score) : null;

  // Tag positives/negatives
  if (aging != null && aging >= 60) positive.push("anzianità_alta_aggregata");
  if (over85 != null && over85 >= 30) positive.push("quota_over85_significativa");
  if (omiAvail != null && omiAvail >= 30) positive.push("omi_disponibile");
  if (territorialAvail != null && territorialAvail >= 30) positive.push("segnali_territoriali_ricchi");
  if (sentiment != null && sentiment >= 65) positive.push("sentiment_positivo");
  if (green != null && green >= 60) positive.push("verde_buono");
  if (air != null && air >= 60) positive.push("aria_buona");
  if (riskInverse != null && riskInverse >= 70) positive.push("rischio_basso");
  if (riskInverse != null && riskInverse < 50) negative.push("rischio_elevato");
  if (lowOffer != null && lowOffer >= 70) positive.push("bassa_offerta_visibile");
  if (lowOffer != null && lowOffer < 40) negative.push("offerta_alta");
  if (inheritance != null && inheritance >= 50) positive.push("pressione_patrimoniale_aggregata");

  // 1) off_market_potential
  const offm = weightedScore([
    { key: "aging", value: aging, weight: 2 },
    { key: "over85", value: over85, weight: 1.5 },
    { key: "omi", value: omiAvail, weight: 1 },
    { key: "lowOffer", value: lowOffer, weight: 1.5 },
    { key: "riskInverse", value: riskInverse, weight: 1 },
    { key: "sentiment", value: sentiment, weight: 1 },
    { key: "inheritance", value: inheritance, weight: 1.5 },
    { key: "estate", value: estate, weight: 1 },
  ]);

  // 2) acquisition_priority
  const acq = weightedScore([
    { key: "offmarket", value: offm.score, weight: 2.5 },
    { key: "omi", value: omiAvail, weight: 1.2 },
    { key: "sentiment", value: sentiment, weight: 1 },
    { key: "territorial", value: territorialAvail, weight: 1 },
    { key: "lowOffer", value: lowOffer, weight: 1 },
  ]);

  // 3) owner_education
  const own = weightedScore([
    { key: "riskInverse", value: riskInverse != null ? 100 - riskInverse : null, weight: 1.5 }, // più rischio => più bisogno consulenza
    { key: "omi", value: omiAvail, weight: 1.5 },
    { key: "sentiment", value: sentiment, weight: 1 },
    { key: "aging", value: aging, weight: 1.2 },
    { key: "territorial", value: territorialAvail, weight: 1 },
  ]);

  // 4) microzone_heat
  const heat = weightedScore([
    { key: "sentiment", value: sentiment, weight: 2 },
    { key: "green", value: green, weight: 1 },
    { key: "riskInverse", value: riskInverse, weight: 1 },
    { key: "omi", value: omiAvail, weight: 1 },
    { key: "territorial", value: territorialAvail, weight: 1.5 },
    { key: "env", value: env, weight: 0.8 },
  ]);

  // 5) family_attractiveness
  const fam = weightedScore([
    { key: "green", value: green, weight: 2 },
    { key: "air", value: air, weight: 1.5 },
    { key: "riskInverse", value: riskInverse, weight: 1.5 },
    { key: "sentiment", value: sentiment, weight: 1 },
    { key: "env", value: env, weight: 1 },
  ]);

  // 6) investor_attractiveness
  const inv = weightedScore([
    { key: "omi", value: omiAvail, weight: 1.5 },
    { key: "sentiment", value: sentiment, weight: 1.2 },
    { key: "riskInverse", value: riskInverse, weight: 1 },
    { key: "offmarket", value: offm.score, weight: 1.5 },
    { key: "lowOffer", value: lowOffer, weight: 1 },
  ]);

  // 7) exclusive_pitch
  const exc = weightedScore([
    { key: "owner", value: own.score, weight: 2 },
    { key: "omi", value: omiAvail, weight: 1.2 },
    { key: "heat", value: heat.score, weight: 1.5 },
    { key: "territorial", value: territorialAvail, weight: 1 },
  ]);

  // 8) valuation_campaign
  const val = weightedScore([
    { key: "offmarket", value: offm.score, weight: 2 },
    { key: "omi", value: omiAvail, weight: 1.5 },
    { key: "sentiment", value: sentiment, weight: 1 },
    { key: "territorial", value: territorialAvail, weight: 1 },
  ]);

  // Missing
  const allMissing = new Set<string>();
  for (const m of [offm, acq, own, heat, fam, inv, exc, val]) m.missing.forEach((x) => allMissing.add(x));
  for (const m of allMissing) missing.push(m);

  // Confidence: % di componenti disponibili sui 9 base
  const componentAvail = [aging, over85, over65, omiAvail, territorialAvail, sentiment, green, air, riskInverse, lowOffer];
  const availFrac = componentAvail.filter((v) => v != null).length / componentAvail.length;
  const microConf = row.microzone_confidence != null ? clamp(row.microzone_confidence * 100) / 100 : 0.5;
  const confidence = r1(clamp((availFrac * 0.7 + microConf * 0.3) * 100));
  const quality: ScoreBundle["quality"] = confidence >= 75 ? "buona" : confidence >= 55 ? "parziale" : "parziale";

  // Data basis
  const data_basis: string[] = [];
  if (aging != null || over65 != null) data_basis.push("istat_aggregato");
  if (omiAvail != null) data_basis.push("omi_valori");
  if (sentiment != null) data_basis.push("microzone_sentiment");
  if (territorialAvail != null) data_basis.push("territorial_signals");
  if (riskInverse != null) data_basis.push("ispra_rischio");
  if (lowOffer != null) data_basis.push("listing_price_snapshots");
  if (inheritance != null) data_basis.push("inheritance_pressure_signals");

  // Recommended actions
  const actions: ActionItem[] = [];
  const scripts: ScriptItem[] = [];

  if (offm.score >= 60 && val.score >= 50) {
    actions.push({
      type: "valuation_campaign",
      headline: `Campagna valutazione proprietari — ${row.comune}`,
      whyNow: "Indicatori aggregati di anzianità immobiliare e turnover patrimoniale + OMI disponibile.",
      recommendedMove: "Lancia campagna di valutazione gratuita basata su dati OMI + sentiment di zona.",
      target: "proprietari_generici",
      confidence: confidence >= 65 ? "high" : "medium",
    });
    scripts.push({
      type: "valuation_campaign",
      text: "Stiamo preparando un report gratuito sui valori immobiliari della zona e sui principali fattori che incidono sulla valutazione: OMI, servizi, verde, rischio territoriale e andamento della domanda. Se desidera capire quanto vale oggi il suo immobile, possiamo offrirle una valutazione basata su dati locali.",
    });
  }
  if (acq.score >= 60) {
    actions.push({
      type: "exclusive_acquisition_zone",
      headline: `Zona prioritaria acquisizione incarichi — ${row.comune}`,
      whyNow: "Sentiment positivo, OMI disponibile, segnali territoriali ricchi: ottima leva consulenziale.",
      recommendedMove: "Presidio costante con micro-report di zona e contatto diretto a proprietari (campagna generica, non targeting).",
      target: "zona",
      confidence: confidence >= 65 ? "high" : "medium",
    });
  }
  if (fam.score >= 65) {
    actions.push({
      type: "family_zone_campaign",
      headline: `Zona famiglie — ${row.comune}`,
      whyNow: "Verde, aria e basso rischio convergono su profilo famiglia.",
      recommendedMove: "Comunicazione orientata a famiglie con focus su verde, aria, scuole e sicurezza percepita.",
      target: "famiglie",
      confidence: confidence >= 65 ? "high" : "medium",
    });
  }
  if (inv.score >= 60) {
    actions.push({
      type: "investor_microzone_report",
      headline: `Microzona investitori — ${row.comune}`,
      whyNow: "OMI favorevole + sentiment + bassa offerta: opportunità di yield/valore.",
      recommendedMove: "Prepara micro-report investitori con OMI, sentiment, rischio e rendimento atteso aggregato.",
      target: "investitori",
      confidence: confidence >= 65 ? "high" : "medium",
    });
  }
  if (own.score >= 60) {
    actions.push({
      type: "owner_valuation_campaign",
      headline: `Educazione proprietari — ${row.comune}`,
      whyNow: "Vincoli/rischio o anzianità immobiliare: serve consulenza informata.",
      recommendedMove: "Contenuto educativo su vendita consapevole + invito a valutazione professionale.",
      target: "proprietari_generici",
      confidence: confidence >= 65 ? "high" : "medium",
    });
  }
  if (offm.score >= 65 && lowOffer != null && lowOffer >= 70) {
    actions.push({
      type: "off_market_campaign",
      headline: `Campagna off-market — ${row.comune}`,
      whyNow: "Bassa offerta visibile + alto potenziale latente.",
      recommendedMove: "Campagna off-market generica: presidio zona, lettere generiche ai condomini, eventi informativi.",
      target: "zona",
      confidence: confidence >= 65 ? "high" : "medium",
    });
  }

  return {
    off_market_potential_score: offm.score,
    acquisition_priority_score: acq.score,
    owner_education_score: own.score,
    microzone_heat_score: heat.score,
    family_attractiveness_score: fam.score,
    investor_attractiveness_score: inv.score,
    exclusive_pitch_score: exc.score,
    valuation_campaign_score: val.score,
    confidence_score: confidence,
    quality,
    positive_factors: positive,
    negative_factors: negative,
    missing_factors: Array.from(allMissing),
    recommended_actions: actions,
    scripts,
    data_basis,
  };
}

// ── Runner principale ──────────────────────────────────────────
export async function runOffMarketOpportunityEngine(req: OffMarketRequest): Promise<OffMarketReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];
  const provFilter = (req.province && req.province.length > 0 ? req.province : VENETO_PROVINCES)
    .map((p) => p.toUpperCase());
  const minConf = req.minConfidence ?? 0.45;
  const dryRun = req.dryRun !== false;
  const doImport = (req.import === true || req.commit === true) && !dryRun;

  const supa = svc();
  const report: OffMarketReport = {
    ok: true, started_at: startedAt, ended_at: startedAt, duration_ms: 0,
    records_scanned: 0, records_scoreable: 0, records_skipped: 0, records_upserted: 0,
    avg_off_market_potential: 0, avg_acquisition_priority: 0, avg_microzone_heat: 0,
    top_20_comuni_by_offmarket: [], top_20_comuni_by_acquisition: [],
    top_20_comuni_by_family: [], top_20_comuni_by_investor: [],
    sample_scores: [], missing_factors_distribution: {},
    warnings, errors,
  };
  if (!supa) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY mancante.");
    report.ok = false;
    finalize(report, t0); return report;
  }

  let rows: CommuneRow[] = [];
  try {
    rows = await loadCommuneRows(supa, provFilter, req.comuni);
  } catch (e) {
    errors.push(`load: ${e instanceof Error ? e.message : String(e)}`);
    report.ok = false;
    finalize(report, t0); return report;
  }
  report.records_scanned = rows.length;

  type Scored = { row: CommuneRow; scores: ScoreBundle };
  const scored: Scored[] = [];
  const missingDist: Record<string, number> = {};

  for (const row of rows) {
    const sc = computeScoresForCommune(row);
    for (const m of sc.missing_factors) missingDist[m] = (missingDist[m] ?? 0) + 1;
    if (sc.confidence_score / 100 < minConf) {
      report.records_skipped++;
      continue;
    }
    scored.push({ row, scores: sc });
  }
  report.records_scoreable = scored.length;

  if (scored.length > 0) {
    const sumO = scored.reduce((a, s) => a + s.scores.off_market_potential_score, 0);
    const sumA = scored.reduce((a, s) => a + s.scores.acquisition_priority_score, 0);
    const sumH = scored.reduce((a, s) => a + s.scores.microzone_heat_score, 0);
    report.avg_off_market_potential = r1(sumO / scored.length);
    report.avg_acquisition_priority = r1(sumA / scored.length);
    report.avg_microzone_heat = r1(sumH / scored.length);

    const topBy = (key: keyof ScoreBundle) => [...scored]
      .sort((a, b) => Number(b.scores[key]) - Number(a.scores[key]))
      .slice(0, 20)
      .map((s) => ({ comune: s.row.comune, provincia: s.row.provincia, score: Number(s.scores[key]), confidence: s.scores.confidence_score }));

    report.top_20_comuni_by_offmarket = topBy("off_market_potential_score");
    report.top_20_comuni_by_acquisition = topBy("acquisition_priority_score");
    report.top_20_comuni_by_family = topBy("family_attractiveness_score");
    report.top_20_comuni_by_investor = topBy("investor_attractiveness_score");

    report.sample_scores = scored.slice(0, 8).map((s) => ({
      comune: s.row.comune, provincia: s.row.provincia, scores: s.scores,
    }));
  }
  report.missing_factors_distribution = missingDist;

  // Import
  if (doImport && scored.length > 0) {
    const rowsToUpsert = scored.map(({ row, scores }) => ({
      region: "veneto",
      comune: row.comune,
      provincia: row.provincia,
      area_label: row.comune,
      area_type: "comune",
      off_market_potential_score: scores.off_market_potential_score,
      acquisition_priority_score: scores.acquisition_priority_score,
      owner_education_score: scores.owner_education_score,
      microzone_heat_score: scores.microzone_heat_score,
      family_attractiveness_score: scores.family_attractiveness_score,
      investor_attractiveness_score: scores.investor_attractiveness_score,
      exclusive_pitch_score: scores.exclusive_pitch_score,
      valuation_campaign_score: scores.valuation_campaign_score,
      confidence_score: scores.confidence_score,
      quality: scores.quality,
      positive_factors: scores.positive_factors,
      negative_factors: scores.negative_factors,
      missing_factors: scores.missing_factors,
      recommended_actions: scores.recommended_actions,
      scripts: scores.scripts,
      data_basis: scores.data_basis,
      source_refs: [],
      fingerprint: fingerprintFor(row),
      is_active: true,
      computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    // chunked upsert
    let upserted = 0;
    for (let i = 0; i < rowsToUpsert.length; i += 200) {
      const chunk = rowsToUpsert.slice(i, i + 200);
      const { error, count } = await supa.from("offmarket_opportunity_scores")
        .upsert(chunk, { onConflict: "fingerprint", count: "exact" });
      if (error) errors.push(`upsert: ${error.message}`);
      else upserted += count ?? chunk.length;
    }
    report.records_upserted = upserted;

    // Mirror per-comune scores into civiko_evidence (aggregate-only, no PII)
    const nowIso = new Date().toISOString();
    const evidenceRows = scored.map(({ row, scores }) => {
      const normalized = Math.round((scores.off_market_potential_score / 100) * 1000) / 1000;
      const confBand = scores.confidence_score >= 75 ? "high"
        : scores.confidence_score >= 50 ? "medium" : "low";
      const provLc = (row.provincia || "").toLowerCase();
      const comLc = (row.comune || "").toLowerCase().replace(/\s+/g, "_");
      const entityKey = `${provLc}::${comLc}`;
      const explanation =
        `Off-market potential ${scores.off_market_potential_score}/100 ` +
        `(norm ${normalized}) per ${row.comune} (${row.provincia}). ` +
        `Acquisition ${scores.acquisition_priority_score}, ` +
        `microzone heat ${scores.microzone_heat_score}, ` +
        `quality ${scores.quality}, confidence ${scores.confidence_score}.` +
        (scores.positive_factors.length ? ` Positivi: ${scores.positive_factors.slice(0, 4).join("; ")}.` : "") +
        (scores.missing_factors.length ? ` Mancanti: ${scores.missing_factors.slice(0, 4).join(", ")}.` : "");
      return {
        entity_type: "comune",
        entity_key: entityKey,
        source_code: "offmarket_engine",
        evidence_type: "offmarket_potential",
        evidence_value: {
          normalized,
          off_market_potential_score: scores.off_market_potential_score,
          acquisition_priority_score: scores.acquisition_priority_score,
          microzone_heat_score: scores.microzone_heat_score,
          family_attractiveness_score: scores.family_attractiveness_score,
          investor_attractiveness_score: scores.investor_attractiveness_score,
          confidence_score: scores.confidence_score,
          quality: scores.quality,
          comune: row.comune,
          provincia: row.provincia,
        },
        confidence: confBand,
        freshness_days: 0,
        observed_at: nowIso,
        explanation,
        compliance_visibility: "aggregate_only",
      };
    });
    let evUpserted = 0;
    for (let i = 0; i < evidenceRows.length; i += 200) {
      const chunk = evidenceRows.slice(i, i + 200);
      const { error, count } = await supa.from("civiko_evidence")
        .upsert(chunk, { onConflict: "entity_type,entity_key,source_code,evidence_type", count: "exact" });
      if (error) errors.push(`evidence_upsert: ${error.message}`);
      else evUpserted += count ?? chunk.length;
    }
    report.evidence_upserted = evUpserted;

    // ── Per-microzona evidence rows (additivo: non sostituisce l'aggregato pd::padova) ──
    // Hard rule: nessun dato inventato. Una microzona viene scritta SOLO se ha
    //   - sentiment locale (microzone_sentiment.area_label ≠ comune) oppure
    //   - una zona OMI canonica (omi_zone_geometry) per quel comune
    // E SOLO se signals_count >= 2 (early_offmarket_signal_candidates matchati) e normalized >= 0.1.
    const slug = (s: string) => String(s).toLowerCase().trim()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const microRows: Array<Record<string, unknown>> = [];
    for (const { row, scores } of scored) {
      const comuneLc = (row.comune || "").toLowerCase();
      const provLc = (row.provincia || "").toLowerCase();
      const comuneNorm = comuneLc.trim();

      // 1) microzone locali (sentiment per area_label distinto dal comune)
      const microSet = new Map<string, { label: string; sentiment: number | null; conf: number | null }>();
      try {
        const { data: msRows } = await supa.from("microzone_sentiment")
          .select("area_label,sentiment_score_total,confidence_score")
          .eq("provincia", row.provincia)
          .ilike("comune", row.comune || "")
          .limit(500);
        for (const m of (msRows ?? []) as Array<Record<string, unknown>>) {
          const label = String(m.area_label ?? "").trim();
          if (!label || label.toLowerCase() === comuneNorm) continue;
          const s = slug(label);
          if (!s) continue;
          if (!microSet.has(s)) microSet.set(s, {
            label,
            sentiment: m.sentiment_score_total != null ? Number(m.sentiment_score_total) : null,
            conf: m.confidence_score != null ? Number(m.confidence_score) : null,
          });
        }
      } catch { /* ignore */ }

      // 2) fallback: zone OMI canoniche
      if (microSet.size === 0) {
        try {
          const { data: omiRows } = await supa.from("omi_zone_geometry")
            .select("zona,zona_descr")
            .ilike("comune_descrizione", row.comune || "")
            .limit(500);
          const seen = new Set<string>();
          for (const z of (omiRows ?? []) as Array<Record<string, unknown>>) {
            const label = String(z.zona_descr ?? z.zona ?? "").trim();
            if (!label) continue;
            const s = slug(label);
            if (!s || seen.has(s)) continue;
            seen.add(s);
            microSet.set(s, { label, sentiment: null, conf: null });
          }
        } catch { /* ignore */ }
      }

      if (microSet.size === 0) continue;

      // 3) candidates per quel comune con location_detail/title/summary
      let candidates: Array<{ loc: string; conf: number | null }> = [];
      try {
        const { data: cands } = await supa.from("early_offmarket_signal_candidates")
          .select("location_detail,title,summary,confidence_score")
          .ilike("comune", row.comune || "")
          .limit(1000);
        candidates = ((cands ?? []) as Array<Record<string, unknown>>).map((c) => ({
          loc: [c.location_detail, c.title, c.summary].filter(Boolean).join(" | ").toLowerCase(),
          conf: c.confidence_score != null ? Number(c.confidence_score) : null,
        }));
      } catch { /* ignore */ }

      const comuneNormalized = Math.round((scores.off_market_potential_score / 100) * 1000) / 1000;

      for (const [microSlug, info] of microSet) {
        const needle = info.label.toLowerCase();
        const matched = candidates.filter((c) => c.loc.includes(needle) || c.loc.includes(microSlug.replace(/-/g, " ")));
        const signalsCount = matched.length;

        // microzone_heat: usa sentiment locale (0-100) se disponibile, altrimenti scala con signals
        const microzoneHeat = info.sentiment != null
          ? Math.round(info.sentiment)
          : Math.min(100, signalsCount * 15);

        // normalized: media tra normalized del comune e quota signals (capped)
        const signalsScore = Math.min(1, signalsCount / 10);
        const normalized = Math.round(((comuneNormalized + signalsScore) / 2) * 1000) / 1000;

        // confidence: media confidence candidates + sentiment confidence (0..1)
        const confSamples: number[] = [];
        if (info.conf != null) confSamples.push(info.conf);
        for (const m of matched) if (m.conf != null) confSamples.push(m.conf);
        const confidenceScore = confSamples.length
          ? Math.round((confSamples.reduce((a, b) => a + b, 0) / confSamples.length) * 100) / 100
          : 0.5;

        // hard filter: niente rumore
        if (normalized < 0.1 || signalsCount < 2) continue;

        const acquisitionPriority = Math.round((normalized * 60 + signalsScore * 40));
        const confBand = confidenceScore >= 0.75 ? "high" : confidenceScore >= 0.5 ? "medium" : "low";

        microRows.push({
          entity_type: "microzona",
          entity_key: `${provLc}::${microSlug}`,
          source_code: "offmarket_engine",
          evidence_type: "offmarket_potential",
          evidence_value: {
            normalized,
            confidence_score: confidenceScore,
            microzone_heat: microzoneHeat,
            acquisition_priority: acquisitionPriority,
            signals_count: signalsCount,
            comune: row.comune,
            provincia: row.provincia,
            area_label: info.label,
          },
          confidence: confBand,
          freshness_days: 0,
          observed_at: nowIso,
          explanation:
            `Microzona ${info.label} (${row.comune}): normalized ${normalized}, ` +
            `${signalsCount} segnali off-market, heat ${microzoneHeat}/100, ` +
            `confidence ${confidenceScore}.`,
          compliance_visibility: "aggregate_only",
        });
      }
    }

    let microUpserted = 0;
    for (let i = 0; i < microRows.length; i += 200) {
      const chunk = microRows.slice(i, i + 200);
      const { error, count } = await supa.from("civiko_evidence")
        .upsert(chunk, { onConflict: "entity_type,entity_key,source_code,evidence_type", count: "exact" });
      if (error) errors.push(`microzona_evidence_upsert: ${error.message}`);
      else microUpserted += count ?? chunk.length;
    }
    report.evidence_upserted = (report.evidence_upserted ?? 0) + microUpserted;
  } else if (!doImport) {
    warnings.push("dryRun/import=false: candidati non scritti.");
  }

  finalize(report, t0);
  return report;
}

function finalize(report: OffMarketReport, t0: number) {
  report.ended_at = new Date().toISOString();
  report.duration_ms = Date.now() - t0;
}
