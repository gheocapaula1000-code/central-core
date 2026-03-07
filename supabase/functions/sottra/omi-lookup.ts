// Sottra — OMI Lookup: real price data from Agenzia delle Entrate

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callAI, parseJSON } from "./shared.ts";

export interface OMIResult {
  found: boolean;
  zona?: string;
  zona_descr?: string;
  comune?: string;
  compr_min?: number;
  compr_max?: number;
  prezzoMedio?: number;
  loc_min?: number;
  loc_max?: number;
  tipologia?: string;
  stato?: string;
  fonte: string;
  tutteZone?: Array<{
    zona: string;
    zona_descr: string;
    compr_min: number | null;
    compr_max: number | null;
    loc_min: number | null;
    loc_max: number | null;
    tipologia: string;
  }>;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key);
}

/**
 * Extract comune name from an Italian address.
 * E.g. "Via Guido Reni 8, 35133 Padova" → "PADOVA"
 */
function extractComune(address: string): string {
  // Remove CAP (5-digit postal code)
  const cleaned = address.replace(/\b\d{5}\b/g, "").trim();
  // Take the last meaningful part after comma
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  // Remove province abbreviation in parentheses: "Padova (PD)" → "Padova"
  const withoutProv = last.replace(/\s*\([A-Z]{2}\)\s*$/, "").trim();
  return withoutProv.toUpperCase();
}

/**
 * Lookup OMI data for a given address.
 * AI is used ONLY to identify the correct OMI zone — prices come from the DB.
 */
export async function lookupOMI(address: string, codTip = 20): Promise<OMIResult> {
  const FONTE = "Agenzia Entrate — OMI, 1° semestre 2025";
  const comuneStr = extractComune(address);
  if (!comuneStr) return { found: false, fonte: FONTE };

  const supabase = getSupabase();

  // 1. Find zones for this comune
  const { data: zone, error: zoneErr } = await supabase
    .from("omi_zone")
    .select("*")
    .ilike("comune_descrizione", comuneStr);

  if (zoneErr || !zone || zone.length === 0) {
    return { found: false, fonte: FONTE };
  }

  // 2. Get values for all zones of this comune (filtered by tipologia)
  const linkZone = zone.map((z: Record<string, unknown>) => z.link_zona as string);
  const { data: valori, error: valErr } = await supabase
    .from("omi_valori")
    .select("*")
    .in("link_zona", linkZone)
    .eq("cod_tip", codTip);

  if (valErr || !valori || valori.length === 0) {
    // Try without tipologia filter
    const { data: allValori } = await supabase
      .from("omi_valori")
      .select("*")
      .in("link_zona", linkZone);

    if (!allValori || allValori.length === 0) {
      return { found: false, fonte: FONTE };
    }
  }

  const finalValori = valori && valori.length > 0 ? valori : [];

  // 3. Build zone summary for AI
  const zoneSummary = zone.map((z: Record<string, unknown>) => {
    const v = finalValori.find((val: Record<string, unknown>) => val.link_zona === z.link_zona);
    return {
      zona: z.zona,
      zona_descr: z.zona_descr ?? z.fascia ?? "",
      link_zona: z.link_zona,
      compr_min: v?.compr_min ?? null,
      compr_max: v?.compr_max ?? null,
      loc_min: v?.loc_min ?? null,
      loc_max: v?.loc_max ?? null,
      tipologia: v?.descr_tipologia ?? "",
    };
  });

  // 4. Use AI ONLY to identify the correct zone
  let bestZone = zoneSummary[0];

  if (zoneSummary.length > 1) {
    const zoneList = zoneSummary
      .map((z) => `- ${z.zona}: ${z.zona_descr}`)
      .join("\n");

    const prompt = `Sei un esperto di zone OMI italiane. Data la lista di zone OMI del comune di ${comuneStr}:
${zoneList}

Quale zona corrisponde all'indirizzo "${address}"?
Rispondi SOLO con il codice zona (es. "B1", "C3", "D1"). Nient'altro.`;

    try {
      const output = await callAI(prompt, 20, 0.1);
      const zonaCodice = output.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const match = zoneSummary.find((z) => (z.zona as string).toUpperCase() === zonaCodice);
      if (match) bestZone = match;
    } catch {
      // Use first zone as fallback
    }
  }

  const comprMin = bestZone.compr_min as number | null;
  const comprMax = bestZone.compr_max as number | null;
  const prezzoMedio = comprMin != null && comprMax != null
    ? Math.round((comprMin + comprMax) / 2)
    : null;

  return {
    found: true,
    zona: bestZone.zona as string,
    zona_descr: bestZone.zona_descr as string,
    comune: comuneStr,
    compr_min: comprMin ?? undefined,
    compr_max: comprMax ?? undefined,
    prezzoMedio: prezzoMedio ?? undefined,
    loc_min: (bestZone.loc_min as number | null) ?? undefined,
    loc_max: (bestZone.loc_max as number | null) ?? undefined,
    tipologia: (bestZone.tipologia as string) || "Abitazioni civili",
    stato: "NORMALE",
    fonte: FONTE,
    tutteZone: zoneSummary.map((z) => ({
      zona: z.zona as string,
      zona_descr: z.zona_descr as string,
      compr_min: z.compr_min as number | null,
      compr_max: z.compr_max as number | null,
      loc_min: z.loc_min as number | null,
      loc_max: z.loc_max as number | null,
      tipologia: z.tipologia as string,
    })),
  };
}
