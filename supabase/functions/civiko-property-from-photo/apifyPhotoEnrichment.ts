// ═══════════════════════════════════════════════════════════════
// Apify enrichment per civiko-property-from-photo
//
// Recupera documenti territoriali (open data, urbanistica, alienazioni
// comunali, geoportale) tramite l'orchestratore Apify già esistente
// in civiko-radar-veneto/apify. Non modifica nulla in quel modulo.
//
// HARD RULES:
//   - Mai bloccante: timeout totale 45s con AbortController/Promise.race.
//   - In errore restituisce array vuoto.
//   - Nessuna PII restituita.
// ═══════════════════════════════════════════════════════════════

import {
  APIFY_VENETO_REGISTRY,
  type ApifySourceBinding,
} from "../civiko-radar-veneto/apify/apifySourceRegistry.ts";
import { runApifyForVenetoSourceV2 } from "../civiko-radar-veneto/apify/apifyOrchestrator.ts";

export interface TerritorialDocument {
  tipo: "open_data" | "urbanistica" | "geoportale" | "alienazione_comunale";
  titolo: string;
  descrizione: string;
  url: string;
  fonte: string;
  dataPublicazione?: string;
}

const TOTAL_TIMEOUT_MS = 45_000;
const PER_SOURCE_TIMEOUT_MS = 25_000;
const MAX_SOURCES = 2;
const MAX_DOCS_PER_SOURCE = 6;

// Mappa province → token presenti nei source_name del registry Apify.
// Le sorgenti Veneto-wide (open_data_veneto_*, geoportale_veneto_*) sono
// sempre incluse come fallback per qualunque provincia.
const PROVINCE_TOKENS: Record<string, string[]> = {
  PD: ["padova"],
  VR: ["verona"],
  VI: ["vicenza"],
  VE: ["venezia"],
  TV: ["treviso"],
  BL: ["belluno"],
  RO: ["rovigo"],
};

function mapSourceTypeToTipo(t: ApifySourceBinding["source_type"]): TerritorialDocument["tipo"] {
  switch (t) {
    case "urban_planning": return "urbanistica";
    case "public_assets":  return "alienazione_comunale";
    case "geoportal":      return "geoportale";
    case "open_data":      return "open_data";
    case "pdf_index":      return "urbanistica";
    default:               return "open_data";
  }
}

function priorityScore(t: ApifySourceBinding["source_type"]): number {
  // urbanistica e alienazioni comunali per prima, come da spec.
  if (t === "urban_planning")  return 100;
  if (t === "public_assets")   return 95;
  if (t === "pdf_index")       return 70;
  if (t === "geoportal")       return 60;
  if (t === "open_data")       return 40;
  return 0;
}

function selectSources(provincia: string): ApifySourceBinding[] {
  const prov = (provincia || "").toUpperCase().trim();
  const tokens = PROVINCE_TOKENS[prov] ?? [];
  const filtered = APIFY_VENETO_REGISTRY.filter((s) => {
    const lower = s.source_name.toLowerCase();
    if (tokens.some((tok) => lower.includes(tok))) return true;
    // Sorgenti Veneto-wide (nessun token comune nel nome).
    return /veneto/.test(lower) && !/_padova|_vicenza|_verona|_venezia|_treviso|_belluno|_rovigo/.test(lower);
  });
  filtered.sort((a, b) => priorityScore(b.source_type) - priorityScore(a.source_type));
  return filtered.slice(0, MAX_SOURCES);
}

/** Pulisce stringhe ed evita undefined nel payload. */
function safeStr(v: unknown, max = 400): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.trim().slice(0, max);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); })
     .catch(() => { clearTimeout(timer); resolve(fallback); });
  });
}

interface SampleRecord {
  source_url: string;
  title: string | null;
  data_basis?: "real" | "partial";
  classification?: string;
}

function recordsToDocs(
  binding: ApifySourceBinding,
  records: SampleRecord[],
): TerritorialDocument[] {
  const tipo = mapSourceTypeToTipo(binding.source_type);
  const out: TerritorialDocument[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const url = safeStr(r.source_url, 600);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const titolo = safeStr(r.title, 200) || binding.source_name;
    out.push({
      tipo,
      titolo,
      descrizione: safeStr(r.classification, 300) || binding.allowed_use || "",
      url,
      fonte: binding.source_name,
    });
    if (out.length >= MAX_DOCS_PER_SOURCE) break;
  }
  return out;
}

/**
 * Esegue Apify per arricchire la response con documenti territoriali.
 * Mai blocca: timeout totale 45s, in errore → [].
 *
 * NOTA: lat/lng non sono usati per filtrare sorgenti Apify (il registry
 * non è geolocalizzato); la selezione avviene per provincia + tipo.
 */
export async function runApifyPhotoEnrichment(
  _lat: number,
  _lng: number,
  provincia: string,
): Promise<TerritorialDocument[]> {
  try {
    const sources = selectSources(provincia);
    if (sources.length === 0) return [];

    const run = async (): Promise<TerritorialDocument[]> => {
      const all: TerritorialDocument[] = [];
      for (const binding of sources) {
        const report = await withTimeout(
          runApifyForVenetoSourceV2({
            source_name: binding.source_name,
            actor_id: binding.actor_id,
            dryRun: false,
            invokeActor: true,
            import: false,
          }).catch(() => null),
          PER_SOURCE_TIMEOUT_MS,
          null,
        );
        if (!report || !report.ok) continue;
        const docs = recordsToDocs(binding, report.sample_records ?? []);
        all.push(...docs);
      }
      return all;
    };

    return await withTimeout(run(), TOTAL_TIMEOUT_MS, []);
  } catch (e) {
    console.warn(`[apifyPhotoEnrichment] error: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
