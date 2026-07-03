// ═══════════════════════════════════════════════════════════════
// civiko-istat-separations-import
//
// Popola istat_separations_padova con il dato PROVINCIALE Padova (PD)
// per separazioni e divorzi. Granularità dichiarata = provincia
// (design confermato: nessuna ripartizione stimata sui comuni).
//
// Strategia:
//   Tenta in ordine gli endpoint SDMX ISTAT noti per il dataset
//   "Separazioni e divorzi" a livello provinciale. Se nessuno risponde,
//   ritorna warning "istat_separations_endpoint_undetermined" senza
//   scrivere nulla (principio "dati veri o niente").
//
// Convention di storage:
//   comune='__PROVINCIA__', comune_istat='028' (codice ISTAT PD),
//   year=<ultimo anno pubblicato>, separations_count, divorces_count,
//   separation_rate = separazioni / popolazione * 1000.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret, x-job-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Endpoint SDMX candidati (ordine di preferenza) — dataset separazioni/divorzi.
// Ogni tentativo scarica CSV filtrato per Padova (codice ITTER107 = ITH36 provincia).
const SDMX_BASE = "https://esploradati.istat.it/SDMXWS/rest/data";
const CANDIDATE_DATAFLOWS = [
  "22_299", // DCIS_MATRIMONI (matrimoni/separazioni/divorzi negli ultimi rilasci)
  "22_311", // DCIS_SEPDIVCONS
  "22_308", // DCIS_DIVORZI
];

// Codice ITTER107 provincia Padova
const ITH_PADOVA = "ITH36";
const CODICE_ISTAT_PADOVA = "028";

interface RunReport {
  ok: boolean;
  written: number;
  attempted_endpoints: string[];
  successful_endpoint: string | null;
  year: number | null;
  separations_count: number | null;
  divorces_count: number | null;
  separation_rate: number | null;
  warnings: string[];
}

async function tryFetchSdmxCsv(dataflow: string, timeoutMs = 20_000): Promise<string | null> {
  // Chiave SDMX generica per Padova, tutte le età/sessi, ultimo anno disponibile.
  // Formato "csvdata".
  const url = `${SDMX_BASE}/${dataflow}/.${ITH_PADOVA}...?format=csvdata`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "Accept": "text/csv" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const csv = await res.text();
    if (!csv || csv.length < 100 || !csv.toUpperCase().includes("OBS_VALUE")) return null;
    return csv;
  } catch {
    return null;
  }
}

interface Parsed {
  year: number;
  separations: number | null;
  divorces: number | null;
}

function parseCsv(csv: string): Parsed | null {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toUpperCase());
  const iTime = header.indexOf("TIME_PERIOD");
  const iValue = header.indexOf("OBS_VALUE");
  const iMeasure = header.findIndex((h) => h === "MEASURE" || h === "TIPO_DATO15" || h === "TIPO_DATO");
  if (iTime < 0 || iValue < 0) return null;

  let latestYear = 0;
  let separations: number | null = null;
  let divorces: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const y = parseInt(cols[iTime] ?? "0", 10);
    const v = Number(cols[iValue] ?? NaN);
    if (!Number.isFinite(v) || !Number.isFinite(y)) continue;
    if (y < latestYear) continue;
    if (y > latestYear) { latestYear = y; separations = null; divorces = null; }
    const measure = (iMeasure >= 0 ? cols[iMeasure] : "").toUpperCase();
    if (/SEP/.test(measure)) separations = v;
    else if (/DIV/.test(measure)) divorces = v;
    else if (separations === null) separations = v; // fallback prima misura
  }
  if (latestYear === 0) return null;
  return { year: latestYear, separations, divorces };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = req.headers.get("x-internal-secret") ?? req.headers.get("x-job-secret") ?? "";
  const expected = Deno.env.get("CENTRAL_CORE_JOB_SECRET") ?? "";
  if (!expected || secret !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun: boolean = body?.dry_run === true;

  const report: RunReport = {
    ok: true,
    written: 0,
    attempted_endpoints: [],
    successful_endpoint: null,
    year: null,
    separations_count: null,
    divorces_count: null,
    separation_rate: null,
    warnings: [],
  };

  let parsed: Parsed | null = null;
  for (const df of CANDIDATE_DATAFLOWS) {
    report.attempted_endpoints.push(df);
    const csv = await tryFetchSdmxCsv(df);
    if (!csv) continue;
    parsed = parseCsv(csv);
    if (parsed) {
      report.successful_endpoint = df;
      break;
    }
  }

  if (!parsed) {
    report.warnings.push("istat_separations_endpoint_undetermined");
    report.ok = true; // non è un errore fatale: la fonte va confermata manualmente
    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  report.year = parsed.year;
  report.separations_count = parsed.separations;
  report.divorces_count = parsed.divorces;
  // Padova provincia ~932.000 abitanti (2025). Rate per 1000.
  const POP_PADOVA_PROV = 932000;
  report.separation_rate = parsed.separations !== null
    ? Math.round((parsed.separations / POP_PADOVA_PROV) * 1000 * 100) / 100
    : null;

  if (dryRun) {
    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supa = createClient(url, key, { auth: { persistSession: false } });

  const { error } = await supa.from("istat_separations_padova").upsert({
    year: parsed.year,
    comune: "__PROVINCIA__",
    comune_istat: CODICE_ISTAT_PADOVA,
    separations_count: parsed.separations,
    divorces_count: parsed.divorces,
    marriages_count: null,
    separation_rate: report.separation_rate,
    divorce_rate: parsed.divorces !== null
      ? Math.round((parsed.divorces / POP_PADOVA_PROV) * 1000 * 100) / 100
      : null,
    source_url: `${SDMX_BASE}/${report.successful_endpoint}`,
  }, { onConflict: "year,comune_istat" });

  if (error) {
    report.ok = false;
    report.warnings.push(`upsert_error:${error.message}`);
  } else {
    report.written = 1;
  }

  return new Response(JSON.stringify(report), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
