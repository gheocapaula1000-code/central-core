// ═══════════════════════════════════════════════════════════════
// inheritanceComplianceGuard.ts
//
// Guardrail unico per qualunque segnale "inheritance / successione /
// pressione successoria / turnover patrimoniale".
//
// Vincoli inderogabili:
//  1. Granularità ammessa SOLO: comune | cap | microzona |
//     street_cluster | zona_omi | sezione_censuaria | quartiere
//     (e solo se street_cluster deriva da dati AGGREGATI non personali).
//  2. Sono VIETATI i campi: full_name, surname, family_name,
//     deceased_name, heir_name, death_date, obituary_url,
//     address, civic_number, street_number, person_fingerprint.
//  3. Sono VIETATE nel testo (titolo/descrizione/action/script) le
//     parole-chiave nominative funebri/successorie/eredi.
//  4. Le action ammesse sono neutre di area: presidio microzona,
//     monitoraggio turnover patrimoniale, campagna locale non nominativa.
// ═══════════════════════════════════════════════════════════════

export const FORBIDDEN_INHERITANCE_FIELDS = [
  "full_name",
  "surname",
  "family_name",
  "deceased_name",
  "heir_name",
  "death_date",
  "obituary_url",
  "address",
  "civic_number",
  "street_number",
  "person_fingerprint",
] as const;

export const ALLOWED_INHERITANCE_GRANULARITY = [
  "comune",
  "cap",
  "microzona",
  "street_cluster",
  "zona_omi",
  "sezione_censuaria",
  "quartiere",
] as const;

export const NEUTRAL_INHERITANCE_ACTIONS = [
  "Presidiare la microzona",
  "Monitorare il turnover patrimoniale dell'area",
  "Avviare una campagna locale non nominativa",
] as const;

const FORBIDDEN_TEXT_TOKENS = [
  "necrolog", "obituar", "lutto", "luttuos", "funeral", "deceduto",
  "deceduta", "defunto", "defunta", "decesso", "morto", "morta",
  "onoranze", "cimiter", "tomba", "loculo", "eredi ", "erede ",
  "famiglia ", "famiglie ", "vedov", "orfan",
];

const CIVIC_NUMBER_RE = /\b(via|viale|piazza|piazzale|corso|vicolo|strada|largo|contrà)\s+[A-Za-zÀ-ÿ' .-]+\s*,?\s*\d+\b/i;

export interface InheritanceSignalLike {
  granularity?: string | null;
  area_type?: string | null;
  area_label?: string | null;
  title?: string | null;
  titolo?: string | null;
  description?: string | null;
  descrizione?: string | null;
  agentAction?: string | null;
  script?: string | null;
  fonte?: string | null;
  source?: string | null;
  source_name?: string | null;
  [k: string]: unknown;
}

export interface ComplianceResult {
  allowed: boolean;
  violations: string[];
}

/**
 * Verifica che un segnale di tipo successione/inheritance sia compliant.
 * Restituisce { allowed:false, violations:[...] } se viola le regole.
 */
export function assertAggregateInheritanceSignal(
  signal: InheritanceSignalLike,
): ComplianceResult {
  const violations: string[] = [];

  // 1. Granularità
  const gran = String(signal.granularity ?? signal.area_type ?? "").toLowerCase();
  if (gran && !ALLOWED_INHERITANCE_GRANULARITY.includes(gran as never)) {
    violations.push(`forbidden_granularity:${gran}`);
  }
  if (!gran) {
    violations.push("missing_granularity");
  }

  // 2. Campi vietati
  for (const f of FORBIDDEN_INHERITANCE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(signal, f) && signal[f] != null && signal[f] !== "") {
      violations.push(`forbidden_field:${f}`);
    }
  }

  // 3. Testo nominativo o civico
  const textBlobs = [
    signal.title, signal.titolo, signal.description, signal.descrizione,
    signal.agentAction, signal.script,
  ].filter(Boolean).map(String);
  const combined = textBlobs.join("\n").toLowerCase();
  for (const tok of FORBIDDEN_TEXT_TOKENS) {
    if (combined.includes(tok)) {
      violations.push(`forbidden_text_token:${tok.trim()}`);
      break;
    }
  }
  for (const t of textBlobs) {
    if (CIVIC_NUMBER_RE.test(t)) {
      violations.push("forbidden_civic_number_in_text");
      break;
    }
  }

  // 4. Fonte funebre/obituary
  const src = String(signal.fonte ?? signal.source ?? signal.source_name ?? "").toLowerCase();
  if (/necrolog|obituar|onoranze|funebr|cimiter/.test(src)) {
    violations.push("forbidden_obituary_source");
  }

  return { allowed: violations.length === 0, violations };
}

/** Throw variant: utile come hard-stop in pipeline. */
export function enforceAggregateInheritanceSignal(signal: InheritanceSignalLike): void {
  const r = assertAggregateInheritanceSignal(signal);
  if (!r.allowed) {
    throw new Error(`inheritance_compliance_violation:${r.violations.join(",")}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// AGGREGATE BUCKET GUARD (necrologi PII-free)
// ═══════════════════════════════════════════════════════════════

const MIN_BUCKET_COUNT = 3; // soglia k-anonimity

export interface AggregateBucketLike {
  area_type?: string | null;
  area_code?: string | null;
  bucket_count?: number | null;
  source_code?: string | null;
  source_url?: string | null;
  window_days?: number | null;
  [k: string]: unknown;
}

/**
 * Guardrail per bucket aggregati di necrologi/successioni.
 * Verifica:
 *   - area_type ammesso
 *   - assenza di PII in QUALSIASI stringa del bucket (nome, cognome, età, indirizzo)
 *   - bucket_count ≥ soglia k=3
 *   - source_url non contiene path individuale (es. /necrologio/nome-cognome-id)
 */
export function assertAggregateBucket(bucket: AggregateBucketLike): ComplianceResult {
  const violations: string[] = [];

  const area_type = String(bucket.area_type ?? "").toLowerCase();
  if (!area_type || !ALLOWED_INHERITANCE_GRANULARITY.includes(area_type as never)) {
    violations.push(`forbidden_granularity:${area_type || "missing"}`);
  }

  if (!bucket.area_code || String(bucket.area_code).trim() === "") {
    violations.push("missing_area_code");
  }

  const count = Number(bucket.bucket_count);
  if (!Number.isFinite(count) || count < MIN_BUCKET_COUNT) {
    violations.push(`below_k_anonymity_threshold:${count}`);
  }

  // Verifica ogni campo stringa contro token PII vietati.
  for (const [k, v] of Object.entries(bucket)) {
    if (typeof v !== "string" || v.length === 0) continue;
    const lower = v.toLowerCase();
    for (const tok of FORBIDDEN_TEXT_TOKENS) {
      if (lower.includes(tok)) {
        violations.push(`pii_leak_in_field:${k}:${tok.trim()}`);
        break;
      }
    }
    if (CIVIC_NUMBER_RE.test(v)) {
      violations.push(`civic_number_in_field:${k}`);
    }
    // Nome+Cognome (2 parole capitalizzate consecutive) in campi non-URL:
    if (k !== "source_url" && /\b[A-Z][a-zà-ù]{2,}\s+[A-Z][A-ZÀ-Ù]{2,}\b/.test(v)) {
      violations.push(`possible_full_name_in_field:${k}`);
    }
  }

  // source_url deve essere una pagina indice, non un dettaglio individuale.
  if (typeof bucket.source_url === "string" && bucket.source_url.length > 0) {
    const u = bucket.source_url.toLowerCase();
    // path che contengono uno slug tipico di dettaglio necrologio individuale
    if (/\/(necrolog(?:io|i))\/[a-z0-9-]{10,}/i.test(u)) {
      violations.push("individual_obituary_url");
    }
  }

  return { allowed: violations.length === 0, violations };
}

export function enforceAggregateBucket(bucket: AggregateBucketLike): void {
  const r = assertAggregateBucket(bucket);
  if (!r.allowed) {
    throw new Error(`aggregate_bucket_violation:${r.violations.join(",")}`);
  }
}

export const AGGREGATE_MIN_BUCKET_COUNT = MIN_BUCKET_COUNT;
