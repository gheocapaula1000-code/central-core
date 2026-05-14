// Central Core — Step 3 workflow pilota Arcella
// Funzione pura: valida l'output di normalizeMicrozona() per la microzona Arcella.
// Nessun side effect: no DB, no PWA, no edge functions, no fetch.

import type {
  MicrozonaDossierPayload,
  LivelloAffidabilita,
} from "@/lib/normalizeMicrozona";

export type ValidationResult = "valid" | "valid_with_warnings" | "invalid";

export interface ValidationStats {
  totale_elementi: number;
  certo: number;
  probabile: number;
  da_testare: number;
  rapporto_da_testare: number;
}

export interface ValidationOutcome {
  isValid: boolean;
  result: ValidationResult;
  errors: string[];
  warnings: string[];
  stats: ValidationStats;
}

const BLOCCHI: Array<keyof MicrozonaDossierPayload> = [
  "servizi_prossimita",
  "segnali_territoriali",
  "opportunita_candidate",
  "asset_osservati",
];

const LIVELLI_AMMESSI: ReadonlySet<LivelloAffidabilita> = new Set([
  "certo",
  "probabile",
  "da_testare",
]);

// Pattern semplici per individuare contenuti tecnici "evidenti".
const URL_RE = /\bhttps?:\/\/\S+/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PAYLOAD_RE = /(\{[\s\S]*?:[\s\S]*?\}|<[a-z][\s\S]*?>|api[_-]?key|bearer\s+\S+)/i;

export function validateMicrozonaDossier(
  input: Partial<MicrozonaDossierPayload> | null | undefined,
): ValidationOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts = { certo: 0, probabile: 0, da_testare: 0 };
  let totale = 0;

  if (!input || typeof input !== "object") {
    return {
      isValid: false,
      result: "invalid",
      errors: ["input mancante o non valido"],
      warnings: [],
      stats: { totale_elementi: 0, certo: 0, probabile: 0, da_testare: 0, rapporto_da_testare: 0 },
    };
  }

  // 1) microzona_id
  if (!input.microzona_id) {
    errors.push("microzona_id mancante");
  } else if (input.microzona_id !== "arcella") {
    errors.push(`microzona_id deve essere "arcella" in questo step (ricevuto: "${input.microzona_id}")`);
  }

  // 2-6) blocchi
  for (const key of BLOCCHI) {
    const block = (input as Record<string, unknown>)[key as string];
    if (block === undefined || block === null) {
      errors.push(`blocco "${key}" mancante`);
      continue;
    }
    if (!Array.isArray(block)) {
      errors.push(`blocco "${key}" deve essere un array`);
      continue;
    }
    if (block.length === 0) {
      errors.push(`blocco "${key}" deve contenere almeno 1 elemento`);
      continue;
    }
    block.forEach((item, idx) => {
      if (!item || typeof item !== "object") {
        errors.push(`${key}[${idx}] non è un oggetto valido`);
        return;
      }
      const livello = (item as Record<string, unknown>).livello;
      if (livello === undefined || livello === null || livello === "") {
        errors.push(`${key}[${idx}] manca il campo "livello"`);
        return;
      }
      if (typeof livello !== "string" || !LIVELLI_AMMESSI.has(livello as LivelloAffidabilita)) {
        errors.push(`${key}[${idx}].livello non ammesso ("${String(livello)}")`);
        return;
      }
      counts[livello as LivelloAffidabilita] += 1;
      totale += 1;
    });
  }

  // 7) note_interne pulite
  const note = typeof input.note_interne === "string" ? input.note_interne : "";
  if (note) {
    if (URL_RE.test(note)) errors.push("note_interne contiene un URL");
    if (EMAIL_RE.test(note)) errors.push("note_interne contiene un indirizzo email");
    if (PAYLOAD_RE.test(note)) errors.push("note_interne contiene payload tecnici evidenti");
  }

  // 8) rapporto da_testare → warning, non bloccante
  const rapporto = totale > 0 ? counts.da_testare / totale : 0;
  if (rapporto > 0.5) {
    warnings.push(
      `rapporto da_testare elevato (${(rapporto * 100).toFixed(0)}%): consolidare i livelli`,
    );
  }

  const stats: ValidationStats = {
    totale_elementi: totale,
    certo: counts.certo,
    probabile: counts.probabile,
    da_testare: counts.da_testare,
    rapporto_da_testare: Number(rapporto.toFixed(4)),
  };

  const isValid = errors.length === 0;
  const result: ValidationResult = !isValid
    ? "invalid"
    : warnings.length > 0
      ? "valid_with_warnings"
      : "valid";

  return { isValid, result, errors, warnings, stats };
}
