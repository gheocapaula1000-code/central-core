// ═══════════════════════════════════════════════════════════════
// inheritancePressureExtractor.ts
// Genera segnali aggregati di pressione successoria / turnover
// patrimoniale per microzona/comune.
// SOLO da fonti aggregate: ISTAT, OMI, succession_heatmap_cap,
// auction_signals aggregati, source_documents depersonalizzati.
// Vietato qualunque dato personale o nominativo.
// ═══════════════════════════════════════════════════════════════
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const VENETO_PROVS = ["VE","VR","VI","PD","TV","BL","RO"];

export interface PressureCandidate {
  comune: string;
  provincia: string;
  area_label: string;
  area_type: "comune" | "microzona" | "cap" | "zona_omi" | "sezione_censuaria" | "quartiere";
  lat: number | null;
  lng: number | null;
  score: number;
  confidence_score: number;
  signal_basis: string[];
  indicators: Record<string, unknown>;
  quality: "reale" | "parziale";
  source_urls: string[];
  source_names: string[];
  data_basis: string[];
  reason: string;
  agentAction: string;
  script: string;
  fingerprint: string;
}

export interface ExtractorReport {
  comuni_evaluated: number;
  candidates: PressureCandidate[];
  aggregate_indicators_found: number;
  warnings: string[];
}

interface IstatRow {
  codice_istat: string; comune: string; provincia: string | null;
  popolazione: number | null; percentuale_over65: number | null;
  percentuale_75_84: number | null; percentuale_over85: number | null;
  indice_vecchiaia: number | null; eta_media: number | null;
}
interface OmiAgg { comune_descrizione: string; provincia: string;
  compr_min: number | null; compr_max: number | null; }
interface AuctAgg { municipality: string | null; province: string | null; n: number; }
interface ShcRow { municipality_main: string | null; province: string | null;
  obituaries_90d: number; probability_score: number; cap: string | null; }

export async function extractInheritancePressure(
  supa: SupabaseClient,
  opts: { province?: string[]; comuni?: string[] },
): Promise<ExtractorReport> {
  const provFilter = (opts.province && opts.province.length
    ? opts.province : VENETO_PROVS).map((p) => p.toUpperCase());
  const comuniFilter = opts.comuni && opts.comuni.length
    ? new Set(opts.comuni.map((c) => c.toLowerCase())) : null;

  const warnings: string[] = [];
  // 1) OMI aggregati per comune (media compr_max) — anche per derivare la provincia
  const omiByComune = new Map<string, { sum: number; n: number; prov: string }>();
  const comuneToProv = new Map<string, string>();
  let from = 0; const PAGE = 1000;
  while (true) {
    const q = await supa.from("omi_valori")
      .select("comune_descrizione,provincia,compr_max")
      .in("provincia", provFilter)
      .range(from, from + PAGE - 1);
    if (q.error) { warnings.push(`omi: ${q.error.message}`); break; }
    const rows = (q.data ?? []) as OmiAgg[];
    for (const r of rows) {
      const prov = r.provincia.toUpperCase();
      const comuneLower = r.comune_descrizione.toLowerCase();
      comuneToProv.set(comuneLower, prov);
      if (typeof r.compr_max !== "number") continue;
      const key = `${prov}|${comuneLower}`;
      const cur = omiByComune.get(key) ?? { sum: 0, n: 0, prov };
      cur.sum += r.compr_max; cur.n++;
      omiByComune.set(key, cur);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 50000) { warnings.push("omi: cap pagination 50k"); break; }
  }

  // 2) ISTAT: provincia spesso NULL → derivala dalla mappa OMI; pagina (>1000)
  const istatRows: IstatRow[] = [];
  let ifrom = 0; const IPAGE = 1000;
  while (true) {
    const q = await supa.from("istat_comuni")
      .select("codice_istat,comune,provincia,popolazione,percentuale_over65,percentuale_75_84,percentuale_over85,indice_vecchiaia,eta_media")
      .range(ifrom, ifrom + IPAGE - 1);
    if (q.error) { warnings.push(`istat: ${q.error.message}`); break; }
    const rows = (q.data ?? []) as IstatRow[];
    istatRows.push(...rows);
    if (rows.length < IPAGE) break;
    ifrom += IPAGE;
    if (ifrom > 20000) break;
  }
  let istat = istatRows.map((r) => {
    const prov = (r.provincia ?? "").toUpperCase() || (comuneToProv.get(r.comune.toLowerCase()) ?? "");
    return { ...r, provincia: prov || null };
  }).filter((r) => r.provincia && provFilter.includes(r.provincia.toUpperCase()));
  if (comuniFilter) istat = istat.filter((r) => comuniFilter.has(r.comune.toLowerCase()));

  // 3) Aste aggregate
  const auctQ = await supa.from("auction_signals")
    .select("municipality,province").eq("is_active", true).limit(5000);
  const auctByComune = new Map<string, number>();
  for (const r of (auctQ.data ?? []) as AuctAgg[]) {
    if (!r.municipality || !r.province) continue;
    const key = `${r.province.toUpperCase()}|${r.municipality.toLowerCase()}`;
    auctByComune.set(key, (auctByComune.get(key) ?? 0) + 1);
  }

  // 4) succession_heatmap_cap (aggregato CAP, non personale)
  const shcQ = await supa.from("succession_heatmap_cap")
    .select("municipality_main,province,obituaries_90d,probability_score,cap")
    .eq("region","veneto").limit(5000);
  const shcByComune = new Map<string, { score: number; n: number }>();
  for (const r of (shcQ.data ?? []) as ShcRow[]) {
    if (!r.municipality_main || !r.province) continue;
    const key = `${r.province.toUpperCase()}|${r.municipality_main.toLowerCase()}`;
    const cur = shcByComune.get(key) ?? { score: 0, n: 0 };
    cur.score += r.probability_score; cur.n++;
    shcByComune.set(key, cur);
  }

  // 5) area_opportunity_scores (per arricchire fiducia)
  const aosQ = await supa.from("area_opportunity_scores")
    .select("municipality,province,score,components")
    .eq("region","veneto").limit(2000);
  const aosByComune = new Map<string, number>();
  for (const r of (aosQ.data ?? []) as Array<{municipality:string;province:string;score:number}>) {
    if (!r.municipality || !r.province) continue;
    const key = `${r.province.toUpperCase()}|${r.municipality.toLowerCase()}`;
    aosByComune.set(key, Math.max(aosByComune.get(key) ?? 0, Number(r.score) || 0));
  }

  // 6) ISTAT separazioni — dato PROVINCIALE (granularità dichiarata nel signal_basis).
  // Non ripartiamo sui comuni: applichiamo lo stesso contributo a tutti i comuni della provincia.
  // Percentile su tutte le province PD per dare un contributo relativo (0-5 pts, peso registry 0.05 * 100).
  const sepQ = await supa.from("istat_separations_padova")
    .select("comune,comune_istat,year,separation_rate,divorce_rate,separations_count,divorces_count")
    .order("year", { ascending: false })
    .limit(500);
  const sepByProv = new Map<string, { rate: number; year: number; count: number }>();
  for (const r of (sepQ.data ?? []) as Array<{comune:string;comune_istat:string;year:number;separation_rate:number|null;divorce_rate:number|null;separations_count:number|null;divorces_count:number|null}>) {
    // Convention: quando comune='__PROVINCIA__' e comune_istat coincide con la sigla provincia,
    // la riga è il totale provinciale (design importer). Se assente, prendiamo la max sep_rate
    // aggregata come proxy provinciale.
    const rate = Number(r.separation_rate ?? r.divorce_rate ?? 0);
    const count = Number(r.separations_count ?? r.divorces_count ?? 0);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    // Mappa comune → provincia via comuneToProv (già costruita)
    const prov = comuneToProv.get(r.comune.toLowerCase());
    if (!prov) continue;
    const cur = sepByProv.get(prov);
    if (!cur || r.year > cur.year) {
      sepByProv.set(prov, { rate, year: r.year, count });
    }
  }

  const candidates: PressureCandidate[] = [];
  let aggregate_indicators_found = 0;

  for (const r of istat) {
    const prov = (r.provincia ?? "").toUpperCase();
    const key = `${prov}|${r.comune.toLowerCase()}`;
    const omi = omiByComune.get(key);
    const omiAvg = omi && omi.n > 0 ? omi.sum / omi.n : null;
    const aste = auctByComune.get(key) ?? 0;
    const shc = shcByComune.get(key);
    const aos = aosByComune.get(key);

    const indicators: Record<string, unknown> = {};
    const basis: string[] = [];
    let score = 0;
    let confidence = 0;

    if (typeof r.indice_vecchiaia === "number") {
      indicators.indice_vecchiaia = r.indice_vecchiaia;
      basis.push("istat_indice_vecchiaia");
      // 100=parità giov/anziani; >200 forte invecchiamento
      score += Math.min(35, Math.max(0, (r.indice_vecchiaia - 120) / 4));
      confidence += 25;
      aggregate_indicators_found++;
    }
    if (typeof r.percentuale_over65 === "number") {
      indicators.percentuale_over65 = r.percentuale_over65;
      basis.push("istat_over65");
      score += Math.min(20, Math.max(0, (r.percentuale_over65 - 18) * 1.2));
      confidence += 15;
      aggregate_indicators_found++;
    }
    if (typeof r.percentuale_over85 === "number") {
      indicators.percentuale_over85 = r.percentuale_over85;
      basis.push("istat_over85");
      score += Math.min(15, r.percentuale_over85 * 2);
      confidence += 10;
      aggregate_indicators_found++;
    }
    if (omiAvg !== null) {
      indicators.omi_compr_max_avg = Math.round(omiAvg);
      basis.push("omi_valori_aggregati");
      confidence += 15;
      aggregate_indicators_found++;
    }
    if (aste > 0) {
      indicators.aste_attive_aggregate = aste;
      basis.push("auction_signals_aggregati");
      score += Math.min(10, aste);
      confidence += 10;
      aggregate_indicators_found++;
    }
    if (shc && shc.n > 0) {
      const shcAvg = shc.score / shc.n;
      indicators.succession_heatmap_avg = Math.round(shcAvg);
      basis.push("succession_heatmap_cap_aggregato");
      score += Math.min(10, shcAvg / 10);
      confidence += 10;
      aggregate_indicators_found++;
    }
    if (typeof aos === "number") {
      indicators.area_opportunity_score = aos;
      basis.push("area_opportunity_scores");
      score += Math.min(10, aos / 10);
      confidence += 10;
      aggregate_indicators_found++;
    }

    // ISTAT SEPARAZIONI — provinciale (granularità dichiarata esplicitamente)
    const sep = sepByProv.get(prov);
    if (sep && sep.rate > 0) {
      indicators.istat_separazioni_provinciale = {
        rate: Math.round(sep.rate * 100) / 100,
        year: sep.year,
        granularity: "provincia",
      };
      basis.push("istat_separazioni_provinciale");
      // Peso registry 0.05 → max 5 pts. Rate tipico Italia ~1.5/1000 abitanti.
      // Normalizziamo 0..3 su 0..5pts (saturo oltre 3).
      score += Math.min(5, (sep.rate / 3) * 5);
      confidence += 5;
      aggregate_indicators_found++;
    }

    if (basis.length < 2) continue; // serve almeno 2 indicatori aggregati
    score = Math.round(Math.max(0, Math.min(100, score)));
    confidence = Math.min(100, confidence);
    const quality: "reale" | "parziale" = (basis.includes("istat_indice_vecchiaia") && (omiAvg !== null)) ? "reale" : "parziale";

    const reason = buildReason(indicators);
    const fp = `ip|${prov}|${r.comune.toLowerCase()}|${basis.sort().join(",")}`;

    candidates.push({
      comune: r.comune,
      provincia: prov,
      area_label: r.comune,
      area_type: "comune",
      lat: null, lng: null,
      score, confidence_score: confidence,
      signal_basis: basis,
      indicators,
      quality,
      source_urls: [
        "https://demo.istat.it/?l=it",
        "https://www.entrate.gov.it/portale/web/guest/schede/fabbricatiterreni/omi",
      ],
      source_names: ["istat_dcis_popres1","omi_agenzia_entrate"],
      data_basis: basis,
      reason,
      agentAction: "Campagna informativa di valutazione patrimoniale aggregata sulla zona, senza riferimenti a persone o famiglie.",
      script: "Stiamo preparando un report gratuito sui valori immobiliari della zona e sulle opzioni di valorizzazione per immobili maturi. Se desidera capire quanto vale oggi il suo immobile, possiamo offrirle una valutazione basata su dati OMI e mercato locale.",
      fingerprint: fp,
    });
  }

  return { comuni_evaluated: istat.length, candidates, aggregate_indicators_found, warnings };
}

function buildReason(ind: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof ind.indice_vecchiaia === "number") parts.push(`indice di vecchiaia ${Math.round(ind.indice_vecchiaia as number)}`);
  if (typeof ind.percentuale_over65 === "number") parts.push(`${(ind.percentuale_over65 as number).toFixed(1)}% over 65`);
  if (typeof ind.omi_compr_max_avg === "number") parts.push(`OMI medio ${Math.round(ind.omi_compr_max_avg as number)} €/m²`);
  if (typeof ind.aste_attive_aggregate === "number") parts.push(`${ind.aste_attive_aggregate} aste aggregate`);
  if (typeof ind.succession_heatmap_avg === "number") parts.push(`pressione successoria CAP ${Math.round(ind.succession_heatmap_avg as number)}/100`);
  return `Microzona con ${parts.slice(0,3).join(", ")}: area da presidiare per consulenze di valorizzazione patrimoniale, senza riferimenti a persone o famiglie.`;
}

export function turnoverTemperature(score: number): "monitor" | "tiepida" | "calda" | "molto_calda" {
  if (score >= 76) return "molto_calda";
  if (score >= 56) return "calda";
  if (score >= 31) return "tiepida";
  return "monitor";
}
