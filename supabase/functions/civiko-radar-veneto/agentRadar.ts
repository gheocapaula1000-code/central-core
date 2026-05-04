// ═══════════════════════════════════════════════════════════════
// Agent Radar Veneto — output operativo Civiko One MVP Veneto-only
// POST /agent-radar
//
// JSON shape stabile (mai undefined):
//   { configured, scope, summary, zones[], opportunities[], dataQuality }
//
// Fonti (best-effort, parziale tollerato):
//   - omi_valori, omi_zone           → gap OMI / fascia / microzona
//   - listing_price_snapshots        → prezzo medio richiesto, stock
//   - motivated_sellers              → venditori motivati / "bruciati"
//   - market_anomalies               → ribassi, anomalie
//   - radar_signals                  → aste, segnali
//
// Hard rules:
//   - Veneto-only (province ∈ {VE,VR,VI,PD,TV,BL,RO})
//   - Mai eccezioni non gestite: ogni query in try/catch + warning
//   - Mai inventare metriche reali: missing → null, demo marcato esplicito
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type ProvCode = "VE" | "VR" | "VI" | "PD" | "TV" | "BL" | "RO";
export const VENETO_PROVINCES: ProvCode[] = ["VE", "VR", "VI", "PD", "TV", "BL", "RO"];

const PROV_NAME_TO_CODE: Record<string, ProvCode> = {
  "venezia": "VE", "ve": "VE",
  "verona": "VR", "vr": "VR",
  "vicenza": "VI", "vi": "VI",
  "padova": "PD", "pd": "PD",
  "treviso": "TV", "tv": "TV",
  "belluno": "BL", "bl": "BL",
  "rovigo": "RO", "ro": "RO",
};

export function normalizeProvincia(input: unknown): ProvCode | null {
  if (typeof input !== "string") return null;
  const k = input.trim().toLowerCase();
  return PROV_NAME_TO_CODE[k] ?? null;
}

export interface AgentRadarRequest {
  provincia?: string;
  comune?: string;
  allowDemo?: boolean;
  maxZones?: number;
}

export interface AgentRadarZone {
  id: string;
  comune: string;
  provincia: ProvCode | "—";
  lat: number | null;
  lng: number | null;
  score: number;
  temperature: "fredda" | "tiepida" | "calda" | "molto_calda";
  signalType: "ribasso" | "asta" | "domanda" | "omi_gap" | "motivato" | "stock" | "misto";
  title: string;
  reason: string;
  agentAction: string;
  omi: {
    available: boolean;
    valoreMedio: number | null;
    fascia: string | null;
    microzona: string | null;
    quality: "reale" | "stimato" | "mancante";
  };
  metrics: {
    annunciAttivi: number | null;
    ribassi30gg: number | null;
    aste: number | null;
    venditoriMotivati: number | null;
    giorniMediMercato: number | null;
  };
  quality: "reale" | "parziale" | "stimato" | "demo";
}

export interface AgentRadarOpportunity {
  id: string;
  priority: "alta" | "media" | "bassa";
  comune: string;
  provincia: string;
  headline: string;
  whyNow: string;
  recommendedMove: string;
  script: string;
  dataBasis: string[];
}

export interface AgentRadarResponse {
  configured: boolean;
  scope: {
    region: "Veneto";
    province: ProvCode[];
    datasetStatus: "complete" | "partial" | "empty";
    message: string;
  };
  summary: {
    totalSignals: number;
    hotZones: number;
    priceDrops: number;
    auctions: number;
    motivatedSellers: number;
    dataQuality: "reale" | "parziale" | "demo" | "mancante";
  };
  zones: AgentRadarZone[];
  opportunities: AgentRadarOpportunity[];
  dataQuality: {
    real: string[];
    partial: string[];
    demo: string[];
    missing: string[];
    warnings: string[];
  };
}

// ── Quality classification (centralizzata) ────────────────────────
const DEMO_MARKERS = ["seed_demo", "demo", "mock", "fixture", "sample"];
export function isDemoSource(...vals: Array<unknown>): boolean {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).toLowerCase();
    if (DEMO_MARKERS.some((m) => s.includes(m))) return true;
  }
  return false;
}

export type QualityTag = "reale" | "parziale" | "demo" | "stimato" | "mancante";

export function classifyDataQuality(input: {
  source?: unknown;
  sourceBasis?: unknown;
  payloadQuality?: unknown;
  payloadSource?: unknown;
  derivedFromDemo?: boolean;
  hasReal?: boolean;
  isOmiOnly?: boolean;
}): QualityTag {
  if (isDemoSource(input.source, input.sourceBasis, input.payloadSource) || input.derivedFromDemo) return "demo";
  const pq = typeof input.payloadQuality === "string" ? input.payloadQuality.toLowerCase() : "";
  if (pq === "demo") return "demo";
  if (pq === "reale" && input.hasReal) return "reale";
  if (pq === "parziale") return "parziale";
  if (input.isOmiOnly) return "parziale"; // OMI da solo non basta a dichiarare opportunità reale
  if (input.hasReal) return "reale";
  return "parziale";
}

function getServiceClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function temperatureFromScore(s: number): AgentRadarZone["temperature"] {
  if (s >= 75) return "molto_calda";
  if (s >= 55) return "calda";
  if (s >= 30) return "tiepida";
  return "fredda";
}

function priorityFromScore(s: number): AgentRadarOpportunity["priority"] {
  if (s >= 70) return "alta";
  if (s >= 45) return "media";
  return "bassa";
}

interface AggKey { comune: string; provincia: ProvCode }
interface ZoneAgg {
  comune: string;
  provincia: ProvCode;
  lat: number | null;
  lng: number | null;
  annunciAttivi: number;
  annunciAttiviDemo: number;
  ribassi30gg: number;
  ribassi30ggDemo: number;
  aste: number;
  asteDemo: number;
  venditoriMotivati: number;
  venditoriMotivatiDemo: number;
  prezziPerSqm: number[];
  daysOnline: number[];
  omiValoreMedio: number | null;
  omiFascia: string | null;
  omiMicrozona: string | null;
  omiQuality: "reale" | "stimato" | "mancante";
  hasDemoSource: boolean;
  hasRealSource: boolean;
}

function emptyAgg(k: AggKey): ZoneAgg {
  return {
    comune: k.comune, provincia: k.provincia,
    lat: null, lng: null,
    annunciAttivi: 0, annunciAttiviDemo: 0,
    ribassi30gg: 0, ribassi30ggDemo: 0,
    aste: 0, asteDemo: 0,
    venditoriMotivati: 0, venditoriMotivatiDemo: 0,
    prezziPerSqm: [], daysOnline: [],
    omiValoreMedio: null, omiFascia: null, omiMicrozona: null, omiQuality: "mancante",
    hasDemoSource: false, hasRealSource: false,
  };
}

function aggKey(comune: string, provincia: ProvCode): string {
  return `${provincia}:${comune.toLowerCase().trim()}`;
}

function isVenetoRow(provRaw: string | null | undefined): ProvCode | null {
  if (!provRaw) return null;
  return normalizeProvincia(provRaw);
}

async function safe<T>(label: string, fn: () => Promise<T>, warnings: string[]): Promise<T | null> {
  try { return await fn(); }
  catch (e) {
    warnings.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function buildDemoZones(filter: ProvCode | null): AgentRadarZone[] {
  const demos: Array<Omit<AgentRadarZone, "quality">> = [
    {
      id: "demo-pd-1", comune: "Padova", provincia: "PD",
      lat: 45.4064, lng: 11.8768, score: 72, temperature: "calda", signalType: "misto",
      title: "Padova centro — pressione su trilocali",
      reason: "Esempio operativo: stock alto in zona Portello, OMI in fascia media, segnali di ribasso ricorrenti.",
      agentAction: "Aprire mandati su trilocali 70-90mq con prezzo allineato a OMI medio.",
      omi: { available: true, valoreMedio: 2400, fascia: "centrale", microzona: "B1", quality: "stimato" },
      metrics: { annunciAttivi: 38, ribassi30gg: 6, aste: 1, venditoriMotivati: 4, giorniMediMercato: 110 },
    },
    {
      id: "demo-vr-1", comune: "Verona", provincia: "VR",
      lat: 45.4384, lng: 10.9916, score: 58, temperature: "calda", signalType: "ribasso",
      title: "Verona Borgo Trento — ribassi accelerati",
      reason: "Esempio operativo: ribassi >10% su 4 immobili negli ultimi 30gg.",
      agentAction: "Contatto su venditori motivati con offerta strutturata sotto OMI massimo.",
      omi: { available: true, valoreMedio: 2900, fascia: "semicentrale", microzona: "C2", quality: "stimato" },
      metrics: { annunciAttivi: 22, ribassi30gg: 4, aste: 0, venditoriMotivati: 3, giorniMediMercato: 145 },
    },
    {
      id: "demo-ve-1", comune: "Mestre", provincia: "VE",
      lat: 45.4937, lng: 12.2426, score: 44, temperature: "tiepida", signalType: "stock",
      title: "Mestre — stock in crescita",
      reason: "Esempio operativo: stock in aumento, gap OMI/asking moderato.",
      agentAction: "Selezione su immobili con giacenza >120gg per rinegoziazione mandato.",
      omi: { available: true, valoreMedio: 2100, fascia: "periferica", microzona: "D3", quality: "stimato" },
      metrics: { annunciAttivi: 51, ribassi30gg: 3, aste: 1, venditoriMotivati: 5, giorniMediMercato: 160 },
    },
  ];
  const filtered = filter ? demos.filter((d) => d.provincia === filter) : demos;
  return (filtered.length ? filtered : demos).map((d) => ({ ...d, quality: "demo" as const }));
}


export async function buildAgentRadar(req: AgentRadarRequest): Promise<AgentRadarResponse> {
  const warnings: string[] = [];
  const real: string[] = [];
  const partial: string[] = [];
  const missing: string[] = [];

  const filterProv = normalizeProvincia(req.provincia);
  const filterComune = (req.comune ?? "").trim().toLowerCase();
  const maxZones = Math.max(1, Math.min(50, req.maxZones ?? 12));
  // POLICY PRODUZIONE: demo/mock/seed sempre esclusi. allowDemo ignorato per retro-compat.
  const allowDemo = false;
  if (req.allowDemo === true) {
    warnings.push("allowDemo=true ignorato: produzione esclude sempre demo/mock/seed.");
  }

  const supa = getServiceClient();
  if (!supa) {
    return {
      configured: false,
      scope: { region: "Veneto", province: VENETO_PROVINCES, datasetStatus: "empty", message: "Backend non configurato (SUPABASE_SERVICE_ROLE_KEY mancante)." },
      summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" },
      zones: allowDemo ? buildDemoZones(filterProv).slice(0, 3) : [],
      opportunities: [],
      dataQuality: { real: [], partial: [], demo: [], missing: ["supabase"], warnings: ["Service role mancante."] },
    };
  }

  // ── Pull dati (best-effort, ognuno in try/catch) ────────────
  const snaps = await safe("listing_price_snapshots", async () => {
    let q = supa.from("listing_price_snapshots")
      .select("province,municipality,price_eur,surface_sqm,lat,lng,captured_at,source")
      .gte("captured_at", new Date(Date.now() - 60 * 86400_000).toISOString());
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 4999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  const motivated = await safe("motivated_sellers", async () => {
    let q = supa.from("motivated_sellers")
      .select("province,municipality,days_online,total_drop_pct,fatigue_score,is_active,source,payload")
      .eq("is_active", true);
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 1999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  const anomalies = await safe("market_anomalies", async () => {
    let q = supa.from("market_anomalies")
      .select("province,municipality,anomaly_type,detected_at,is_active,payload");
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.eq("is_active", true).range(0, 1999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  const signals = await safe("radar_signals", async () => {
    let q = supa.from("radar_signals")
      .select("province,municipality,signal_type,is_active,lat,lng,source,payload")
      .eq("is_active", true);
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 1999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  // OMI → aggregazione per (provincia, comune)
  const omiRows = await safe("omi_valori", async () => {
    let q = supa.from("omi_valori")
      .select("provincia,comune_descrizione,fascia,zona,compr_min,compr_max")
      .ilike("regione", "Veneto")
      .not("compr_max", "is", null);
    if (filterProv) q = q.in("provincia", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 9999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  // auction_signals (Civiko-owned, dedicato aste)
  const auctions = await safe("auction_signals", async () => {
    let q = supa.from("auction_signals")
      .select("province,municipality,base_price_eur,sale_date,is_active,source_name,payload,quality")
      .eq("is_active", true);
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 1999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  // area_opportunity_scores (priorità Civiko)
  const aosRows = await safe("area_opportunity_scores", async () => {
    let q = supa.from("area_opportunity_scores").select("province,municipality,score,temperature,components,quality,data_basis");
    if (filterProv) q = q.eq("province", filterProv);
    const { data, error } = await q.range(0, 4999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  // ── Helper: classifica record demo vs reale e split conteggi ──
  const isRecordDemo = (rec: { source?: unknown; source_name?: unknown; payload?: unknown }): boolean => {
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    return isDemoSource(rec.source, rec.source_name, p?.source, p?.quality, p?.data_basis);
  };

  // Conteggio demo per dataset
  let snapsDemo = 0, snapsReal = 0;
  for (const r of snaps ?? []) { isRecordDemo(r as never) ? snapsDemo++ : snapsReal++; }
  let motivatedDemo = 0, motivatedReal = 0;
  for (const r of motivated ?? []) { isRecordDemo(r as never) ? motivatedDemo++ : motivatedReal++; }
  let anomaliesDemo = 0, anomaliesReal = 0;
  for (const r of anomalies ?? []) { isRecordDemo(r as never) ? anomaliesDemo++ : anomaliesReal++; }
  let signalsDemo = 0, signalsReal = 0;
  for (const r of signals ?? []) { isRecordDemo(r as never) ? signalsDemo++ : signalsReal++; }
  let auctionsDemo = 0, auctionsReal = 0;
  for (const r of auctions ?? []) { isRecordDemo(r as never) ? auctionsDemo++ : auctionsReal++; }

  // Marca dataQuality buckets
  const demo: string[] = [];
  const pushBucket = (label: string, realN: number, demoN: number, total: number) => {
    if (total === 0) { missing.push(label); return; }
    if (realN > 0 && demoN === 0) real.push(label);
    else if (realN > 0 && demoN > 0) { partial.push(label); demo.push(`${label} (${demoN}/${total} demo)`); }
    else demo.push(`${label} (${demoN}/${total} demo)`);
  };
  pushBucket("listing_price_snapshots", snapsReal, snapsDemo, snaps?.length ?? 0);
  pushBucket("motivated_sellers", motivatedReal, motivatedDemo, motivated?.length ?? 0);
  pushBucket("market_anomalies", anomaliesReal, anomaliesDemo, anomalies?.length ?? 0);
  pushBucket("radar_signals", signalsReal, signalsDemo, signals?.length ?? 0);
  pushBucket("auction_signals", auctionsReal, auctionsDemo, auctions?.length ?? 0);
  // OMI: sempre reale (Agenzia Entrate)
  if (omiRows && omiRows.length > 0) real.push("omi_valori"); else missing.push("omi_valori");
  // AOS: parziale a meno che non sia full real
  if (aosRows && aosRows.length > 0) {
    const aosDemoN = (aosRows ?? []).filter((r) => {
      const x = r as { quality?: string; data_basis?: string };
      return isDemoSource(x.quality, x.data_basis);
    }).length;
    if (aosDemoN > 0) { partial.push("area_opportunity_scores"); demo.push(`area_opportunity_scores (${aosDemoN}/${aosRows.length} demo)`); }
    else partial.push("area_opportunity_scores");
  } else missing.push("area_opportunity_scores");

  // Warnings sui demo
  const totalDemoExcluded = !allowDemo
    ? (snapsDemo + motivatedDemo + anomaliesDemo + signalsDemo + auctionsDemo)
    : 0;
  if (!allowDemo && totalDemoExcluded > 0) {
    warnings.push(`${totalDemoExcluded} record demo (seed_demo_veneto) esclusi da allowDemo=false (snaps:${snapsDemo}, motiv:${motivatedDemo}, anom:${anomaliesDemo}, sig:${signalsDemo}, aste:${auctionsDemo}).`);
  }
  if (allowDemo) {
    const includedDemo = snapsDemo + motivatedDemo + anomaliesDemo + signalsDemo + auctionsDemo;
    if (includedDemo > 0) warnings.push(`${includedDemo} record demo inclusi solo per test perché allowDemo=true.`);
  }

  // ── Aggregazione per zona ───────────────────────────────────
  const aggMap = new Map<string, ZoneAgg>();
  const ensure = (comune: string, prov: ProvCode): ZoneAgg => {
    const k = aggKey(comune, prov);
    let a = aggMap.get(k);
    if (!a) { a = emptyAgg({ comune, provincia: prov }); aggMap.set(k, a); }
    return a;
  };

  for (const r of snaps ?? []) {
    const row = r as { province: string|null; municipality: string|null; price_eur: number|null; surface_sqm: number|null; lat: number|null; lng: number|null; captured_at: string; source: string|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const isDemo = isDemoSource(row.source);
    if (isDemo && !allowDemo) continue; // ESCLUDI demo
    const a = ensure(row.municipality, prov);
    if (isDemo) { a.annunciAttiviDemo++; a.hasDemoSource = true; }
    else { a.annunciAttivi++; a.hasRealSource = true; }
    if (!isDemo && row.price_eur && row.surface_sqm && row.surface_sqm > 10 && row.surface_sqm < 2000) {
      a.prezziPerSqm.push(row.price_eur / row.surface_sqm);
    }
    const dDays = (Date.now() - new Date(row.captured_at).getTime()) / 86400_000;
    if (!isDemo && dDays >= 0 && dDays <= 365) a.daysOnline.push(dDays);
    if (a.lat == null && typeof row.lat === "number") { a.lat = row.lat; a.lng = row.lng; }
  }

  for (const r of motivated ?? []) {
    const row = r as { province: string|null; municipality: string|null; days_online: number|null; source: string|null; payload: Record<string, unknown>|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const isDemo = isRecordDemo(row as never);
    if (isDemo && !allowDemo) continue;
    const a = ensure(row.municipality, prov);
    if (isDemo) { a.venditoriMotivatiDemo++; a.hasDemoSource = true; }
    else { a.venditoriMotivati++; a.hasRealSource = true; }
  }

  for (const r of anomalies ?? []) {
    const row = r as { province: string|null; municipality: string|null; anomaly_type: string|null; payload: Record<string, unknown>|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const isDemo = isRecordDemo(row as never);
    if (isDemo && !allowDemo) continue;
    const a = ensure(row.municipality, prov);
    const isRibasso = (row.anomaly_type ?? "").toLowerCase().includes("ribass");
    if (isRibasso) {
      if (isDemo) { a.ribassi30ggDemo++; a.hasDemoSource = true; }
      else { a.ribassi30gg++; a.hasRealSource = true; }
    }
  }

  // auction_signals → conta come aste aggiuntive
  for (const r of auctions ?? []) {
    const row = r as { province: string|null; municipality: string|null; source_name: string|null; payload: Record<string, unknown>|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const isDemo = isRecordDemo(row as never);
    if (isDemo && !allowDemo) continue;
    const a = ensure(row.municipality, prov);
    if (isDemo) { a.asteDemo++; a.hasDemoSource = true; }
    else { a.aste++; a.hasRealSource = true; }
  }

  // area_opportunity_scores → boost zone già scorate da Civiko Data Engine
  const aosBoost = new Map<string, { score: number; quality: string; demo: boolean }>();
  for (const r of aosRows ?? []) {
    const row = r as { province: string|null; municipality: string|null; score: number|null; quality: string|null; data_basis: string|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality || row.score == null) continue;
    const aosDemo = isDemoSource(row.quality, row.data_basis);
    if (aosDemo && !allowDemo) continue;
    aosBoost.set(aggKey(row.municipality, prov), { score: Number(row.score), quality: row.quality ?? "parziale", demo: aosDemo });
    // Crea zona se non esiste
    const a = ensure(row.municipality, prov);
    if (aosDemo) a.hasDemoSource = true;
  }

  for (const r of signals ?? []) {
    const row = r as { province: string|null; municipality: string|null; signal_type: string|null; lat: number|null; lng: number|null; source: string|null; payload: Record<string, unknown>|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const isDemo = isRecordDemo(row as never);
    if (isDemo && !allowDemo) continue;
    const a = ensure(row.municipality, prov);
    const t = (row.signal_type ?? "").toLowerCase();
    if (t.includes("asta")) {
      if (isDemo) { a.asteDemo++; a.hasDemoSource = true; }
      else { a.aste++; a.hasRealSource = true; }
    }
    if (a.lat == null && typeof row.lat === "number") { a.lat = row.lat; a.lng = row.lng; }
  }

  // OMI aggregato per comune
  const omiByComune = new Map<string, { vals: number[]; fascia: string | null; zona: string | null }>();
  for (const r of omiRows ?? []) {
    const row = r as { provincia: string|null; comune_descrizione: string|null; fascia: string|null; zona: string|null; compr_min: number|null; compr_max: number|null };
    const prov = isVenetoRow(row.provincia);
    if (!prov || !row.comune_descrizione) continue;
    const k = aggKey(row.comune_descrizione, prov);
    let o = omiByComune.get(k);
    if (!o) { o = { vals: [], fascia: row.fascia ?? null, zona: row.zona ?? null }; omiByComune.set(k, o); }
    if (row.compr_max) o.vals.push(Number(row.compr_max));
    if (row.compr_min) o.vals.push(Number(row.compr_min));
  }
  for (const [k, o] of omiByComune.entries()) {
    let a = aggMap.get(k);
    if (!a) {
      // ── Crea zona OMI-only per Veneto: dati reali OMI senza altri segnali ──
      const [prov, comuneLower] = k.split(":");
      // Recover original casing from omiRows
      const orig = (omiRows ?? []).find((r) => {
        const row = r as { provincia: string|null; comune_descrizione: string|null };
        const p = isVenetoRow(row.provincia);
        return p === prov && (row.comune_descrizione ?? "").toLowerCase().trim() === comuneLower;
      }) as { comune_descrizione: string } | undefined;
      const comune = orig?.comune_descrizione ?? comuneLower;
      a = emptyAgg({ comune, provincia: prov as ProvCode });
      aggMap.set(k, a);
    }
    if (o.vals.length > 0) {
      a.omiValoreMedio = Math.round(o.vals.reduce((x, y) => x + y, 0) / o.vals.length);
      a.omiFascia = o.fascia;
      a.omiMicrozona = o.zona;
      a.omiQuality = "reale";
    }
  }

  // ── Scoring + build zones ───────────────────────────────────
  const zones: AgentRadarZone[] = [];
  for (const a of aggMap.values()) {
    // Metrics effettive: somma reale + demo (se demo è stato ammesso)
    const annunciTot = a.annunciAttivi + a.annunciAttiviDemo;
    const ribassiTot = a.ribassi30gg + a.ribassi30ggDemo;
    const asteTot = a.aste + a.asteDemo;
    const motivTot = a.venditoriMotivati + a.venditoriMotivatiDemo;

    let score = 0;
    score += Math.min(20, ribassiTot * 5);
    score += Math.min(20, motivTot * 4);
    score += Math.min(15, asteTot * 5);
    score += Math.min(15, Math.log10(1 + annunciTot) * 10);
    const askingMed = median(a.prezziPerSqm);
    let omiGapPct: number | null = null;
    if (askingMed && a.omiValoreMedio) {
      omiGapPct = ((askingMed - a.omiValoreMedio) / a.omiValoreMedio) * 100;
      score += Math.min(20, Math.max(0, omiGapPct) * 0.6);
    }
    const giorniMedi = median(a.daysOnline);
    if (giorniMedi && giorniMedi > 120) score += 10;

    if (a.omiQuality === "reale") {
      score += 8;
      const CAPOLUOGHI: Record<string, number> = {
        "VE:venezia": 12, "VE:mestre": 10,
        "VR:verona": 12, "VI:vicenza": 12, "PD:padova": 12,
        "TV:treviso": 12, "BL:belluno": 10, "RO:rovigo": 10,
      };
      score += CAPOLUOGHI[aggKey(a.comune, a.provincia)] ?? 0;
    }

    const aosHit = aosBoost.get(aggKey(a.comune, a.provincia));
    if (aosHit) score = Math.max(score, aosHit.score);
    score = Math.round(Math.min(100, score));

    let signalType: AgentRadarZone["signalType"] = "misto";
    const flags: number[] = [ribassiTot, asteTot, motivTot, annunciTot, omiGapPct ? 1 : 0];
    if (asteTot > 0 && asteTot >= Math.max(...flags)) signalType = "asta";
    else if (ribassiTot > 0 && ribassiTot >= motivTot) signalType = "ribasso";
    else if (motivTot > 0) signalType = "motivato";
    else if (omiGapPct && omiGapPct > 5) signalType = "omi_gap";
    else if (annunciTot > 20) signalType = "stock";

    const reasons: string[] = [];
    if (ribassiTot) reasons.push(`${ribassiTot} ribassi recenti`);
    if (motivTot) reasons.push(`${motivTot} venditori motivati`);
    if (asteTot) reasons.push(`${asteTot} aste attive`);
    if (omiGapPct !== null) reasons.push(`gap OMI ${omiGapPct > 0 ? "+" : ""}${omiGapPct.toFixed(0)}%`);
    if (annunciTot) reasons.push(`${annunciTot} annunci attivi`);

    const action = signalType === "asta" ? "Verifica fascicoli PVP e contatta i creditori procedenti."
      : signalType === "ribasso" ? "Apri mandati su immobili con ribasso >10% e prezzo target sotto OMI max."
      : signalType === "motivato" ? "Contatta venditori con giacenza >120gg con offerta strutturata."
      : signalType === "omi_gap" ? "Negozia mandati allineati al valore OMI medio."
      : signalType === "stock" ? "Audit stock zona e selezione immobili da rinegoziare."
      : "Mappatura segnali combinati: priorità a contatti caldi.";

    // ── Quality della zona: peggior fonte vince ──
    // Se i segnali commerciali sono tutti demo → demo (anche se OMI è reale, i segnali commerciali non lo sono).
    const commercialSignalsReal = a.annunciAttivi + a.ribassi30gg + a.aste + a.venditoriMotivati;
    const commercialSignalsDemo = a.annunciAttiviDemo + a.ribassi30ggDemo + a.asteDemo + a.venditoriMotivatiDemo;
    let quality: AgentRadarZone["quality"];
    if (commercialSignalsDemo > 0 && commercialSignalsReal === 0) {
      quality = a.omiQuality === "reale" ? "parziale" : "demo";
      // Se la zona deve la propria opportunità a segnali demo, marcala come demo
      if (commercialSignalsDemo > 0) quality = "demo";
    } else if (commercialSignalsReal > 0 && a.omiQuality === "reale") {
      quality = commercialSignalsDemo > 0 ? "parziale" : "reale";
    } else if (a.omiQuality === "reale") {
      // OMI-only: parziale (OMI da solo non basta a dichiarare opportunità reale)
      quality = "parziale";
    } else if (commercialSignalsReal > 0 || commercialSignalsDemo > 0) {
      quality = commercialSignalsDemo > 0 ? "demo" : "parziale";
    } else {
      quality = "stimato";
    }

    zones.push({
      id: `${a.provincia}-${a.comune.toLowerCase().replace(/\s+/g, "-")}`,
      comune: a.comune,
      provincia: a.provincia,
      lat: a.lat,
      lng: a.lng,
      score,
      temperature: temperatureFromScore(score),
      signalType,
      title: `${a.comune} — ${signalLabel(signalType)}`,
      reason: reasons.length ? reasons.join(", ") : "Segnali aggregati per la zona.",
      agentAction: action,
      omi: {
        available: a.omiQuality === "reale",
        valoreMedio: a.omiValoreMedio,
        fascia: a.omiFascia,
        microzona: a.omiMicrozona,
        quality: a.omiQuality,
      },
      metrics: {
        annunciAttivi: annunciTot || null,
        ribassi30gg: ribassiTot || null,
        aste: asteTot || null,
        venditoriMotivati: motivTot || null,
        giorniMediMercato: giorniMedi ? Math.round(giorniMedi) : null,
      },
      quality,
    });
  }

  zones.sort((a, b) => b.score - a.score);
  const topZones = zones.slice(0, maxZones);

  // ── Opportunities da top zones ──────────────────────────────
  const opportunities: AgentRadarOpportunity[] = topZones
    .filter((z) => z.score >= 30 && z.quality !== "demo")
    .slice(0, 6)
    .map((z, i) => {
      const basis: string[] = [];
      if (z.metrics.ribassi30gg) basis.push("market_anomalies");
      if (z.metrics.venditoriMotivati) basis.push("motivated_sellers");
      if (z.metrics.aste) basis.push("radar_signals");
      if (z.omi.available) basis.push("omi_valori");
      if (z.metrics.annunciAttivi) basis.push("listing_price_snapshots");
      const script = z.signalType === "ribasso"
        ? `Buongiorno, ho visto che l'immobile è online da diverso tempo con un paio di ribassi. Lavoro su ${z.comune} con dati OMI aggiornati: posso proporle una valutazione realistica e una strategia per chiudere entro 60 giorni.`
        : z.signalType === "motivato"
        ? `Buongiorno, sono operativo su ${z.comune}. Ho un quadro aggiornato di domanda e prezzo medio: vuole che le mostri come riposizionare l'immobile per attivare visite reali?`
        : z.signalType === "asta"
        ? `Buongiorno, seguo le procedure su ${z.comune}. Posso aiutarla a leggere il fascicolo e valutare l'opportunità prima dell'asta.`
        : `Buongiorno, ho un'analisi aggiornata della zona ${z.comune}: stock, prezzi medi e gap OMI. Posso passare a illustrarla?`;
      return {
        id: `op-${z.id}-${i}`,
        priority: priorityFromScore(z.score),
        comune: z.comune,
        provincia: z.provincia,
        headline: `${z.comune}: ${signalLabel(z.signalType)} (score ${z.score})`,
        whyNow: z.reason,
        recommendedMove: z.agentAction,
        script,
        dataBasis: basis,
      };
    });

  // ── Dataset status & summary ────────────────────────────────
  // Conteggi REALI (post-filtro demo), non grezzi
  const realCommercialRows = snapsReal + motivatedReal + anomaliesReal + signalsReal + auctionsReal;
  const demoCommercialRows = snapsDemo + motivatedDemo + anomaliesDemo + signalsDemo + auctionsDemo;
  const omiAvailable = (omiRows?.length ?? 0) > 0;
  const provincesCovered = new Set(
    zones.filter((z) => z.quality !== "demo").map((z) => z.provincia)
  ).size;

  let datasetStatus: "complete" | "partial" | "empty" = "empty";
  if (!omiAvailable && realCommercialRows === 0 && demoCommercialRows === 0) {
    datasetStatus = "empty";
  } else if (
    omiAvailable &&
    realCommercialRows >= 50 &&
    snapsReal >= 20 &&
    provincesCovered >= 4 &&
    demoCommercialRows === 0 // nessuna dipendenza significativa da seed demo
  ) {
    datasetStatus = "complete";
  } else {
    datasetStatus = "partial";
  }

  let finalZones = topZones;
  let dataQualityOverall: AgentRadarResponse["summary"]["dataQuality"];

  if (datasetStatus === "empty") {
    finalZones = [];
    dataQualityOverall = "mancante";
  } else if (realCommercialRows === 0 && omiAvailable) {
    dataQualityOverall = "parziale";
  } else if (datasetStatus === "complete") {
    dataQualityOverall = "reale";
  } else {
    dataQualityOverall = "parziale";
  }

  const summary = {
    totalSignals: (anomaliesReal + signalsReal + motivatedReal) + (allowDemo ? (anomaliesDemo + signalsDemo + motivatedDemo) : 0),
    hotZones: finalZones.filter((z) => z.temperature === "calda" || z.temperature === "molto_calda").length,
    priceDrops: (anomalies ?? []).filter((a) => {
      const x = a as { anomaly_type: string|null };
      const isDemo = isRecordDemo(a as never);
      if (isDemo && !allowDemo) return false;
      return (x.anomaly_type ?? "").toLowerCase().includes("ribass");
    }).length,
    auctions: ((auctions ?? []).filter((s) => (!isRecordDemo(s as never) || allowDemo)).length)
      + ((signals ?? []).filter((s) => {
        const x = s as { signal_type: string|null };
        if (isRecordDemo(s as never) && !allowDemo) return false;
        return (x.signal_type ?? "").toLowerCase().includes("asta");
      }).length),
    motivatedSellers: motivatedReal + (allowDemo ? motivatedDemo : 0),
    dataQuality: dataQualityOverall,
  };

  const message =
    datasetStatus === "empty" ? "Nessun dato Veneto reale disponibile. Popolare omi-import, scraping portali e job radar."
    : datasetStatus === "partial" ? "Dataset parziale: dati reali/parziali insufficienti per dichiarare copertura completa."
    : "Dataset Veneto completo: OMI reale + listing reali + copertura multi-provincia.";

  // POLICY PRODUZIONE: nessun record demo restituito al client. Mantieni demo:[] per retro-compat.
  return {
    configured: !!supa,
    scope: { region: "Veneto", province: VENETO_PROVINCES, datasetStatus, message },
    summary,
    zones: finalZones.filter((z) => z.quality !== "demo"),
    opportunities: datasetStatus === "empty" ? [] : opportunities.filter((o) => true),
    dataQuality: { real, partial, demo: [], missing, warnings },
  };
}

function fullProvName(p: ProvCode): string {
  return ({ VE: "Venezia", VR: "Verona", VI: "Vicenza", PD: "Padova", TV: "Treviso", BL: "Belluno", RO: "Rovigo" } as const)[p];
}

function signalLabel(t: AgentRadarZone["signalType"]): string {
  switch (t) {
    case "asta": return "aste attive";
    case "ribasso": return "ribassi recenti";
    case "motivato": return "venditori motivati";
    case "omi_gap": return "gap OMI/asking";
    case "stock": return "stock elevato";
    case "domanda": return "domanda in crescita";
    default: return "segnali misti";
  }
}
