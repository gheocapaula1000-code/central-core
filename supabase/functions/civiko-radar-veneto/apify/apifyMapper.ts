// Normalizes Apify dataset items to internal shape.
// Rejects records without source_url, flagged as demo/mock/seed,
// or carrying obvious personal data.

import type { ApifySourceBinding } from "./apifySourceRegistry.ts";

export interface NormalizedRecord {
  source_url: string;
  title: string | null;
  content: string | null;
  hash: string;
  data_basis: "real" | "partial";
}

const DEMO_RX = /\b(demo|mock|seed|lorem ipsum|esempio fittizio|test data)\b/i;
const PERSONAL_RX = /\b(codice fiscale|c\.f\.|cf:|p\.iva|partita iva|email:|telefono:|cellulare:|cell\.\s*\d)\b/i;

async function sha1(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  if (!Array.isArray(items)) {
    return { records: [], rejected: [{ reason: "dataset_not_array", count: 0 }], warnings: ["dataset_not_array"] };
  }

  let unmappable = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== "object") { reasons.set("not_object", (reasons.get("not_object") ?? 0) + 1); continue; }
    const r = raw as Record<string, unknown>;
    const source_url = String(r.url ?? r.source_url ?? r.loadedUrl ?? "").trim();
    const title = (r.title ?? (r.metadata && (r.metadata as any)?.title) ?? null) as string | null;
    const content = (r.markdown ?? r.text ?? r.html ?? null) as string | null;

    if (!source_url || !/^https?:\/\//i.test(source_url)) {
      reasons.set("missing_source_url", (reasons.get("missing_source_url") ?? 0) + 1);
      continue;
    }
    const blob = `${title ?? ""}\n${content ?? ""}`;
    if (DEMO_RX.test(blob)) {
      reasons.set("demo_mock_seed", (reasons.get("demo_mock_seed") ?? 0) + 1);
      continue;
    }
    if (PERSONAL_RX.test(blob)) {
      reasons.set("personal_data", (reasons.get("personal_data") ?? 0) + 1);
      continue;
    }
    const hash = await sha1(source_url);
    if (seen.has(hash)) {
      reasons.set("duplicate", (reasons.get("duplicate") ?? 0) + 1);
      continue;
    }
    seen.add(hash);

    if (!title && !content) unmappable++;

    out.push({
      source_url,
      title: title ? String(title).slice(0, 500) : null,
      content: content ? String(content).slice(0, 20_000) : null,
      hash,
      data_basis: title && content ? "real" : "partial",
    });
  }

  if (unmappable > 0) warnings.push(`unmappable_records:${unmappable}`);

  return {
    records: out,
    rejected: Array.from(reasons.entries()).map(([reason, count]) => ({ reason, count })),
    warnings,
  };
}
