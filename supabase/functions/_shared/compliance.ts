// _shared/compliance.ts
// Guardrails per dati sensibili Civiko.
// - assertAggregateOnly: rifiuta record con campi person-level negli importer aggregati.
// - redactSensitiveForPwa: rimuove payload classificati sensitive_restricted prima di tornare al frontend consumer.
// - PERSON_LEVEL_FIELDS: lista nera condivisa.

export const PERSON_LEVEL_FIELDS = [
  "first_name",
  "last_name",
  "full_name",
  "nome",
  "cognome",
  "codice_fiscale",
  "cf",
  "fiscal_code",
  "tax_id",
  "email",
  "phone",
  "telefono",
  "owner_name",
  "proprietario",
  "deceased_name",
  "defunto",
  "heir_name",
  "erede",
  "spouse_name",
  "coniuge",
  "address_private",
  "indirizzo_privato",
] as const;

export class ComplianceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ComplianceError";
  }
}

/** Rigetta record che contengono campi person-level: pensato per importer aggregati. */
export function assertAggregateOnly(record: Record<string, unknown>, sourceCode: string): void {
  if (!record || typeof record !== "object") return;
  const offenders: string[] = [];
  for (const key of Object.keys(record)) {
    const k = key.toLowerCase();
    if (PERSON_LEVEL_FIELDS.some((f) => k === f || k.endsWith(`_${f}`))) {
      offenders.push(key);
    }
  }
  if (offenders.length > 0) {
    throw new ComplianceError(
      "PERSON_LEVEL_FIELD_REJECTED",
      `[${sourceCode}] person-level field(s) not allowed in aggregate importer: ${offenders.join(", ")}`,
    );
  }
}

/**
 * Strippa qualsiasi campo flaggato sensitive_restricted da un payload destinato alla PWA.
 * Supporta payload annidati. Cerca:
 *   - chiavi presenti in PERSON_LEVEL_FIELDS
 *   - oggetti con compliance_level === 'sensitive_restricted'
 */
export function redactSensitiveForPwa<T>(payload: T): T {
  return walk(payload) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.compliance_level === "sensitive_restricted") {
      return { redacted: true, reason: "sensitive_restricted" };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (PERSON_LEVEL_FIELDS.some((f) => kl === f || kl.endsWith(`_${f}`))) continue;
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}
