// ═══════════════════════════════════════════════════════════════
// Price Resistance Index — gap richiesto vs OMI compr_max per provincia
// ═══════════════════════════════════════════════════════════════
//
// Per ciascuna provincia veneta, calcola:
//   - prezzo_richiesto_medio_per_mq da listing_price_snapshots (ultimi 60gg)
//   - omi_compr_max_medio_per_mq da omi_valori (semestre più recente)
//   - gap_pct = (richiesto - omi_max) / omi_max * 100
//
// Etichetta:
//   gap > +25% → molto_alta resistenza (venditori molto sopra mercato)
//   gap > +10% → alta
//   gap >   0% → media
//   gap >  -5% → bassa
//   gap < -5%  → molto_bassa
//
// methodology_note: "gap rispetto a fascia alta OMI compr_max — proxy onesta,
//   non rappresenta il prezzo di transato reale (non disponibile pubblicamente)".
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const PROVINCE_VENETO = ["Venezia", "Padova", "Verona", "Treviso", "Vicenza", "Belluno", "Rovigo"];
const SAMPLE_WINDOW_DAYS = 60;
const MIN_SAMPLE = 5;

const METHOD_NOTE =
  "Gap calcolato su prezzo richiesto medio per mq (snapshot ultimi 60gg) vs valore OMI compr_max medio della provincia. " +
  "OMI rappresenta il range pubblico di mercato, non il prezzo di transato notarile (non pubblico). " +
  "L'indice misura quanto i venditori si posizionano sopra la fascia alta del mercato dichiarato.";

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function labelFromGap(gapPct: number): "molto_alta" | "alta" | "media" | "bassa" | "molto_bassa" {
  if (gapPct > 25) return "molto_alta";
  if (gapPct > 10) return "alta";
  if (gapPct > 0) return "media";
  if (gapPct > -5) return "bassa";
  return "molto_bassa";
}

export interface ResistanceResult {
  province: string;
  sample_size: number;
  avg_asking_price_eur: number | null;
  avg_omi_compr_max_eur: number | null;
  avg_gap_pct: number | null;
  resistance_label: string | null;
  reason?: string;
}

export async function computePriceResistanceIndex(): Promise<{
  computed: number;
  skipped: number;
  results: ResistanceResult[];
}> {
  const supabase = getServiceClient();
  if (!supabase) return { computed: 0, skipped: PROVINCE_VENETO.length, results: [] };

  const sinceISO = new Date(Date.now() - SAMPLE_WINDOW_DAYS * 86_400_000).toISOString();
  const computedAt = new Date().toISOString();
  const results: ResistanceResult[] = [];
  let computed = 0;
  let skipped = 0;

  for (const province of PROVINCE_VENETO) {
    // Snapshot recenti per provincia con sqm valido
    const { data: snaps, error: snapErr } = await supabase
      .from("listing_price_snapshots")
      .select("price_eur, surface_sqm, captured_at")
      .eq("province", province)
      .gte("captured_at", sinceISO)
      .not("price_eur", "is", null)
      .not("surface_sqm", "is", null)
      .range(0, 4999);

    if (snapErr) {
      results.push({ province, sample_size: 0, avg_asking_price_eur: null, avg_omi_compr_max_eur: null, avg_gap_pct: null, resistance_label: null, reason: snapErr.message });
      skipped++;
      continue;
    }

    const askingPerSqm: number[] = [];
    for (const s of snaps ?? []) {
      const r = s as { price_eur: number; surface_sqm: number };
      if (r.surface_sqm > 10 && r.surface_sqm < 2000 && r.price_eur > 1000) {
        askingPerSqm.push(r.price_eur / r.surface_sqm);
      }
    }

    if (askingPerSqm.length < MIN_SAMPLE) {
      results.push({ province, sample_size: askingPerSqm.length, avg_asking_price_eur: null, avg_omi_compr_max_eur: null, avg_gap_pct: null, resistance_label: null, reason: "sample_below_threshold" });
      skipped++;
      continue;
    }

    const avgAsking = askingPerSqm.reduce((a, b) => a + b, 0) / askingPerSqm.length;

    // OMI compr_max medio della provincia (semestre più recente disponibile)
    const { data: omiRows, error: omiErr } = await supabase
      .from("omi_valori")
      .select("compr_max, semestre")
      .ilike("provincia", province)
      .not("compr_max", "is", null)
      .order("semestre", { ascending: false })
      .range(0, 9999);

    if (omiErr || !omiRows || omiRows.length === 0) {
      results.push({ province, sample_size: askingPerSqm.length, avg_asking_price_eur: Math.round(avgAsking), avg_omi_compr_max_eur: null, avg_gap_pct: null, resistance_label: null, reason: "no_omi_data" });
      skipped++;
      continue;
    }

    // Filtra al semestre più recente
    const latestSemestre = (omiRows[0] as { semestre: string }).semestre;
    const omiVals = omiRows
      .filter((r) => (r as { semestre: string }).semestre === latestSemestre)
      .map((r) => Number((r as { compr_max: number }).compr_max))
      .filter((v) => Number.isFinite(v) && v > 100);

    if (omiVals.length === 0) {
      results.push({ province, sample_size: askingPerSqm.length, avg_asking_price_eur: Math.round(avgAsking), avg_omi_compr_max_eur: null, avg_gap_pct: null, resistance_label: null, reason: "no_omi_numeric" });
      skipped++;
      continue;
    }

    const avgOmiMax = omiVals.reduce((a, b) => a + b, 0) / omiVals.length;
    const gapPct = ((avgAsking - avgOmiMax) / avgOmiMax) * 100;
    const label = labelFromGap(gapPct);

    const { error: insErr } = await supabase.from("price_resistance_index").insert({
      province,
      region: "veneto",
      computed_at: computedAt,
      sample_size: askingPerSqm.length,
      avg_asking_price_eur: Math.round(avgAsking),
      avg_omi_compr_max_eur: Math.round(avgOmiMax),
      avg_gap_pct: Math.round(gapPct * 10) / 10,
      resistance_label: label,
      methodology_note: METHOD_NOTE,
    });
    if (insErr) {
      console.error("[priceResistance] insert:", insErr.message);
      skipped++;
      continue;
    }

    results.push({
      province,
      sample_size: askingPerSqm.length,
      avg_asking_price_eur: Math.round(avgAsking),
      avg_omi_compr_max_eur: Math.round(avgOmiMax),
      avg_gap_pct: Math.round(gapPct * 10) / 10,
      resistance_label: label,
    });
    computed++;
  }

  return { computed, skipped, results };
}
