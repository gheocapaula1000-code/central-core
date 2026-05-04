// ═══════════════════════════════════════════════════════════════
// Import Aste Veneto — CSV/JSON tracciato, nessun mock/seed/demo
// POST /jobs/import-veneto-auctions
// ═══════════════════════════════════════════════════════════════
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isDemoSource, normalizeProvincia, type ProvCode, VENETO_PROVINCES } from "./agentRadar.ts";

const VENETO = new Set<string>(VENETO_PROVINCES);

export interface AuctionRowInput {
  source_url?: string | null;
  comune?: string | null;
  provincia?: string | null;
  cap?: string | null;
  lat?: number | null;
  lng?: number | null;
  tipologia?: string | null;
  categoria?: string | null;
  prezzo_base?: number | null;
  offerta_minima?: number | null;
  data_vendita?: string | null;
  tribunale?: string | null;
  stato?: string | null;
  quality?: "reale" | "parziale" | string;
  data_basis?: string[] | string | null;
}

export interface ImportRequest {
  source_name?: string;
  dryRun?: boolean;
  rows?: AuctionRowInput[];
}

export interface ImportReport {
  ok: boolean;
  source_name: string;
  dryRun: boolean;
  totals: {
    received: number;
    accepted: number;
    rejected: number;
    inserted: number;
    duplicates: number;
  };
  rejections: Array<{ index: number; reason: string }>;
  warnings: string[];
}

function svcClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fingerprint(source_name: string, source_url: string | null, comune: string, prov: ProvCode, sale_date: string | null): Promise<string> {
  const seed = `${source_name}|${source_url ?? ""}|${prov}|${comune.toUpperCase()}|${sale_date ?? ""}`;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(seed));
  return "auction_" + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export async function importVenetoAuctions(req: ImportRequest): Promise<ImportReport> {
  const source_name = String(req.source_name ?? "").trim();
  const dryRun = req.dryRun !== false; // default true per sicurezza
  const rows = Array.isArray(req.rows) ? req.rows : [];
  const report: ImportReport = {
    ok: true,
    source_name,
    dryRun,
    totals: { received: rows.length, accepted: 0, rejected: 0, inserted: 0, duplicates: 0 },
    rejections: [],
    warnings: [],
  };

  if (!source_name || isDemoSource(source_name)) {
    report.ok = false;
    report.warnings.push("source_name mancante o marcato demo/mock/seed: import rifiutato.");
    return report;
  }

  const supa = svcClient();
  if (!supa && !dryRun) {
    report.ok = false;
    report.warnings.push("SUPABASE_SERVICE_ROLE_KEY mancante: impossibile scrivere.");
    return report;
  }

  // Validazione + normalizzazione
  interface Prepared {
    fingerprint: string;
    source_name: string;
    source_url: string | null;
    province: ProvCode;
    municipality: string;
    cap: string | null;
    lat: number | null;
    lng: number | null;
    property_type: string | null;
    base_price_eur: number | null;
    minimum_offer_eur: number | null;
    sale_date: string | null;
    status: string | null;
    quality: "reale" | "parziale";
    data_basis: string;
    payload: Record<string, unknown>;
  }
  const prepared: Prepared[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const reject = (reason: string) => {
      report.rejections.push({ index: i, reason });
      report.totals.rejected++;
    };
    const comune = (r.comune ?? "").toString().trim();
    const provRaw = (r.provincia ?? "").toString().trim();
    if (!comune) { reject("comune mancante"); continue; }
    const prov = normalizeProvincia(provRaw);
    if (!prov || !VENETO.has(prov)) { reject(`provincia non Veneto: ${provRaw}`); continue; }
    const q = (r.quality ?? "parziale").toString().toLowerCase();
    if (q !== "reale" && q !== "parziale") { reject(`quality invalido: ${q}`); continue; }
    if (isDemoSource(r.source_url, r.tipologia, r.categoria, r.tribunale, r.data_basis)) {
      reject("contiene marker demo/mock/seed"); continue;
    }
    const dataBasisArr = Array.isArray(r.data_basis) ? r.data_basis.filter((x) => typeof x === "string" && !isDemoSource(x))
      : (typeof r.data_basis === "string" && !isDemoSource(r.data_basis)) ? [r.data_basis] : [];
    if (dataBasisArr.length === 0) { reject("data_basis mancante o marcata demo"); continue; }
    const sourceUrl = (r.source_url ?? "").toString().trim() || null;
    if (!sourceUrl && q === "reale") { reject("quality=reale richiede source_url"); continue; }
    const saleDate = r.data_vendita ? String(r.data_vendita).slice(0, 10) : null;
    const fp = await fingerprint(source_name, sourceUrl, comune, prov, saleDate);
    prepared.push({
      fingerprint: fp,
      source_name,
      source_url: sourceUrl,
      province: prov,
      municipality: comune,
      cap: r.cap ? String(r.cap).slice(0, 8) : null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lng: typeof r.lng === "number" ? r.lng : null,
      property_type: r.tipologia ? String(r.tipologia).slice(0, 80) : null,
      base_price_eur: typeof r.prezzo_base === "number" ? r.prezzo_base : null,
      minimum_offer_eur: typeof r.offerta_minima === "number" ? r.offerta_minima : null,
      sale_date: saleDate,
      status: r.stato ? String(r.stato).slice(0, 40) : null,
      quality: q as "reale" | "parziale",
      data_basis: dataBasisArr.join(","),
      payload: {
        tribunale: r.tribunale ? String(r.tribunale).slice(0, 120) : null,
        categoria: r.categoria ? String(r.categoria).slice(0, 80) : null,
        imported_at: new Date().toISOString(),
        source_basis: dataBasisArr,
      },
    });
    report.totals.accepted++;
  }

  if (dryRun || prepared.length === 0 || !supa) {
    if (prepared.length === 0) report.warnings.push("Nessuna riga valida: auction_signals invariata.");
    if (dryRun) report.warnings.push("dryRun=true: nessuna scrittura effettuata.");
    return report;
  }

  // Dedup contro DB
  const fps = prepared.map((p) => p.fingerprint);
  const { data: existing } = await supa.from("auction_signals").select("fingerprint").in("fingerprint", fps);
  const existingSet = new Set((existing ?? []).map((x) => (x as { fingerprint: string }).fingerprint));
  const toInsert = prepared.filter((p) => !existingSet.has(p.fingerprint));
  report.totals.duplicates = prepared.length - toInsert.length;

  if (toInsert.length > 0) {
    const { error, count } = await supa.from("auction_signals").insert(toInsert, { count: "exact" });
    if (error) {
      report.ok = false;
      report.warnings.push(`insert auction_signals: ${error.message}`);
    } else {
      report.totals.inserted = count ?? toInsert.length;
    }
  }

  return report;
}
