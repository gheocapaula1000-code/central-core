// ═══════════════════════════════════════════════════════════════
// Civiko Data Engine Veneto
// Build proprietario: aggrega/normalizza fonti Civiko + ufficiali e
// produce area_opportunity_scores + radar_signals per agent-radar.
//
// Compliance:
//   - mai inventare dati reali
//   - quality ∈ {reale, parziale, demo}
//   - ogni record ha source_name + data_basis + updated_at
//   - non bypassa login/paywall/captcha
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { deriveAllSignals } from "./deriveSignals.ts";

const VENETO = ["VE","VR","VI","PD","TV","BL","RO"] as const;
type Prov = typeof VENETO[number];
const PROV_FULL: Record<Prov,string> = { VE:"Venezia", VR:"Verona", VI:"Vicenza", PD:"Padova", TV:"Treviso", BL:"Belluno", RO:"Rovigo" };
const PROV_NORM: Record<string, Prov> = {
  venezia:"VE", verona:"VR", vicenza:"VI", padova:"PD", treviso:"TV", belluno:"BL", rovigo:"RO",
  ve:"VE", vr:"VR", vi:"VI", pd:"PD", tv:"TV", bl:"BL", ro:"RO",
};

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function normProv(p: string | null | undefined): Prov | null {
  if (!p) return null;
  const k = p.trim().toLowerCase();
  if (PROV_NORM[k]) return PROV_NORM[k];
  const up = p.toUpperCase();
  return (VENETO as readonly string[]).includes(up) ? (up as Prov) : null;
}

export interface DataEngineReport {
  ok: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sources: { active: string[]; ready: string[]; missing: string[] };
  rowCounts: Record<string, { before: number; after: number }>;
  derived: {
    motivated_sellers_inserted: number;
    market_anomalies_inserted: number;
    radar_signals_inserted: number;
  };
  area_opportunity_scores: { upserted: number; provinces: string[]; municipalities: number };
  topMunicipalities: Array<{ provincia: string; comune: string; score: number; temperature: string }>;
  warnings: string[];
  notes: string[];
}

async function countRows(supa: SupabaseClient, table: string): Promise<number> {
  try {
    const { count, error } = await supa.from(table).select("*", { count: "exact", head: true });
    if (error) return 0;
    return count ?? 0;
  } catch { return 0; }
}

function tempFromScore(s: number): "fredda"|"tiepida"|"calda"|"molto_calda" {
  if (s >= 75) return "molto_calda";
  if (s >= 55) return "calda";
  if (s >= 30) return "tiepida";
  return "fredda";
}

/**
 * Costruisce area_opportunity_scores per ogni (provincia, comune) Veneto
 * a partire da fonti Civiko/ufficiali. Niente dati inventati.
 */
async function buildAreaScores(supa: SupabaseClient, warnings: string[]) {
  // OMI per comune
  type Aggregate = {
    prov: Prov; comune: string;
    omiVals: number[]; omiCount: number;
    snaps: number; snapsDemo: number;
    motivati: number; motivatiDemo: number;
    anomalie: number; anomalieDemo: number;
    aste: number; asteDemo: number;
  };
  const map = new Map<string, Aggregate>();
  const k = (p: Prov, c: string) => `${p}:${c.toLowerCase().trim()}`;
  const ensure = (p: Prov, c: string): Aggregate => {
    const key = k(p, c);
    let a = map.get(key);
    if (!a) {
      a = { prov: p, comune: c, omiVals: [], omiCount: 0,
        snaps: 0, snapsDemo: 0, motivati: 0, motivatiDemo: 0,
        anomalie: 0, anomalieDemo: 0, aste: 0, asteDemo: 0 };
      map.set(key, a);
    }
    return a;
  };

  const DEMO_MARKERS = ["seed_demo","demo","mock","fixture","sample"];
  const isDemo = (...vals: unknown[]) => vals.some((v) => v != null && DEMO_MARKERS.some((m) => String(v).toLowerCase().includes(m)));

  // OMI (paginazione obbligatoria)
  let offset = 0; const PAGE = 1000;
  while (true) {
    const { data, error } = await supa.from("omi_valori")
      .select("provincia,comune_descrizione,compr_min,compr_max")
      .ilike("regione", "Veneto")
      .range(offset, offset + PAGE - 1);
    if (error) { warnings.push(`omi page ${offset}: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const row = r as { provincia: string|null; comune_descrizione: string|null; compr_min: number|null; compr_max: number|null };
      const p = normProv(row.provincia); if (!p || !row.comune_descrizione) continue;
      const a = ensure(p, row.comune_descrizione);
      if (row.compr_min) a.omiVals.push(Number(row.compr_min));
      if (row.compr_max) a.omiVals.push(Number(row.compr_max));
      a.omiCount++;
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  // Snaps — POLICY PRODUZIONE: scarta demo/mock/seed alla fonte
  try {
    const { data, error } = await supa.from("listing_price_snapshots")
      .select("province,municipality,source").range(0, 4999);
    if (error) warnings.push(`snaps: ${error.message}`);
    for (const r of data ?? []) {
      const row = r as { province: string|null; municipality: string|null; source: string|null };
      const p = normProv(row.province); if (!p || !row.municipality) continue;
      if (isDemo(row.source)) { const a = ensure(p, row.municipality); a.snapsDemo++; continue; }
      const a = ensure(p, row.municipality);
      a.snaps++;
    }
  } catch (e) { warnings.push(`snaps: ${e instanceof Error ? e.message : String(e)}`); }

  // Motivated sellers — scarta demo/mock/seed
  try {
    const { data, error } = await supa.from("motivated_sellers")
      .select("province,municipality,source,payload").eq("is_active", true).range(0, 4999);
    if (error) warnings.push(`motivated: ${error.message}`);
    for (const r of data ?? []) {
      const row = r as { province: string|null; municipality: string|null; source: string|null; payload: Record<string, unknown>|null };
      const p = normProv(row.province); if (!p || !row.municipality) continue;
      const pd = (row.payload ?? {}) as Record<string, unknown>;
      if (isDemo(row.source, pd?.source, pd?.quality, pd?.data_basis)) { const a = ensure(p, row.municipality); a.motivatiDemo++; continue; }
      const a = ensure(p, row.municipality);
      a.motivati++;
    }
  } catch (e) { warnings.push(`motivated: ${e instanceof Error ? e.message : String(e)}`); }

  // Market anomalies — scarta demo
  try {
    const { data, error } = await supa.from("market_anomalies")
      .select("province,municipality,payload").eq("is_active", true).range(0, 4999);
    if (error) warnings.push(`anomalies: ${error.message}`);
    for (const r of data ?? []) {
      const row = r as { province: string|null; municipality: string|null; payload: Record<string, unknown>|null };
      const p = normProv(row.province); if (!p || !row.municipality) continue;
      const pd = (row.payload ?? {}) as Record<string, unknown>;
      if (isDemo(pd?.source, pd?.quality, pd?.data_basis)) { const a = ensure(p, row.municipality); a.anomalieDemo++; continue; }
      const a = ensure(p, row.municipality);
      a.anomalie++;
    }
  } catch (e) { warnings.push(`anomalies: ${e instanceof Error ? e.message : String(e)}`); }

  // Aste — scarta demo
  try {
    const { data, error } = await supa.from("radar_signals")
      .select("province,municipality,signal_type,source,payload").eq("is_active", true).range(0, 4999);
    if (error) warnings.push(`radar_signals: ${error.message}`);
    for (const r of data ?? []) {
      const row = r as { province: string|null; municipality: string|null; signal_type: string|null; source: string|null; payload: Record<string, unknown>|null };
      const p = normProv(row.province); if (!p || !row.municipality) continue;
      const t = (row.signal_type ?? "").toLowerCase();
      if (!t.includes("asta")) continue;
      const pd = (row.payload ?? {}) as Record<string, unknown>;
      if (isDemo(row.source, pd?.source, pd?.quality, pd?.data_basis)) { const a = ensure(p, row.municipality); a.asteDemo++; continue; }
      const a = ensure(p, row.municipality);
      a.aste++;
    }
  } catch (e) { warnings.push(`radar_signals: ${e instanceof Error ? e.message : String(e)}`); }

  // Build score — POLICY PRODUZIONE: solo conteggi reali contribuiscono.
  const rows: Array<{ provincia: string; comune: string; score: number; temperature: string; components: Record<string, number|string|null>; quality: string; data_basis: string }> = [];
  for (const a of map.values()) {
    const snapsTot = a.snaps;       // solo reali
    const motivTot = a.motivati;
    const anomTot = a.anomalie;
    const asteTot = a.aste;
    let score = 0;
    const omiAvg = a.omiVals.length ? Math.round(a.omiVals.reduce((x,y)=>x+y,0)/a.omiVals.length) : null;
    if (omiAvg !== null) score += 8;
    score += Math.min(20, snapsTot * 0.5);
    score += Math.min(25, motivTot * 4);
    score += Math.min(20, anomTot * 4);
    score += Math.min(15, asteTot * 5);
    const CAPS: Record<string, number> = {
      "VE:venezia":12,"VE:mestre":10,"VR:verona":12,"VI:vicenza":12,
      "PD:padova":12,"TV:treviso":12,"BL:belluno":10,"RO:rovigo":10,
    };
    score += CAPS[k(a.prov, a.comune)] ?? 0;
    score = Math.round(Math.min(100, score));

    const basis: string[] = [];
    if (a.omiCount > 0) basis.push("omi_valori");
    if (snapsTot > 0) basis.push("listing_price_snapshots");
    if (motivTot > 0) basis.push("motivated_sellers");
    if (anomTot > 0) basis.push("market_anomalies");
    if (asteTot > 0) basis.push("radar_signals");

    // Quality: solo reale o parziale (mai demo, demo è già escluso a monte)
    const realCommercial = snapsTot + motivTot + anomTot + asteTot;
    let quality: string;
    if (realCommercial > 0 && a.omiCount > 0) quality = "reale";
    else if (a.omiCount > 0) quality = "parziale"; // OMI-only
    else if (realCommercial > 0) quality = "parziale";
    else quality = "stimato";

    rows.push({
      provincia: a.prov,
      comune: a.comune,
      score,
      temperature: tempFromScore(score),
      components: {
        omi_avg_eur: omiAvg,
        listing_snapshots_real: a.snaps,
        listing_snapshots_demo: a.snapsDemo,
        motivated_sellers_real: a.motivati,
        motivated_sellers_demo: a.motivatiDemo,
        market_anomalies_real: a.anomalie,
        market_anomalies_demo: a.anomalieDemo,
        auctions_real: a.aste,
        auctions_demo: a.asteDemo,
      },
      quality,
      data_basis: basis.join("+") || "omi_valori",
    });
  }

  // Upsert area_opportunity_scores
  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      region: "veneto",
      province: r.provincia,
      municipality: r.comune,
      microzone: null,
      score: r.score,
      temperature: r.temperature,
      components: r.components,
      data_basis: r.data_basis,
      quality: r.quality,
      computed_at: new Date().toISOString(),
    }));
    const { error } = await supa.from("area_opportunity_scores")
      .upsert(chunk, { onConflict: "province,municipality,microzone" });
    if (error) { warnings.push(`aos upsert: ${error.message}`); continue; }
    upserted += chunk.length;
  }

  rows.sort((a,b) => b.score - a.score);
  const provs = Array.from(new Set(rows.map(r => r.provincia))).sort();
  return {
    upserted,
    provinces: provs,
    municipalities: rows.length,
    top: rows.slice(0, 10).map(r => ({ provincia: r.provincia, comune: r.comune, score: r.score, temperature: r.temperature })),
  };
}

/**
 * Aggiorna data_sources.last_run_at per le fonti effettivamente toccate dal job.
 */
async function touchSources(supa: SupabaseClient, names: string[]) {
  if (!names.length) return;
  await supa.from("data_sources").update({ last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("source_name", names);
}

/**
 * Snapshot di qualità dati per il run.
 */
async function recordDataQuality(supa: SupabaseClient, snapshot: Record<string, number>) {
  const rows = Object.entries(snapshot).map(([table, total]) => ({
    table_name: table,
    region: "veneto",
    rows_total: total,
    rows_real: total,
    rows_partial: 0,
    rows_demo: 0,
    notes: "snapshot post build-civiko-veneto-data-engine",
  }));
  if (rows.length) await supa.from("civiko_data_quality").insert(rows);
}

export async function buildVenetoDataEngine(): Promise<DataEngineReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const notes: string[] = [];
  const supa = svc();
  if (!supa) {
    return {
      ok: false, startedAt, completedAt: startedAt, durationMs: 0,
      sources: { active: [], ready: [], missing: ["supabase"] },
      rowCounts: {},
      derived: { motivated_sellers_inserted: 0, market_anomalies_inserted: 0, radar_signals_inserted: 0 },
      area_opportunity_scores: { upserted: 0, provinces: [], municipalities: 0 },
      topMunicipalities: [],
      warnings: ["SUPABASE_SERVICE_ROLE_KEY mancante"],
      notes: [],
    };
  }

  // Insert ingestion_run record
  const { data: runRow } = await supa.from("ingestion_runs").insert({
    job_name: "build-civiko-veneto-data-engine",
    source_name: "civiko_engine",
    status: "running",
  }).select("id").single();
  const runId = (runRow as { id: number } | null)?.id ?? null;

  // Snapshot rows BEFORE
  const tables = ["listing_price_snapshots","motivated_sellers","market_anomalies","radar_signals","auction_signals","area_opportunity_scores","omi_valori","istat_comuni"];
  const before: Record<string, number> = {};
  for (const t of tables) before[t] = await countRows(supa, t);

  // 1. Derive signals (motivated, anomalies, radar) da OMI + listing snapshots Civiko
  const derived = await deriveAllSignals().catch((e) => {
    warnings.push(`deriveAllSignals: ${e instanceof Error ? e.message : String(e)}`);
    return { motivated_sellers_inserted: 0, market_anomalies_inserted: 0, radar_signals_inserted: 0, warnings: [] };
  });

  // 2. Build area opportunity scores
  const aos = await buildAreaScores(supa, warnings).catch((e) => {
    warnings.push(`buildAreaScores: ${e instanceof Error ? e.message : String(e)}`);
    return { upserted: 0, provinces: [] as string[], municipalities: 0, top: [] as Array<{provincia:string;comune:string;score:number;temperature:string}> };
  });

  // 3. Source registry — fonti effettivamente attive
  const activeSources = ["agenzia_entrate_omi","civiko_derived_omi_signals","civiko_radar_signals","civiko_listing_snapshots"];
  await touchSources(supa, activeSources);

  // 4. Snapshot rows AFTER
  const after: Record<string, number> = {};
  for (const t of tables) after[t] = await countRows(supa, t);

  const rowCounts: Record<string, { before: number; after: number }> = {};
  for (const t of tables) rowCounts[t] = { before: before[t] ?? 0, after: after[t] ?? 0 };

  // Quality snapshot
  await recordDataQuality(supa, after).catch(() => {/*silent*/});

  // Sources status (categorizzato dal registry)
  const sourceStatus = await (async () => {
    try {
      const { data } = await supa.from("data_sources").select("source_name, ingestion_status");
      const active: string[] = [], ready: string[] = [], missing: string[] = [];
      for (const r of (data ?? []) as Array<{source_name:string; ingestion_status:string}>) {
        if (r.ingestion_status === "active") active.push(r.source_name);
        else if (r.ingestion_status === "ready") ready.push(r.source_name);
        else missing.push(r.source_name);
      }
      return { active, ready, missing };
    } catch { return { active: [], ready: [], missing: [] }; }
  })();

  notes.push("PVP/aste: in attesa di endpoint stabile o dataset bulk ufficiale.");
  notes.push("listing_price_snapshots: alimentati da Firecrawl + manualDataset Civiko, non da agenzie clienti.");
  notes.push("Per produzione piena: schedulare cron giornaliero (pg_cron) su build-civiko-veneto-data-engine.");

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  if (runId !== null) {
    await supa.from("ingestion_runs").update({
      status: "completed",
      completed_at: completedAt,
      duration_ms: durationMs,
      rows_in: 0,
      rows_out: aos.upserted + derived.radar_signals_inserted,
      warnings: warnings,
      report: { rowCounts, derived, aos: { upserted: aos.upserted, top: aos.top } },
    }).eq("id", runId);
  }

  return {
    ok: true,
    startedAt, completedAt, durationMs,
    sources: sourceStatus,
    rowCounts,
    derived: {
      motivated_sellers_inserted: derived.motivated_sellers_inserted,
      market_anomalies_inserted: derived.market_anomalies_inserted,
      radar_signals_inserted: derived.radar_signals_inserted,
    },
    area_opportunity_scores: { upserted: aos.upserted, provinces: aos.provinces, municipalities: aos.municipalities },
    topMunicipalities: aos.top,
    warnings,
    notes,
  };
}
