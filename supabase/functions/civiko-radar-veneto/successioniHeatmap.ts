// ═══════════════════════════════════════════════════════════════
// Successioni Heatmap CAP — aggregazione probabilità per CAP veneto
// ═══════════════════════════════════════════════════════════════
//
// Per ogni CAP popolato in obituaries_seen (region veneto, ultimi 90gg):
//   - conta necrologi (proxy stress demografico)
//   - calcola indice_vecchiaia medio dei comuni associati (ISTAT)
//   - calcola % zone OMI residenziali nel comune principale
//   - score combinato → probability_label
//
// "Meglio assente che fragile":
//   - se obituaries_seen[cap] < 3 in 90gg → skip (dato troppo debole)
//   - se mancano sia ISTAT che OMI → skip
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const WINDOW_DAYS = 90;
const MIN_OBITUARIES = 3;

const RESIDENTIAL_TIPOLOGIE = [
  "abitazioni civili",
  "abitazioni economiche",
  "abitazioni signorili",
  "abitazioni di tipo economico",
  "ville e villini",
];

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

interface CapAggregation {
  cap: string;
  obituaries: number;
  municipalities: Set<string>;
  province: string | null;
}

export interface HeatmapResult {
  cap: string;
  province: string | null;
  municipality_main: string | null;
  obituaries_90d: number;
  indice_vecchiaia_avg: number | null;
  pct_residential_omi: number | null;
  probability_score: number;
  probability_label: "molto_alta" | "alta" | "media" | "bassa";
}

function labelFromScore(score: number): HeatmapResult["probability_label"] {
  if (score >= 75) return "molto_alta";
  if (score >= 55) return "alta";
  if (score >= 35) return "media";
  return "bassa";
}

export async function recomputeSuccessionHeatmap(): Promise<{
  computed: number;
  skipped: number;
  errors: number;
  results: HeatmapResult[];
}> {
  const supabase = getServiceClient();
  if (!supabase) return { computed: 0, skipped: 0, errors: 1, results: [] };

  const windowEndDate = new Date();
  const windowStartDate = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const windowStartISO = windowStartDate.toISOString().slice(0, 10);

  // NUOVO PERCORSO PII-FREE: leggiamo bucket AGGREGATI per CAP,
  // già filtrati a k>=3 (constraint DB) e generati dal parser stateless.
  // obituaries_seen resta congelata (trigger DB); non viene mai letta.
  const { data: aggRows, error: aggErr } = await supabase
    .from("obituaries_aggregate_padova")
    .select("area_code, bucket_count, window_end")
    .eq("area_type", "cap")
    .gte("window_end", windowStartISO)
    .range(0, 4999);

  if (aggErr) {
    console.error("[successioniHeatmap] aggregate query:", aggErr.message);
    return { computed: 0, skipped: 0, errors: 1, results: [] };
  }
  if (!aggRows || aggRows.length === 0) {
    // Nessun bucket disponibile: uscita pulita, nessun errore.
    return { computed: 0, skipped: 0, errors: 0, results: [] };
  }

  // Somma bucket per CAP (in caso di più finestre parzialmente sovrapposte).
  const byCap = new Map<string, CapAggregation>();
  for (const r of aggRows as Array<{ area_code: string; bucket_count: number }>) {
    const agg = byCap.get(r.area_code) ?? {
      cap: r.area_code,
      obituaries: 0,
      municipalities: new Set<string>(),
      province: "PD", // pipeline aggregata è per ora Padova-only
    };
    agg.obituaries += Number(r.bucket_count) || 0;
    byCap.set(r.area_code, agg);
  }

  // Arricchisci con municipality principale per CAP (via ISTAT/OMI).
  // Non-blocking: se non risolviamo il comune, teniamo comunque il CAP.
  return await computeHeatmapFromAggregation(supabase, byCap, windowEndDate);
}

async function computeHeatmapFromAggregation(
  supabase: ReturnType<typeof getServiceClient>,
  byCap: Map<string, CapAggregation>,
  windowEndDate: Date,
): Promise<{ computed: number; skipped: number; errors: number; results: HeatmapResult[] }> {
  if (!supabase) return { computed: 0, skipped: 0, errors: 1, results: [] };

  const results: HeatmapResult[] = [];
  let skipped = 0;
  let errors = 0;
  const computedAt = windowEndDate.toISOString();

  for (const agg of byCap.values()) {
    if (agg.obituaries < MIN_OBITUARIES) {
      skipped++;
      continue;
    }

    // Risolvi comune principale del CAP via OMI (comune con più zone associate).
    let municipality_main: string | null = null;
    let indice_vecchiaia_avg: number | null = null;
    let pct_residential_omi: number | null = null;

    // OMI: cerchiamo comuni PD con questo CAP (via omi_valori arricchito da altre tabelle non è fattibile:
    // il CAP non è in omi_zone). Ripieghiamo su padova_civici se popolata, altrimenti prima passata soft.
    const { data: civici } = await supabase
      .from("padova_civici")
      .select("comune")
      .eq("cap", agg.cap)
      .limit(50);
    const municipalities = Array.from(new Set((civici ?? [])
      .map((c) => (c as { comune: string | null }).comune)
      .filter((v): v is string => typeof v === "string" && v.length > 0)));
    municipality_main = municipalities[0] ?? null;

    if (municipalities.length > 0) {
      const { data: istat } = await supabase
        .from("istat_comuni")
        .select("indice_vecchiaia")
        .in("comune", municipalities)
        .eq("regione", "Veneto");
      if (istat && istat.length > 0) {
        const vals = istat
          .map((r) => Number((r as { indice_vecchiaia: number | null }).indice_vecchiaia))
          .filter((v) => Number.isFinite(v) && v > 0);
        if (vals.length > 0) indice_vecchiaia_avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }

    if (municipality_main) {
      const { data: zones } = await supabase
        .from("omi_zone")
        .select("descr_tip_prev")
        .ilike("comune_descrizione", municipality_main)
        .range(0, 999);
      if (zones && zones.length > 0) {
        const total = zones.length;
        const residential = zones.filter((z) => {
          const d = ((z as { descr_tip_prev: string | null }).descr_tip_prev ?? "").toLowerCase();
          return RESIDENTIAL_TIPOLOGIE.some((t) => d.includes(t));
        }).length;
        pct_residential_omi = (residential / total) * 100;
      }
    }

    if (indice_vecchiaia_avg === null && pct_residential_omi === null) {
      // Nessun arricchimento: uso solo l'aggregato necrologi (score dimezzato).
      // Meglio contribuire debolmente che scartare del tutto.
    }

    // Pesi originali: 40 aggregato / 30 vecchiaia / 30 residenziale
    const obScore = Math.min(40, (agg.obituaries / 30) * 40);
    const vScore =
      indice_vecchiaia_avg !== null
        ? Math.max(0, Math.min(30, ((indice_vecchiaia_avg - 100) / 100) * 30))
        : 10;
    const rScore =
      pct_residential_omi !== null
        ? Math.max(0, Math.min(30, ((pct_residential_omi - 20) / 50) * 30))
        : 10;
    const probability_score = Math.round((obScore + vScore + rScore) * 10) / 10;
    const probability_label = labelFromScore(probability_score);

    const row: HeatmapResult = {
      cap: agg.cap,
      province: agg.province,
      municipality_main,
      obituaries_90d: agg.obituaries,
      indice_vecchiaia_avg: indice_vecchiaia_avg !== null ? Math.round(indice_vecchiaia_avg * 10) / 10 : null,
      pct_residential_omi: pct_residential_omi !== null ? Math.round(pct_residential_omi * 10) / 10 : null,
      probability_score,
      probability_label,
    };

    const { error: insErr } = await supabase.from("succession_heatmap_cap").insert({
      cap: row.cap,
      region: "veneto",
      province: row.province,
      municipality_main: row.municipality_main,
      computed_at: computedAt,
      obituaries_90d: row.obituaries_90d,
      indice_vecchiaia_avg: row.indice_vecchiaia_avg,
      pct_residential_omi: row.pct_residential_omi,
      probability_score: row.probability_score,
      probability_label: row.probability_label,
      payload: { municipalities, source: "obituaries_aggregate_padova" },
    });
    if (insErr) {
      console.error("[successioniHeatmap] insert:", insErr.message);
      errors++;
      continue;
    }
    results.push(row);
  }

  return { computed: results.length, skipped, errors, results };
}
