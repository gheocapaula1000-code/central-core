// ═══════════════════════════════════════════════════════════════
// aggregateBucketGuard.ts — guardrail per bucket aggregati necrologi PII-free.
//
// Duplicato leggero delle costanti di inheritanceComplianceGuard perché
// le edge functions non possono importare da altre edge functions
// (solo da _shared/).
// ═══════════════════════════════════════════════════════════════

export const AGGREGATE_MIN_BUCKET_COUNT = 3;

const ALLOWED_AREA_TYPES = [
  "comune","cap","microzona","street_cluster","zona_omi","sezione_censuaria","quartiere",
];

const FORBIDDEN_TEXT_TOKENS = [
  "necrolog","obituar","lutto","luttuos","funeral","deceduto","deceduta",
  "defunto","defunta","decesso","morto","morta","onoranze","cimiter",
  "tomba","loculo","eredi ","erede ","famiglia ","famiglie ","vedov","orfan",
];

const CIVIC_NUMBER_RE =
  /\b(via|viale|piazza|piazzale|corso|vicolo|strada|largo|contrà)\s+[A-Za-zÀ-ÿ' .-]+\s*,?\s*\d+\b/i;

export interface AggregateBucketLike {
  area_type?: string | null;
  area_code?: string | null;
  bucket_count?: number | null;
  source_code?: string | null;
  source_url?: string | null;
  window_days?: number | null;
  [k: string]: unknown;
}

export interface ComplianceResult {
  allowed: boolean;
  violations: string[];
}

export function assertAggregateBucket(bucket: AggregateBucketLike): ComplianceResult {
  const violations: string[] = [];

  const area_type = String(bucket.area_type ?? "").toLowerCase();
  if (!area_type || !ALLOWED_AREA_TYPES.includes(area_type)) {
    violations.push(`forbidden_granularity:${area_type || "missing"}`);
  }
  if (!bucket.area_code || String(bucket.area_code).trim() === "") {
    violations.push("missing_area_code");
  }
  const count = Number(bucket.bucket_count);
  if (!Number.isFinite(count) || count < AGGREGATE_MIN_BUCKET_COUNT) {
    violations.push(`below_k_anonymity_threshold:${count}`);
  }

  for (const [k, v] of Object.entries(bucket)) {
    if (typeof v !== "string" || v.length === 0) continue;
    const lower = v.toLowerCase();
    for (const tok of FORBIDDEN_TEXT_TOKENS) {
      if (lower.includes(tok)) {
        violations.push(`pii_leak_in_field:${k}:${tok.trim()}`);
        break;
      }
    }
    if (CIVIC_NUMBER_RE.test(v)) violations.push(`civic_number_in_field:${k}`);
    if (k !== "source_url" && /\b[A-Z][a-zà-ù]{2,}\s+[A-Z][A-ZÀ-Ù]{2,}\b/.test(v)) {
      violations.push(`possible_full_name_in_field:${k}`);
    }
  }

  if (typeof bucket.source_url === "string" && bucket.source_url.length > 0) {
    if (/\/(necrolog(?:io|i))\/[a-z0-9-]{10,}/i.test(bucket.source_url)) {
      violations.push("individual_obituary_url");
    }
  }

  return { allowed: violations.length === 0, violations };
}

export function enforceAggregateBucket(bucket: AggregateBucketLike): void {
  const r = assertAggregateBucket(bucket);
  if (!r.allowed) throw new Error(`aggregate_bucket_violation:${r.violations.join(",")}`);
}
