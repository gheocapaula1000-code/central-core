// CKAN open-data importer for dati.veneto.it (and compatible CKAN portals).
// Saves matching datasets into source_documents and registers the source.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface CkanRunOpts {
  baseUrl?: string;
  keywords: string[];
  province: string[];
  dryRun: boolean;
  import: boolean;
  maxPerKeyword?: number;
  sourceName?: string;
  requireGeoMatch?: boolean;
  territorialSignalType?: string;
}

export interface CkanRunReport {
  ok: boolean;
  base_url: string;
  keywords_used: string[];
  datasets_found: number;
  datasets_relevant: number;
  documents_saved: number;
  territorial_signals_created: number;
  errors: string[];
  samples: Array<{ name: string; url: string; format?: string; comune?: string; provincia?: string }>;
}

function getSupa() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function ckanSearch(baseUrl: string, q: string, rows = 25): Promise<{ results: any[]; ok: boolean; err?: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=${rows}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!res.ok) return { results: [], ok: false, err: `HTTP ${res.status}` };
    const data = await res.json();
    return { results: Array.isArray(data?.result?.results) ? data.result.results : [], ok: true };
  } catch (e) {
    return { results: [], ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

const VENETO_PROV_RE = /(venezia|verona|vicenza|padova|treviso|belluno|rovigo|veneto|\bve\b|\bvr\b|\bvi\b|\bpd\b|\btv\b|\bbl\b|\bro\b)/i;

const PADOVA_GEO_RE = /padova|\bpd\b|padovan/i;

export async function runVenetoOpenDataImport(opts: CkanRunOpts): Promise<CkanRunReport> {
  const baseUrl = opts.baseUrl ?? "https://dati.veneto.it";
  const sourceName = opts.sourceName ?? "open_data_veneto_ckan";
  const signalType = opts.territorialSignalType ?? "open_data_dataset";
  const supa = getSupa();
  const report: CkanRunReport = {
    ok: false, base_url: baseUrl, keywords_used: opts.keywords,
    datasets_found: 0, datasets_relevant: 0, documents_saved: 0,
    territorial_signals_created: 0,
    errors: [], samples: [],
  };
  if (!supa) { report.errors.push("supabase service role missing"); return report; }

  const seen = new Set<string>();
  const toSave: Array<Record<string, unknown>> = [];

  for (const kw of opts.keywords) {
    const r = await ckanSearch(baseUrl, kw, opts.maxPerKeyword ?? 25);
    if (!r.ok) { report.errors.push(`ckan ${kw}: ${r.err}`); continue; }
    report.datasets_found += r.results.length;
    for (const ds of r.results) {
      const id = String(ds?.id ?? ds?.name ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title: string = String(ds?.title ?? ds?.name ?? "");
      const notes: string = String(ds?.notes ?? "");
      const text = `${title}\n${notes}`.toLowerCase();
      const isVeneto = VENETO_PROV_RE.test(text) || true; // dati.veneto.it è già regionale
      if (!isVeneto) continue;
      if (opts.requireGeoMatch && !PADOVA_GEO_RE.test(text)) continue;
      report.datasets_relevant++;
      const url = `${baseUrl.replace(/\/$/, "")}/dataset/${ds?.name ?? id}`;
      const resources: any[] = Array.isArray(ds?.resources) ? ds.resources : [];
      const primaryFmt = (resources[0]?.format ?? resources[0]?.mimetype ?? "unknown").toString().toLowerCase();
      const provGuess = (text.match(/\b(ve|vr|vi|pd|tv|bl|ro)\b/i)?.[1] ?? "").toUpperCase() || null;
      report.samples.push({ name: title, url, format: primaryFmt, provincia: provGuess ?? undefined });
      toSave.push({
        source_name: sourceName,
        source_type: "open_data",
        source_url: url,
        title: title.slice(0, 500),
        text_excerpt: notes.slice(0, 1000),
        classification: `ckan_${primaryFmt}`,
        extracted_entities: { resources: resources.slice(0, 5).map((rs) => ({ name: rs?.name, url: rs?.url, format: rs?.format })) },
        provincia: provGuess,
        relevance_score: 70,
        confidence_score: 80,
        importability: ["csv","geojson","json","shp"].includes(primaryFmt),
        import_reason: "perplexity_open_data",
        quality: "reale",
        data_basis: sourceName === "anac_ckan" ? "anac_ckan" : "open_data_veneto",
      });
    }
  }

  if (!opts.dryRun && opts.import && toSave.length) {
    // Upsert source_documents by source_url
    for (let i = 0; i < toSave.length; i += 100) {
      const chunk = toSave.slice(i, i + 100);
      const { error } = await supa.from("source_documents").upsert(chunk, { onConflict: "source_url", ignoreDuplicates: false });
      if (error) { report.errors.push(`upsert: ${error.message}`); break; }
      report.documents_saved += chunk.length;
    }

    const sigRows = toSave.map((row) => ({
      fingerprint: `ckan:${sourceName}:${String(row.source_url ?? "")}`.slice(0, 240),
      source_name: sourceName,
      signal_type: signalType,
      province: (row.provincia as string | null) ?? "PD",
      municipality: PADOVA_GEO_RE.test(`${row.title ?? ""} ${row.text_excerpt ?? ""}`) ? "Padova" : null,
      title: String(row.title ?? "").slice(0, 240) || null,
      description: String(row.text_excerpt ?? "").slice(0, 1000) || null,
      data_basis: String(row.data_basis ?? sourceName),
      quality: "parziale",
      source_url: row.source_url,
      is_active: true,
      confidence_score: Number(row.confidence_score ?? 70),
      impact_direction: "neutral",
      impact_strength: 0.3,
      payload: { classification: row.classification, extracted_entities: row.extracted_entities },
    }));
    for (let i = 0; i < sigRows.length; i += 100) {
      const chunk = sigRows.slice(i, i + 100);
      const { error, count } = await supa.from("territorial_signals").upsert(chunk, {
        onConflict: "fingerprint",
        ignoreDuplicates: false,
        count: "exact",
      });
      if (error) { report.errors.push(`territorial_signals:${error.message}`); break; }
      report.territorial_signals_created += count ?? chunk.length;
    }
  }

  // Register source if missing
  if (!opts.dryRun) {
    await supa.from("data_sources").upsert({
      source_name: sourceName,
      source_type: "open_data",
      base_url: baseUrl,
      coverage_area: "veneto",
      province: opts.province,
      ingestion_method: "ckan",
      ingestion_status: "ready",
      reliability_score: 92,
      freshness_score: 75,
      allowed_use: "open_data",
      quality_default: "reale",
      last_run_at: new Date().toISOString(),
    }, { onConflict: "source_name" });
  }

  report.ok = true;
  report.samples = report.samples.slice(0, 10);
  return report;
}
