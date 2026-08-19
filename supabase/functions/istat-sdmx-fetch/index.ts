// ═══════════════════════════════════════════════════════════════
// ISTAT SDMX Auto-Fetch — Veneto età 75-84 / 85+
// ═══════════════════════════════════════════════════════════════
//
// Scarica direttamente da SDMX ISTAT il dataset DCIS_POPRES1
// (Popolazione residente al 1° gennaio per età/sesso/comune)
// e popola istat_comuni con:
//   - popolazione totale
//   - maschi / femmine
//   - percentuale_75_84
//   - percentuale_over85
//   - percentuale_over65
//   - indice_vecchiaia (over65 / under15 * 100)
//
// Endpoint REST SDMX 2.1:
//   GET https://esploradati.istat.it/SDMXWS/rest/data/22_289/
//       <chiave>?format=csvdata
//
// Filtri usati per Veneto (codici Eurostat ITH):
//   ITH3 = Veneto (regione NUTS2). Scarichiamo per regione,
//   poi disaggreghiamo per comune via dimensione ITTER107.
//
// Auth: AI_CORE_SECRET + origin policy (segue lo standard del Core).
// ═══════════════════════════════════════════════════════════════

import {
  handleOptions,
  ok,
  fail,
  makeDebugId,
  requireSecret,
  enforceOriginPolicy,
  isJobSecretAuthorized,
} from "../_shared/http.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { writeSourceRegistryStatus } from "../_shared/sourceRegistryStatus.ts";

const SDMX_BASE = "https://esploradati.istat.it/SDMXWS/rest/data";
const DATAFLOW = "22_289"; // DCIS_POPRES1
const VENETO_PROVINCES_ITH = [
  "ITH31", // Verona
  "ITH32", // Vicenza
  "ITH33", // Belluno
  "ITH34", // Treviso
  "ITH35", // Venezia
  "ITH36", // Padova
  "ITH37", // Rovigo
];
const ANNO_RIFERIMENTO = 2025;
const BATCH_INSERT = 200;

interface IstatRow {
  codice_istat: string;
  comune: string;
  provincia: string | null;
  regione: string;
  popolazione: number;
  maschi: number | null;
  femmine: number | null;
  percentuale_under18: number | null;
  percentuale_under35: number | null;
  percentuale_over65: number | null;
  percentuale_75_84: number | null;
  percentuale_over85: number | null;
  indice_vecchiaia: number | null;
  eta_media: number | null;
  anno: number;
}

interface RawObservation {
  codiceComune: string;
  nomeComune: string;
  provincia: string | null;
  sesso: "1" | "2" | "9"; // 1=M, 2=F, 9=Totale
  eta: string;            // codice età "Y0", "Y1"... oppure classi "Y_GE100", "TOTAL"
  valore: number;
}

// CSV SDMX standard (csvdata) → header riga 1 separato da ","
function parseSdmxCsv(csv: string): RawObservation[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const idx = (name: string) => header.findIndex((h) => h.toUpperCase() === name.toUpperCase());

  const iTerritorio = idx("ITTER107");
  const iSesso = idx("SEXISTAT1");
  const iEta = idx("ETA1");
  const iValue = idx("OBS_VALUE");
  const iLabelTerr = idx("Territorio");

  if (iTerritorio < 0 || iSesso < 0 || iEta < 0 || iValue < 0) {
    console.warn("[istat-sdmx] CSV header inatteso:", header.join("|"));
    return [];
  }

  const rows: RawObservation[] = [];
  for (let i = 1; i < lines.length; i++) {
    // CSV potenzialmente con virgole nei labels → semplice splitter (ISTAT non usa quote complesse nei codici)
    const cols = splitCsvRow(lines[i]);
    if (cols.length <= Math.max(iTerritorio, iSesso, iEta, iValue)) continue;
    const codice = (cols[iTerritorio] ?? "").trim();
    if (!/^\d{6}$/.test(codice)) continue; // solo comuni (6 cifre)
    const valoreNum = Number((cols[iValue] ?? "").replace(",", "."));
    if (!Number.isFinite(valoreNum)) continue;
    const sesso = (cols[iSesso] ?? "9").trim() as "1" | "2" | "9";
    const eta = (cols[iEta] ?? "").trim();
    const nomeTerr = iLabelTerr >= 0 ? (cols[iLabelTerr] ?? "").replace(/^"|"$/g, "").trim() : codice;
    rows.push({
      codiceComune: codice,
      nomeComune: nomeTerr,
      provincia: null,
      sesso,
      eta,
      valore: valoreNum,
    });
  }
  return rows;
}

function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Età SDMX → numero (Y0..Y99, Y_GE100, TOTAL)
function parseEta(code: string): number | "TOTAL" | null {
  if (!code) return null;
  const up = code.toUpperCase();
  if (up === "TOTAL" || up === "_T") return "TOTAL";
  if (up === "Y_GE100" || up === "Y100_GE") return 100;
  const m = up.match(/^Y(\d{1,3})$/);
  if (m) return Number(m[1]);
  return null;
}

// Build chiavi SDMX alternative (l'API ISTAT è instabile su query larghe → tentativi multipli + dataflow alternativi).
// 22_289 = DCIS_POPRES1 (popolazione residente al 1° gennaio per età)
// 115_333 = DCIS_POPSTRBIL1 (popolazione residente per sesso, anno - più stabile)
// La chiave SDMX dipende dal dataflow; usiamo wildcard ampia e filtriamo lato parser.
function buildSdmxUrlVariants(territorioITH: string, anno: number): string[] {
  const variants: string[] = [];
  // 1) DCIS_POPRES1 con FREQ esplicita "A" + sesso totale 9 + stato civile 99
  variants.push(`${SDMX_BASE}/22_289/A.${territorioITH}.9..99.${anno}?format=csvdata&dimensionAtObservation=AllDimensions`);
  // 2) DCIS_POPRES1 senza filtri stato civile/sesso
  variants.push(`${SDMX_BASE}/22_289/A.${territorioITH}.....${anno}?format=csvdata&dimensionAtObservation=AllDimensions`);
  // 3) DCIS_POPRES1 SDMX-CSV via Accept
  variants.push(`${SDMX_BASE}/22_289/A.${territorioITH}.9..99.${anno}?dimensionAtObservation=AllDimensions`);
  // 4) DCIS_POPSTRBIL1 fallback (struttura popolazione, dataset alternativo più stabile)
  variants.push(`${SDMX_BASE}/115_333/A.${territorioITH}.9..${anno}?format=csvdata&dimensionAtObservation=AllDimensions`);
  // 5) DCIS_POPSTRBIL1 chiave più snella
  variants.push(`${SDMX_BASE}/115_333/.${territorioITH}....${anno}?format=csvdata&dimensionAtObservation=AllDimensions`);
  return variants;
}

async function fetchSdmxProvincia(
  ith: string,
  anno: number,
): Promise<RawObservation[]> {
  const variants = buildSdmxUrlVariants(ith, anno);
  for (let i = 0; i < variants.length; i++) {
    const url = variants[i];
    const useAcceptCsv = !url.includes("format=csvdata"); // ultimo tentativo
    const accept = useAcceptCsv
      ? "application/vnd.sdmx.data+csv;version=1.0.0,text/csv;q=0.9,*/*;q=0.5"
      : "text/csv,application/csv;q=0.9,*/*;q=0.5";
    console.log(`[istat-sdmx] ${ith} try#${i + 1} GET ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch(url, { headers: { Accept: accept }, signal: controller.signal });
      if (!res.ok) {
        console.warn(`[istat-sdmx] ${ith} try#${i + 1}: HTTP ${res.status}`);
        clearTimeout(timer);
        continue;
      }
      const csv = await res.text();
      clearTimeout(timer);
      const parsed = parseSdmxCsv(csv);
      if (parsed.length > 0) {
        console.log(`[istat-sdmx] ${ith}: ${parsed.length} osservazioni (variant #${i + 1})`);
        return parsed;
      }
      console.warn(`[istat-sdmx] ${ith} try#${i + 1}: 0 obs nel CSV (header=${csv.split(/\r?\n/)[0]?.slice(0, 200)})`);
    } catch (e) {
      clearTimeout(timer);
      console.warn(`[istat-sdmx] ${ith} try#${i + 1} error:`, e instanceof Error ? e.message : String(e));
    }
  }
  return [];
}

// Aggrega RawObservation per comune e calcola percentuali
function aggregaPerComune(
  observations: RawObservation[],
  provinciaSigla: string,
  anno: number,
): IstatRow[] {
  type Bucket = {
    nome: string;
    totale: number;
    maschi: number;
    femmine: number;
    pop_under15: number;
    pop_under18: number;
    pop_under35: number;
    pop_over65: number;
    pop_75_84: number;
    pop_over85: number;
    somma_eta_pesata: number; // per età media
    pop_eta_nota: number;
  };
  const map = new Map<string, Bucket>();

  for (const o of observations) {
    const eta = parseEta(o.eta);
    if (eta === null) continue;
    const b = map.get(o.codiceComune) ?? {
      nome: o.nomeComune,
      totale: 0, maschi: 0, femmine: 0,
      pop_under15: 0, pop_under18: 0, pop_under35: 0, pop_over65: 0,
      pop_75_84: 0, pop_over85: 0,
      somma_eta_pesata: 0, pop_eta_nota: 0,
    };
    if (!map.has(o.codiceComune)) map.set(o.codiceComune, b);

    if (eta === "TOTAL") {
      // Totali per sesso
      if (o.sesso === "9") b.totale = o.valore;
      else if (o.sesso === "1") b.maschi = o.valore;
      else if (o.sesso === "2") b.femmine = o.valore;
      continue;
    }

    // Conta solo le età numeriche con sesso totale (9) per evitare doppi conteggi M+F
    if (o.sesso !== "9") continue;
    const v = o.valore;
    b.somma_eta_pesata += eta * v;
    b.pop_eta_nota += v;
    if (eta < 15) b.pop_under15 += v;
    if (eta < 18) b.pop_under18 += v;
    if (eta < 35) b.pop_under35 += v;
    if (eta >= 65) b.pop_over65 += v;
    if (eta >= 75 && eta <= 84) b.pop_75_84 += v;
    if (eta >= 85) b.pop_over85 += v;
  }

  const out: IstatRow[] = [];
  for (const [codice, b] of map.entries()) {
    if (b.totale <= 0) continue;
    const pct = (n: number) => Math.round((n / b.totale) * 10000) / 100; // 2 decimali
    out.push({
      codice_istat: codice,
      comune: b.nome || codice,
      provincia: provinciaSigla,
      regione: "Veneto",
      popolazione: b.totale,
      maschi: b.maschi || null,
      femmine: b.femmine || null,
      percentuale_under18: b.pop_under18 > 0 ? pct(b.pop_under18) : null,
      percentuale_under35: b.pop_under35 > 0 ? pct(b.pop_under35) : null,
      percentuale_over65: b.pop_over65 > 0 ? pct(b.pop_over65) : null,
      percentuale_75_84: b.pop_75_84 > 0 ? pct(b.pop_75_84) : null,
      percentuale_over85: b.pop_over85 > 0 ? pct(b.pop_over85) : null,
      indice_vecchiaia: b.pop_under15 > 0 ? Math.round((b.pop_over65 / b.pop_under15) * 1000) / 10 : null,
      eta_media: b.pop_eta_nota > 0 ? Math.round((b.somma_eta_pesata / b.pop_eta_nota) * 100) / 100 : null,
      anno,
    });
  }
  return out;
}

const ITH_TO_PROVINCIA: Record<string, string> = {
  ITH31: "VR",
  ITH32: "VI",
  ITH33: "BL",
  ITH34: "TV",
  ITH35: "VE",
  ITH36: "PD",
  ITH37: "RO",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();

  const originErr = enforceOriginPolicy(req, debugId);
  if (originErr) return originErr;

  // pg_cron / GitHub Actions send x-job-secret = CENTRAL_CORE_JOB_SECRET.
  // Admin/manual callers keep requireSecret() (x-internal-secret + x-source-app).
  if (!isJobSecretAuthorized(req)) {
    const authErr = requireSecret(req, debugId);
    if (authErr) return authErr;
  }

  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const provinces: string[] = Array.isArray(body?.provinces) && body.provinces.length > 0
      ? body.provinces
      : VENETO_PROVINCES_ITH;
    const anno: number = Number.isFinite(body?.anno) ? Number(body.anno) : ANNO_RIFERIMENTO;
    const clearFirst = !!body?.clear_first;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceKey) {
      return fail(req, 500, "MISSING_CONFIG", "Service role not configured", debugId);
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    if (clearFirst) {
      const { error: delErr } = await supabase
        .from("istat_comuni")
        .delete()
        .ilike("regione", "Veneto");
      if (delErr) console.warn(`[istat-sdmx] clear error: ${delErr.message}`);
    }

    const summary: Array<{ provincia: string; observations: number; comuni: number; inserted: number; errors: number }> = [];

    for (const ith of provinces) {
      const sigla = ITH_TO_PROVINCIA[ith] ?? ith;
      const obs = await fetchSdmxProvincia(ith, anno);
      const rows = aggregaPerComune(obs, sigla, anno);

      let inserted = 0;
      let errors = 0;

      // Upsert on codice_istat so monthly re-runs do not fail UNIQUE.
      for (let i = 0; i < rows.length; i += BATCH_INSERT) {
        const batch = rows.slice(i, i + BATCH_INSERT);
        const { error } = await supabase
          .from("istat_comuni")
          .upsert(batch, { onConflict: "codice_istat" });
        if (error) {
          console.error(`[istat-sdmx] ${sigla} batch ${i}: ${error.message}`);
          errors += batch.length;
        } else {
          inserted += batch.length;
        }
      }

      summary.push({ provincia: sigla, observations: obs.length, comuni: rows.length, inserted, errors });
    }

    const totals = summary.reduce(
      (acc, s) => ({
        observations: acc.observations + s.observations,
        comuni: acc.comuni + s.comuni,
        inserted: acc.inserted + s.inserted,
        errors: acc.errors + s.errors,
      }),
      { observations: 0, comuni: 0, inserted: 0, errors: 0 },
    );

    const okRun = totals.inserted > 0 || totals.comuni > 0;
    await writeSourceRegistryStatus(supabase, "F2", {
      ok: okRun,
      records: totals.inserted || totals.comuni,
      error: okRun ? null : "istat_sdmx_zero_rows",
    });

    return ok(
      req,
      {
        anno,
        clear_first: clearFirst,
        provinces: summary,
        totals,
        records_processed: totals.inserted || totals.comuni,
        notes: [
          "Fonte: ISTAT SDMX REST 2.1 — DCIS_POPRES1 (popolazione residente al 1° gennaio).",
          "Percentuali calcolate da popolazione totale per età (sesso=Totale).",
          "Indice di vecchiaia = (over65 / under15) * 100.",
        ],
      },
      okRun ? [] : ["ISTAT SDMX returned 0 rows; last_error written on F2."],
      debugId,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[istat-sdmx] fatal debug_id=${debugId}: ${msg}`);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (supabaseUrl && serviceKey) {
        await writeSourceRegistryStatus(createClient(supabaseUrl, serviceKey), "F2", {
          ok: false,
          records: 0,
          error: msg.slice(0, 500),
        });
      }
    } catch { /* registry write is best-effort */ }
    return fail(req, 500, "FETCH_ERROR", `Import failed. Reference: ${debugId}`, debugId);
  }
});
