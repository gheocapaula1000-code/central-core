// Open Data Veneto deep importer.
// Uses CKAN API at dati.veneto.it/SpodCkanApi as primary source; falls back to Apify
// (apify/website-content-crawler) only if CKAN endpoints fail.
// Never invents data; never bypasses login/CAPTCHA. Robots.txt-friendly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { VENETO_COMUNI } from "./venetoComuni.ts";

const CKAN_BASES = [
  "https://dati.veneto.it/SpodCkanApi",
];

export type Topic =
  | "urbanistica" | "ambiente" | "mobilita" | "servizi" | "edifici"
  | "strade" | "scuole" | "geoportale" | "patrimonio" | "vincoli" | "altro";

export type Classification = "dataset" | "resource" | "geo_resource" | "csv_resource" | "document_resource";

export interface NormalizedOpenDataRecord {
  source_name: "Open Data Veneto";
  source_url: string;
  dataset_id: string;
  dataset_title: string | null;
  dataset_notes: string | null;
  organization: string | null;
  groups: string[];
  tags: string[];
  license: string | null;
  metadata_created: string | null;
  metadata_modified: string | null;
  resource_id: string | null;
  resource_name: string | null;
  resource_url: string | null;
  resource_format: string | null;
  resource_mimetype: string | null;
  resource_description: string | null;
  classification: Classification;
  topic: Topic;
  comune: string | null;
  provincia: string | null;
  quality: "reale" | "parziale";
  confidence_score: number;
  data_basis: string[];
  importable: boolean;
  reject_reason?: string;
  geo_fixed?: boolean;
  regional_scope?: boolean;
  hash: string;
}

export interface DeepImportReport {
  ok: boolean;
  api_mode: "ckan" | "apify_fallback" | "mixed" | "none";
  base_url: string;
  keywords_used: string[];
  packages_found: number;
  resources_found: number;
  records_normalized: number;
  records_importable: number;
  records_importable_dataset: number;
  records_importable_resource: number;
  records_rejected_count: number;
  records_rejected: { reason: string; count: number }[];
  records_rejected_sample: Array<{ source_url: string; dataset_title: string | null; reject_reason?: string }>;
  sample_importable_records: Array<{
    dataset_title: string | null;
    resource_format: string | null;
    resource_url: string | null;
    classification: Classification;
    topic: Topic;
    comune: string | null;
    provincia: string | null;
  }>;
  records_imported: number;
  skipped_existing: number;
  territorial_signals_created: number;
  geo_inference_fixed_count: number;
  records_topic_vincoli: number;
  records_regional_scope: number;
  warnings: string[];
  errors: string[];
}

const SUPPORTED_FORMATS = new Set([
  "CSV", "TSV", "JSON", "GEOJSON", "SHP", "ZIP", "XLS", "XLSX", "ODS",
  "PDF", "XML", "KML", "KMZ", "WMS", "WFS", "HTML", "API",
]);

const TOPIC_RX: Array<{ topic: Topic; rx: RegExp }> = [
  { topic: "vincoli",      rx: /\b(vincol|regime\s+di\s+vincolo|ambiti\s+sottopost|tutela|paesaggistic|idrogeologic|sismic|fasce\s+di?\s*rispetto|piano\s+(di\s+)?assett|pianificazione\s+e\s+vincoli)\b/i },
  { topic: "urbanistica",  rx: /\b(urbanistic|piano\s*(degli\s*)?intervent|p\.?i\.?\s|prg|pat\b|pati\b|regolamento\s+edilizio|destinazion\s+uso|zonizzazion)\b/i },
  { topic: "ambiente",     rx: /\b(ambient|aria|qualit[aà]\s+aria|rumore|acustic|ARPAV|inquinament|verd|parchi|natura|emission)\b/i },
  { topic: "mobilita",     rx: /\b(mobilit|trasport|traffic|ciclabil|tpl|autobus|treno|stazion|porto|aeroport|parcheggi)\b/i },
  { topic: "scuole",       rx: /\b(scuol|istitut|asilo|nido|infanz|liceo|universit)\b/i },
  { topic: "edifici",      rx: /\b(edific|fabbricat|immobil|patrimonio\s+immobil|catastale|catasto)\b/i },
  { topic: "strade",       rx: /\b(strad|viabilit|via\s|civic|toponom|numeri\s+civic)\b/i },
  { topic: "geoportale",   rx: /\b(geoportal|cartograf|wms|wfs|shapefile|geojson|kml|kmz|raster|ortofoto)\b/i },
  { topic: "patrimonio",   rx: /\b(patrimoni|alienazion|beni\s+pubblic|demanio|asta\s+pubblica)\b/i },
  { topic: "servizi",      rx: /\b(servizi\s+pubblic|sociali|sanitari|farmaci|biblioteche|sport)\b/i },
];

function classifyTopic(text: string): Topic {
  for (const { topic, rx } of TOPIC_RX) if (rx.test(text)) return topic;
  return "altro";
}

const VENETO_PROV_FULL: Record<string, string> = {
  venezia: "VE", verona: "VR", vicenza: "VI", padova: "PD", treviso: "TV", belluno: "BL", rovigo: "RO",
};
const VENETO_PROV_RX = /\b(venezia|verona|vicenza|padova|treviso|belluno|rovigo)\b/i;

// Stop-words that frequently appear after "Comune di X" but are NOT part of the comune name.
const STOPWORDS = new Set([
  "si","no","trattasi","anni","anno","dataset","regione","pubblica","pubblico","privato",
  "del","della","dei","delle","degli","di","da","in","su","con","per","tra","fra","e","ed","o",
  "che","come","sono","sia","stato","stata","è","ha","ho","la","il","lo","gli","le","un","una","uno",
  "comprende","contiene","relativo","relativa","relativi","relative","include","comprendente",
  "anagrafica","elenco","lista","mappa","mappe","dati","informazioni","servizio","servizi",
  "via","piazza","corso","viale","strada","località",
]);

// Build comune name lookup: lowercased -> canonical "Title Case".
const COMUNE_LOOKUP: Map<string, { name: string; provincia: string }> = new Map();
for (const [name, prov] of Object.entries(VENETO_COMUNI)) {
  COMUNE_LOOKUP.set(name.toLowerCase(), { name, provincia: prov });
}

const COMUNE_RX = /\bComune\s+(?:di|della|del|dello|dei|delle|degli)\s+([A-ZÀ-Ý][\wÀ-ÿ'’\-]+(?:\s+[A-ZÀ-Ý'][\wÀ-ÿ'’\-]+){0,4})/;

function cleanComuneName(raw: string): string | null {
  if (!raw) return null;
  // Strip trailing punctuation/dashes
  const tokens = raw.replace(/[\.,;:\-–—]+/g, " ").split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (STOPWORDS.has(low)) break;
    // stop on lowercase token (likely a sentence continuation, not comune part)
    if (kept.length > 0 && /^[a-zà-ÿ]/.test(tok)) break;
    kept.push(tok);
    if (kept.length >= 4) break;
  }
  if (kept.length === 0) return null;
  // Try progressive shrink: longest match wins against lookup
  for (let n = kept.length; n >= 1; n--) {
    const candidate = kept.slice(0, n).join(" ");
    const hit = COMUNE_LOOKUP.get(candidate.toLowerCase());
    if (hit) return hit.name;
  }
  // Fallback: return cleaned candidate Title-cased (still better than dirty)
  return kept.join(" ");
}

function lookupProvinciaFromComune(comune: string | null): string | null {
  if (!comune) return null;
  const hit = COMUNE_LOOKUP.get(comune.toLowerCase());
  return hit ? hit.provincia : null;
}

function inferComuneFromTitle(text: string): string | null {
  const m = text.match(COMUNE_RX);
  if (!m) return null;
  return cleanComuneName(m[1]);
}

function inferGeo(text: string): { comune: string | null; provincia: string | null; fixed: boolean } {
  let provincia: string | null = null;
  const pm = text.toLowerCase().match(VENETO_PROV_RX);
  if (pm) provincia = VENETO_PROV_FULL[pm[1]] ?? null;

  const comune = inferComuneFromTitle(text);
  let fixed = false;
  if (comune) {
    const looked = lookupProvinciaFromComune(comune);
    if (looked) { provincia = looked; fixed = true; }
  }
  return { comune, provincia, fixed };
}

const NOISE_URL_RX = /\/(user|login|register|signin|signup|password|comment|comment-form|privacy|cookie|contatti|contact|search|admin)/i;

async function sha1(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getSupa() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function ckanCall(base: string, action: string, params: Record<string, string | number>): Promise<any | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `${base.replace(/\/$/, "")}/api/3/action/${action}?${qs.toString()}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", "User-Agent": "CivikoCore/1.0" } });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.success !== true) return null;
    return data.result;
  } catch { return null; }
}

function classifyResource(format: string | null, url: string | null): Classification {
  const f = (format ?? "").toUpperCase();
  if (!url) return "dataset";
  if (["SHP", "GEOJSON", "KML", "KMZ", "WMS", "WFS"].includes(f)) return "geo_resource";
  if (["CSV", "TSV", "XLS", "XLSX", "ODS", "JSON"].includes(f)) return "csv_resource";
  if (["PDF", "XML", "ZIP", "HTML"].includes(f)) return "document_resource";
  return "resource";
}

function pkgUrl(base: string, name: string): string {
  // Public dataset page (not API) for source_url field.
  return `https://dati.veneto.it/opendata/${encodeURIComponent(name)}`;
}

async function normalizePackage(base: string, pkg: any): Promise<NormalizedOpenDataRecord[]> {
  const out: NormalizedOpenDataRecord[] = [];
  const dataset_id = String(pkg?.id ?? pkg?.name ?? "").trim();
  if (!dataset_id) return out;
  const dataset_title = (pkg?.title ?? null) as string | null;
  const dataset_notes = (pkg?.notes ?? null) as string | null;
  const organization = pkg?.organization?.title ?? pkg?.organization?.name ?? null;
  const groups = Array.isArray(pkg?.groups) ? pkg.groups.map((g: any) => g?.title || g?.name).filter(Boolean) : [];
  const tags = Array.isArray(pkg?.tags) ? pkg.tags.map((t: any) => t?.display_name || t?.name).filter(Boolean) : [];
  const license = pkg?.license_title ?? pkg?.license_id ?? null;
  const metadata_created = pkg?.metadata_created ?? null;
  const metadata_modified = pkg?.metadata_modified ?? null;
  const text = `${dataset_title ?? ""} ${dataset_notes ?? ""} ${tags.join(" ")} ${groups.join(" ")} ${organization ?? ""}`;
  const topic = classifyTopic(text);
  const { comune, provincia } = inferGeo(text);
  const datasetSourceUrl = pkgUrl(base, pkg?.name ?? dataset_id);

  const baseRec: Omit<NormalizedOpenDataRecord, "resource_id"|"resource_name"|"resource_url"|"resource_format"|"resource_mimetype"|"resource_description"|"classification"|"hash"|"importable"|"source_url"> = {
    source_name: "Open Data Veneto",
    dataset_id, dataset_title, dataset_notes,
    organization, groups, tags, license,
    metadata_created, metadata_modified,
    topic, comune, provincia,
    quality: dataset_title ? "reale" : "parziale",
    confidence_score: dataset_title ? 0.7 : 0.4,
    data_basis: ["open_data_veneto", "ckan_api"],
  };

  // Always emit a dataset-level record.
  out.push({
    ...baseRec,
    source_url: datasetSourceUrl,
    resource_id: null, resource_name: null, resource_url: null,
    resource_format: null, resource_mimetype: null, resource_description: null,
    classification: "dataset",
    importable: true,
    hash: await sha1(`pkg:${dataset_id}`),
  });

  // Resource-level records.
  const resources = Array.isArray(pkg?.resources) ? pkg.resources : [];
  for (const r of resources) {
    const resource_url = (r?.url ?? null) as string | null;
    const resource_format = (r?.format ?? null) as string | null;
    const cls = classifyResource(resource_format, resource_url);
    out.push({
      ...baseRec,
      source_url: resource_url || datasetSourceUrl,
      resource_id: r?.id ?? null,
      resource_name: r?.name ?? null,
      resource_url,
      resource_format: resource_format ? String(resource_format).toUpperCase() : null,
      resource_mimetype: r?.mimetype ?? null,
      resource_description: r?.description ?? null,
      classification: cls,
      importable: true,
      hash: await sha1(`res:${dataset_id}:${r?.id ?? resource_url ?? Math.random()}`),
    });
  }
  return out;
}

function applyQualityFilters(rec: NormalizedOpenDataRecord): NormalizedOpenDataRecord {
  if (!rec.source_url || !/^https?:\/\//i.test(rec.source_url)) {
    return { ...rec, importable: false, reject_reason: "no_resource_url" };
  }
  if (NOISE_URL_RX.test(rec.source_url)) {
    return { ...rec, importable: false, reject_reason: "login_profile" };
  }
  if (!rec.dataset_title) return { ...rec, importable: false, reject_reason: "missing_title" };
  if (rec.classification !== "dataset") {
    const f = (rec.resource_format ?? "").toUpperCase();
    if (!f || !SUPPORTED_FORMATS.has(f)) return { ...rec, importable: false, reject_reason: "unsupported_format" };
  }
  if (rec.topic === "altro") {
    return { ...rec, importable: false, reject_reason: "off_topic" };
  }
  return rec;
}

const TOPIC_TO_SIGNAL_TYPE: Partial<Record<Topic, string>> = {
  urbanistica: "urban_planning_dataset",
  ambiente: "environment_dataset",
  mobilita: "mobility_dataset",
  servizi: "public_services_dataset",
  edifici: "buildings_dataset",
  strade: "roads_dataset",
  scuole: "schools_dataset",
  geoportale: "geoportal_dataset",
  patrimonio: "public_assets_dataset",
};

export async function runOpenDataVenetoDeepImport(opts: {
  dryRun: boolean;
  import: boolean;
  limitPerKeyword?: number;
  keywords?: string[];
}): Promise<DeepImportReport> {
  const keywords = (opts.keywords && opts.keywords.length > 0)
    ? opts.keywords
    : ["urbanistica","territorio","mobilità","ambiente","scuole","parcheggi","edifici","strade","geoportale","shp","csv","geojson"];
  const limit = Math.max(1, Math.min(50, opts.limitPerKeyword ?? 20));

  const report: DeepImportReport = {
    ok: false,
    api_mode: "none",
    base_url: CKAN_BASES[0],
    keywords_used: keywords,
    packages_found: 0,
    resources_found: 0,
    records_normalized: 0,
    records_importable: 0,
    records_importable_dataset: 0,
    records_importable_resource: 0,
    records_rejected_count: 0,
    records_rejected: [],
    records_rejected_sample: [],
    sample_importable_records: [],
    records_imported: 0,
    skipped_existing: 0,
    territorial_signals_created: 0,
    warnings: [],
    errors: [],
  };

  // Try CKAN first.
  const base = CKAN_BASES[0];
  const seenPkgIds = new Set<string>();
  const allPackages: any[] = [];
  let ckanWorked = false;
  for (const kw of keywords) {
    const result = await ckanCall(base, "package_search", { q: kw, rows: limit });
    if (!result) { report.warnings.push(`ckan_keyword_failed:${kw}`); continue; }
    ckanWorked = true;
    const results = Array.isArray(result.results) ? result.results : [];
    for (const pkg of results) {
      const id = String(pkg?.id ?? "");
      if (!id || seenPkgIds.has(id)) continue;
      seenPkgIds.add(id);
      allPackages.push(pkg);
    }
  }
  report.api_mode = ckanWorked ? "ckan" : "none";
  report.packages_found = allPackages.length;

  if (!ckanWorked) {
    report.errors.push("ckan_unavailable_apify_fallback_not_implemented_in_this_job");
    // We intentionally do NOT spin up Apify here for a deep CKAN-style discovery;
    // if needed, run /jobs/apify-run-veneto-source separately.
    return report;
  }

  // Normalize.
  const normalized: NormalizedOpenDataRecord[] = [];
  for (const pkg of allPackages) {
    const recs = await normalizePackage(base, pkg);
    for (const r of recs) normalized.push(applyQualityFilters(r));
  }
  // Dedupe by hash.
  const byHash = new Map<string, NormalizedOpenDataRecord>();
  for (const r of normalized) if (!byHash.has(r.hash)) byHash.set(r.hash, r);
  const records = Array.from(byHash.values());
  report.records_normalized = records.length;
  report.resources_found = records.filter((r) => r.classification !== "dataset").length;

  const importable = records.filter((r) => r.importable);
  const rejected = records.filter((r) => !r.importable);
  report.records_importable = importable.length;
  report.records_importable_dataset = importable.filter((r) => r.classification === "dataset").length;
  report.records_importable_resource = importable.filter((r) => r.classification !== "dataset").length;
  report.records_rejected_count = rejected.length;
  const reasonCounts = new Map<string, number>();
  for (const r of rejected) reasonCounts.set(r.reject_reason ?? "unknown", (reasonCounts.get(r.reject_reason ?? "unknown") ?? 0) + 1);
  report.records_rejected = Array.from(reasonCounts.entries()).map(([reason, count]) => ({ reason, count }));
  report.records_rejected_sample = rejected.slice(0, 5).map((r) => ({
    source_url: r.source_url, dataset_title: r.dataset_title, reject_reason: r.reject_reason,
  }));
  report.sample_importable_records = importable.slice(0, 10).map((r) => ({
    dataset_title: r.dataset_title,
    resource_format: r.resource_format,
    resource_url: r.resource_url,
    classification: r.classification,
    topic: r.topic,
    comune: r.comune,
    provincia: r.provincia,
  }));

  const doImport = opts.import === true && opts.dryRun === false;
  if (!doImport) {
    report.warnings.push("import_skipped_test_mode");
    report.ok = report.errors.length === 0;
    return report;
  }

  const supa = getSupa();
  if (!supa) { report.errors.push("supabase_not_configured"); return report; }

  // Cap real import to 50 records max.
  const toImport = importable.slice(0, 50);
  const urls = toImport.map((r) => r.source_url);
  const { data: existing } = await supa
    .from("source_documents")
    .select("source_url")
    .in("source_url", urls);
  const existingSet = new Set((existing ?? []).map((r: any) => r.source_url));

  const rows = toImport
    .filter((r) => !existingSet.has(r.source_url))
    .map((r) => ({
      source_name: r.source_name,
      source_url: r.source_url,
      url: r.source_url,
      title: r.dataset_title ?? r.resource_name ?? null,
      text_excerpt: r.dataset_notes ?? r.resource_description ?? null,
      doc_type: r.classification,
      classification: r.classification,
      source_type: "open_data",
      comune: r.comune,
      provincia: r.provincia,
      content_hash: r.hash,
      raw_hash: r.hash,
      published_at: r.metadata_modified ? new Date(r.metadata_modified).toISOString() : null,
      metadata: {
        dataset_id: r.dataset_id,
        organization: r.organization,
        groups: r.groups,
        tags: r.tags,
        license: r.license,
        metadata_created: r.metadata_created,
        metadata_modified: r.metadata_modified,
        resource_id: r.resource_id,
        resource_format: r.resource_format,
        resource_mimetype: r.resource_mimetype,
        topic: r.topic,
      },
      extracted_entities: { topic: r.topic },
      relevance_score: r.confidence_score,
      confidence_score: r.confidence_score,
      importability: true,
      import_reason: "open_data_ckan_match",
      quality: r.quality,
      data_basis: r.data_basis.join(","),
    }));

  report.skipped_existing = toImport.length - rows.length;

  if (rows.length > 0) {
    const { error: insErr, count } = await supa.from("source_documents").insert(rows, { count: "exact" });
    if (insErr) { report.errors.push(`source_documents_insert:${insErr.message}`); }
    else report.records_imported = count ?? rows.length;
  }

  // Territorial signals: only for records with a known topic AND a deducible comune or provincia.
  const sigCandidates = toImport.filter((r) =>
    !existingSet.has(r.source_url) &&
    TOPIC_TO_SIGNAL_TYPE[r.topic] &&
    (r.comune || r.provincia)
  );
  if (sigCandidates.length > 0) {
    const sigRows: any[] = [];
    for (const r of sigCandidates) {
      const fp = await sha1(`tsig:${r.source_url}:${r.topic}`);
      sigRows.push({
        fingerprint: fp,
        source_name: r.source_name,
        signal_type: TOPIC_TO_SIGNAL_TYPE[r.topic]!,
        province: r.provincia,
        municipality: r.comune,
        title: r.dataset_title?.slice(0, 240) ?? null,
        description: (r.dataset_notes ?? r.resource_description ?? null)?.slice(0, 1000) ?? null,
        data_basis: r.data_basis.join(","),
        quality: r.quality,
        payload: {
          dataset_id: r.dataset_id,
          resource_url: r.resource_url,
          resource_format: r.resource_format,
          topic: r.topic,
          organization: r.organization,
        },
        is_active: true,
        signal_subtype: r.classification,
        impact_direction: "neutral",
        impact_strength: 0.3,
        source_url: r.source_url,
        confidence_score: r.confidence_score,
      });
    }
    // Dedupe against existing fingerprints.
    const fps = sigRows.map((r) => r.fingerprint);
    const { data: existSig } = await supa.from("territorial_signals").select("fingerprint").in("fingerprint", fps);
    const existFps = new Set((existSig ?? []).map((r: any) => r.fingerprint));
    const newSig = sigRows.filter((r) => !existFps.has(r.fingerprint));
    if (newSig.length > 0) {
      const { error: sigErr, count: sigCount } = await supa.from("territorial_signals").insert(newSig, { count: "exact" });
      if (sigErr) report.warnings.push(`territorial_signals_insert:${sigErr.message}`);
      else report.territorial_signals_created = sigCount ?? newSig.length;
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}
