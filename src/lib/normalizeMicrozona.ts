// Central Core — Step 2 workflow pilota Arcella
// Funzione pura: trasforma i dati interni già disponibili sulla microzona Arcella
// nello shape compatibile con la tabella `microzona_dossier`.
//
// Vincoli:
// - nessun side effect (no DB, no edge functions, no PWA, no fetch)
// - nessuna invenzione di dati: si normalizza solo ciò che è in input
// - i 4 blocchi sono sempre array
// - ogni elemento ha sempre `livello` ∈ { "certo", "probabile", "da_testare" }
// - se non deducibile in modo affidabile → "da_testare"

export type LivelloAffidabilita = "certo" | "probabile" | "da_testare";

export type StatoDossier =
  | "approvata_interna"
  | "pubblicabile"
  | "pubblicata";

export interface DossierItem {
  livello: LivelloAffidabilita;
  // qualunque altro campo utile viene preservato
  [key: string]: unknown;
}

export interface MicrozonaDossierPayload {
  microzona_id: string;
  versione: string; // ISO timestamp
  stato: StatoDossier;
  servizi_prossimita: DossierItem[];
  segnali_territoriali: DossierItem[];
  opportunita_candidate: DossierItem[];
  asset_osservati: DossierItem[];
  note_interne: string;
}

export interface NormalizeMicrozonaInput {
  microzona_id?: string;
  versione?: string | Date;
  stato?: StatoDossier;
  servizi_prossimita?: unknown;
  segnali_territoriali?: unknown;
  opportunita_candidate?: unknown;
  asset_osservati?: unknown;
  note_interne?: string;
}

const LIVELLI_AMMESSI: ReadonlySet<LivelloAffidabilita> = new Set([
  "certo",
  "probabile",
  "da_testare",
]);

/** Normalizza un valore arbitrario in un livello ammesso. */
function normalizeLivello(raw: unknown, fallbackHints?: Record<string, unknown>): LivelloAffidabilita {
  // 1) campo livello esplicito
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if ((LIVELLI_AMMESSI as Set<string>).has(v)) return v as LivelloAffidabilita;
  }

  // 2) deduzione robusta da hint comuni del Core (stato/maturità)
  const hint =
    typeof fallbackHints?.stato === "string"
      ? (fallbackHints.stato as string).toLowerCase()
      : typeof fallbackHints?.statoDato === "string"
        ? (fallbackHints.statoDato as string).toLowerCase()
        : typeof fallbackHints?.maturitaDato === "string"
          ? (fallbackHints.maturitaDato as string).toLowerCase()
          : "";

  if (hint) {
    if (hint === "verificato" || hint === "verificata" || hint === "osservato") return "certo";
    if (
      hint === "demo_operativa" ||
      hint === "in_verifica" ||
      hint === "demo" ||
      hint === "probabile"
    )
      return "probabile";
    if (hint === "da_verificare" || hint === "da_confermare" || hint === "da_testare")
      return "da_testare";
  }

  // 3) fallback sicuro
  return "da_testare";
}

/** Forza un valore in array, scartando null/undefined; oggetto singolo viene wrappato. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((v) => v != null);
  if (value == null) return [];
  if (typeof value === "object") return [value];
  return [];
}

/** Normalizza un singolo blocco: array di oggetti, ognuno con `livello`. */
function normalizeBlocco(value: unknown): DossierItem[] {
  return asArray(value)
    .map((raw) => {
      // primitivi → oggetto minimo {valore, livello}
      if (typeof raw !== "object" || raw === null) {
        return { valore: raw, livello: "da_testare" as LivelloAffidabilita };
      }
      const obj = raw as Record<string, unknown>;
      const livello = normalizeLivello(obj.livello, obj);
      return { ...obj, livello };
    });
}

function normalizeVersione(v: NormalizeMicrozonaInput["versione"]): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === "string" && v.trim().length > 0) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function normalizeStato(s: unknown): StatoDossier {
  if (s === "pubblicabile" || s === "pubblicata") return s;
  return "approvata_interna";
}

function normalizeNote(n: unknown): string {
  if (typeof n !== "string") return "";
  // breve e pulita: una riga, max 280 char
  const cleaned = n.replace(/\s+/g, " ").trim();
  return cleaned.length > 280 ? cleaned.slice(0, 277) + "..." : cleaned;
}

/**
 * Funzione pura. Trasforma l'input nello shape `microzona_dossier`.
 * In questo step `microzona_id` è forzato a "arcella".
 */
export function normalizeMicrozona(
  input: NormalizeMicrozonaInput = {},
): MicrozonaDossierPayload {
  return {
    microzona_id: "arcella",
    versione: normalizeVersione(input.versione),
    stato: normalizeStato(input.stato ?? "approvata_interna"),
    servizi_prossimita: normalizeBlocco(input.servizi_prossimita),
    segnali_territoriali: normalizeBlocco(input.segnali_territoriali),
    opportunita_candidate: normalizeBlocco(input.opportunita_candidate),
    asset_osservati: normalizeBlocco(input.asset_osservati),
    note_interne: normalizeNote(input.note_interne),
  };
}
