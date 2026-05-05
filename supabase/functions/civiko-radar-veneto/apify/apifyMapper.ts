// Normalizes Apify dataset items to internal shape.
// Rejects records without source_url, flagged as demo/mock/seed,
// or carrying obvious personal data. Adds classification and quality filter
// for Open Data Veneto-style sources.

import type { ApifySourceBinding } from "./apifySourceRegistry.ts";

export type RecordClassification =
  | "dataset"
  | "dataset_index"
  | "organization"
  | "resource"
  | "document"
  | "irrelevant"
  | "rejected_login"
  | "rejected_profile"
  | "rejected_noise";

export interface NormalizedRecord {
  source_url: string;
  title: string | null;
  content: string | null;
  hash: string;
  data_basis: "real" | "partial";
  classification: RecordClassification;
  importable: boolean;
  reject_reason?: string;
  resource_urls?: string[];
  formats?: string[];
  download_urls?: string[];
  organization?: string | null;
  groups?: string[];
  tags?: string[];
  license?: string | null;
  updated_at?: string | null;
  published_at?: string | null;
  quality?: "high" | "medium" | "low";
}

const DEMO_RX = /\b(demo|mock|seed|lorem ipsum|esempio fittizio|test data)\b/i;
const PERSONAL_RX = /\b(codice fiscale|c\.f\.|cf:|p\.iva|partita iva|email:|telefono:|cellulare:|cell\.\s*\d)\b/i;

const NOISE_URL_RX = /\/(user|login|register|signin|signup|password|comment|comment-form|privacy|cookie|contatti|contact|search|admin|node\/\d+#?comment)/i;
const PROFILE_TITLE_RX = /\b(profilo utente|user profile|accedi|login|registrati|register|password dimenticata)\b/i;

const DATASET_URL_RX = /\/(dataset|resource|download|organization|group|catalog|catalogue|api\/3)/i;
const DOC_EXT_RX = /\.(csv|tsv|json|geojson|shp|zip|xls|xlsx|ods|pdf|xml|kml|kmz|wms|wfs)(\?|$)/i;
const TOPIC_RX = /\b(dataset|resource|download|csv|tsv|shp|geojson|json|xls|xlsx|pdf|kml|wms|wfs|open\s*data|metadati|urbanistica|ambiente|mobilit[aà]|edifici|strade|parcheggi|rumore|aria|geoportale|catasto|territorio|popolazione)\b/i;

async function sha1(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function classify(url: string, title: string | null, content: string | null): RecordClassification {
  if (NOISE_URL_RX.test(url)) {
    if (/\/(login|signin|signup|register|password)/i.test(url)) return "rejected_login";
    if (/\/user(\/|$)/i.test(url)) return "rejected_profile";
    return "rejected_noise";
  }
  if (title && PROFILE_TITLE_RX.test(title)) {
    return /profilo|profile|user/i.test(title) ? "rejected_profile" : "rejected_login";
  }
  if (DOC_EXT_RX.test(url)) return "document";
  if (/\/resource(\/|$)/i.test(url)) return "resource";
  if (/\/organization(\/|$)/i.test(url)) return "organization";
  if (/\/dataset\/[^\/?#]+/i.test(url)) return "dataset";
  if (/\/dataset\/?($|\?)/i.test(url) || /\/group(\/|$)/i.test(url) || /\/catalog/i.test(url)) return "dataset_index";
  const blob = `${title ?? ""}\n${content ?? ""}`;
  if (TOPIC_RX.test(blob) || DATASET_URL_RX.test(url)) return "dataset_index";
  return "irrelevant";
}

export interface MapResult {
  records: NormalizedRecord[];
  rejected: { reason: string; count: number }[];
  warnings: string[];
}

export async function mapApifyDataset(items: unknown[], _binding: ApifySourceBinding): Promise<MapResult> {
  const out: NormalizedRecord[] = [];
  const reasons = new Map<string, number>();
  const warnings: string[] = [];
  const seen = new Set<string>();
  const bump = (k: string) => reasons.set(k, (reasons.get(k) ?? 0) + 1);

  if (!Array.isArray(items)) {
    return { records: [], rejected: [{ reason: "dataset_not_array", count: 0 }], warnings: ["dataset_not_array"] };
  }

  let unmappable = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== "object") { bump("not_object"); continue; }
    const r = raw as Record<string, unknown>;
    const source_url = String(r.url ?? r.source_url ?? r.loadedUrl ?? "").trim();
    const title = (r.title ?? (r.metadata && (r.metadata as any)?.title) ?? null) as string | null;
    const content = (r.markdown ?? r.text ?? r.description ?? r.html ?? null) as string | null;

    if (!source_url || !/^https?:\/\//i.test(source_url)) { bump("missing_source_url"); continue; }

    const blob = `${title ?? ""}\n${content ?? ""}`;
    if (DEMO_RX.test(blob)) { bump("demo_mock_seed"); continue; }
    if (PERSONAL_RX.test(blob)) { bump("personal_data"); continue; }

    const hash = await sha1(source_url);
    if (seen.has(hash)) { bump("duplicate"); continue; }
    seen.add(hash);

    if (!title && !content) unmappable++;

    const classification = classify(source_url, title, content);

    // Extract structured fields when present (cheerio-scraper output or wcc with structured data).
    const arrField = (k: string): string[] => {
      const v = (r as any)[k];
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
      return [];
    };
    const resource_urls = arrField("resource_urls");
    const download_urls = arrField("download_urls");
    let formats = arrField("formats").map((f) => f.toLowerCase());
    if (formats.length === 0) {
      const fromUrls = [...resource_urls, ...download_urls, source_url]
        .map((u) => (u.match(/\.(csv|tsv|json|geojson|shp|zip|xls|xlsx|pdf|kml|kmz|xml|wms|wfs)(\?|$)/i)?.[1] || "").toLowerCase())
        .filter(Boolean);
      formats = Array.from(new Set(fromUrls));
    }
    const tags = arrField("tags");
    const groups = arrField("groups");
    const organization = (r as any).organization ? String((r as any).organization).slice(0, 200) : null;
    const license = (r as any).license ? String((r as any).license).slice(0, 200) : null;
    const updated_at = (r as any).updated_at ? String((r as any).updated_at).slice(0, 100) : null;
    const published_at = (r as any).published_at ? String((r as any).published_at).slice(0, 100) : null;

    let importable = true;
    let reject_reason: string | undefined;
    if (classification === "rejected_login") { importable = false; reject_reason = "login_page"; bump("login_page"); }
    else if (classification === "rejected_profile") { importable = false; reject_reason = "profile_page"; bump("profile_page"); }
    else if (classification === "rejected_noise") { importable = false; reject_reason = "noise_url"; bump("noise_url"); }
    else if (classification === "irrelevant") {
      if (!TOPIC_RX.test(blob) && !DATASET_URL_RX.test(source_url) && !DOC_EXT_RX.test(source_url)) {
        importable = false; reject_reason = "off_topic"; bump("off_topic");
      }
    }

    const quality: "high" | "medium" | "low" =
      classification === "dataset" || classification === "resource" || classification === "document"
        ? (resource_urls.length > 0 || download_urls.length > 0 || formats.length > 0 ? "high" : "medium")
        : classification === "dataset_index" ? "low" : "low";

    out.push({
      source_url,
      title: title ? String(title).slice(0, 500) : null,
      content: content ? String(content).slice(0, 20_000) : null,
      hash,
      data_basis: title && content ? "real" : "partial",
      classification,
      importable,
      reject_reason,
      resource_urls: resource_urls.length ? resource_urls.slice(0, 50) : undefined,
      download_urls: download_urls.length ? download_urls.slice(0, 50) : undefined,
      formats: formats.length ? formats.slice(0, 20) : undefined,
      organization,
      groups: groups.length ? groups.slice(0, 20) : undefined,
      tags: tags.length ? tags.slice(0, 30) : undefined,
      license,
      updated_at,
      published_at,
      quality,
    });
  }

  if (unmappable > 0) warnings.push(`unmappable_records:${unmappable}`);

  return {
    records: out,
    rejected: Array.from(reasons.entries()).map(([reason, count]) => ({ reason, count })),
    warnings,
  };
}
