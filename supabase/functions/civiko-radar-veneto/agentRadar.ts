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
    missing: string[];
    warnings: string[];
  };
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
  ribassi30gg: number;
  aste: number;
  venditoriMotivati: number;
  prezziPerSqm: number[];
  daysOnline: number[];
  omiValoreMedio: number | null;
  omiFascia: string | null;
  omiMicrozona: string | null;
  omiQuality: "reale" | "stimato" | "mancante";
}

function emptyAgg(k: AggKey): ZoneAgg {
  return {
    comune: k.comune, provincia: k.provincia,
    lat: null, lng: null,
    annunciAttivi: 0, ribassi30gg: 0, aste: 0, venditoriMotivati: 0,
    prezziPerSqm: [], daysOnline: [],
    omiValoreMedio: null, omiFascia: null, omiMicrozona: null, omiQuality: "mancante",
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
  const allowDemo = req.allowDemo === true;

  const supa = getServiceClient();
  if (!supa) {
    return {
      configured: false,
      scope: { region: "Veneto", province: VENETO_PROVINCES, datasetStatus: "empty", message: "Backend non configurato (SUPABASE_SERVICE_ROLE_KEY mancante)." },
      summary: { totalSignals: 0, hotZones: 0, priceDrops: 0, auctions: 0, motivatedSellers: 0, dataQuality: "mancante" },
      zones: allowDemo ? buildDemoZones(filterProv).slice(0, 3) : [],
      opportunities: [],
      dataQuality: { real: [], partial: [], missing: ["supabase"], warnings: ["Service role mancante."] },
    };
  }

  // ── Pull dati (best-effort, ognuno in try/catch) ────────────
  const snaps = await safe("listing_price_snapshots", async () => {
    let q = supa.from("listing_price_snapshots")
      .select("province,municipality,price_eur,surface_sqm,lat,lng,captured_at")
      .gte("captured_at", new Date(Date.now() - 60 * 86400_000).toISOString());
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 4999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  const motivated = await safe("motivated_sellers", async () => {
    let q = supa.from("motivated_sellers")
      .select("province,municipality,days_online,total_drop_pct,fatigue_score,is_active")
      .eq("is_active", true);
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 1999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  const anomalies = await safe("market_anomalies", async () => {
    let q = supa.from("market_anomalies")
      .select("province,municipality,anomaly_type,detected_at,is_active")
      .eq("is_active", true);
    if (filterProv) q = q.in("province", [filterProv, fullProvName(filterProv)].filter(Boolean) as string[]);
    const { data, error } = await q.range(0, 1999);
    if (error) throw error;
    return data ?? [];
  }, warnings);

  const signals = await safe("radar_signals", async () => {
    let q = supa.from("radar_signals")
      .select("province,municipality,signal_type,is_active,lat,lng")
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

  if (snaps && snaps.length > 0) real.push("listing_price_snapshots"); else missing.push("listing_price_snapshots");
  if (motivated && motivated.length > 0) real.push("motivated_sellers"); else missing.push("motivated_sellers");
  if (anomalies && anomalies.length > 0) real.push("market_anomalies"); else missing.push("market_anomalies");
  if (signals && signals.length > 0) real.push("radar_signals"); else missing.push("radar_signals");
  if (omiRows && omiRows.length > 0) real.push("omi_valori"); else missing.push("omi_valori");

  // ── Aggregazione per zona ───────────────────────────────────
  const aggMap = new Map<string, ZoneAgg>();
  const ensure = (comune: string, prov: ProvCode): ZoneAgg => {
    const k = aggKey(comune, prov);
    let a = aggMap.get(k);
    if (!a) { a = emptyAgg({ comune, provincia: prov }); aggMap.set(k, a); }
    return a;
  };

  for (const r of snaps ?? []) {
    const row = r as { province: string|null; municipality: string|null; price_eur: number|null; surface_sqm: number|null; lat: number|null; lng: number|null; captured_at: string };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const a = ensure(row.municipality, prov);
    a.annunciAttivi++;
    if (row.price_eur && row.surface_sqm && row.surface_sqm > 10 && row.surface_sqm < 2000) {
      a.prezziPerSqm.push(row.price_eur / row.surface_sqm);
    }
    const dDays = (Date.now() - new Date(row.captured_at).getTime()) / 86400_000;
    if (dDays >= 0 && dDays <= 365) a.daysOnline.push(dDays);
    if (a.lat == null && typeof row.lat === "number") { a.lat = row.lat; a.lng = row.lng; }
  }

  for (const r of motivated ?? []) {
    const row = r as { province: string|null; municipality: string|null; days_online: number|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const a = ensure(row.municipality, prov);
    a.venditoriMotivati++;
  }

  for (const r of anomalies ?? []) {
    const row = r as { province: string|null; municipality: string|null; anomaly_type: string|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const a = ensure(row.municipality, prov);
    if ((row.anomaly_type ?? "").toLowerCase().includes("ribass")) a.ribassi30gg++;
  }

  for (const r of signals ?? []) {
    const row = r as { province: string|null; municipality: string|null; signal_type: string|null; lat: number|null; lng: number|null };
    const prov = isVenetoRow(row.province);
    if (!prov || !row.municipality) continue;
    if (filterComune && row.municipality.toLowerCase() !== filterComune) continue;
    const a = ensure(row.municipality, prov);
    const t = (row.signal_type ?? "").toLowerCase();
    if (t.includes("asta")) a.aste++;
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
    const a = aggMap.get(k);
    if (!a) continue;
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
    let score = 0;
    score += Math.min(20, a.ribassi30gg * 5);
    score += Math.min(20, a.venditoriMotivati * 4);
    score += Math.min(15, a.aste * 5);
    score += Math.min(15, Math.log10(1 + a.annunciAttivi) * 10);
    const askingMed = median(a.prezziPerSqm);
    let omiGapPct: number | null = null;
    if (askingMed && a.omiValoreMedio) {
      omiGapPct = ((askingMed - a.omiValoreMedio) / a.omiValoreMedio) * 100;
      score += Math.min(20, Math.max(0, omiGapPct) * 0.6);
    }
    const giorniMedi = median(a.daysOnline);
    if (giorniMedi && giorniMedi > 120) score += 10;

    score = Math.round(Math.min(100, score));

    let signalType: AgentRadarZone["signalType"] = "misto";
    const flags: number[] = [a.ribassi30gg, a.aste, a.venditoriMotivati, a.annunciAttivi, omiGapPct ? 1 : 0];
    if (a.aste >= Math.max(...flags)) signalType = "asta";
    else if (a.ribassi30gg > 0 && a.ribassi30gg >= a.venditoriMotivati) signalType = "ribasso";
    else if (a.venditoriMotivati > 0) signalType = "motivato";
    else if (omiGapPct && omiGapPct > 5) signalType = "omi_gap";
    else if (a.annunciAttivi > 20) signalType = "stock";

    const reasons: string[] = [];
    if (a.ribassi30gg) reasons.push(`${a.ribassi30gg} ribassi recenti`);
    if (a.venditoriMotivati) reasons.push(`${a.venditoriMotivati} venditori motivati`);
    if (a.aste) reasons.push(`${a.aste} aste attive`);
    if (omiGapPct !== null) reasons.push(`gap OMI ${omiGapPct > 0 ? "+" : ""}${omiGapPct.toFixed(0)}%`);
    if (a.annunciAttivi) reasons.push(`${a.annunciAttivi} annunci attivi`);

    const action = signalType === "asta" ? "Verifica fascicoli PVP e contatta i creditori procedenti."
      : signalType === "ribasso" ? "Apri mandati su immobili con ribasso >10% e prezzo target sotto OMI max."
      : signalType === "motivato" ? "Contatta venditori con giacenza >120gg con offerta strutturata."
      : signalType === "omi_gap" ? "Negozia mandati allineati al valore OMI medio."
      : signalType === "stock" ? "Audit stock zona e selezione immobili da rinegoziare."
      : "Mappatura segnali combinati: priorità a contatti caldi.";

    const allReal = a.omiQuality === "reale" && a.annunciAttivi > 0;
    const someReal = a.omiQuality === "reale" || a.annunciAttivi > 0 || a.venditoriMotivati > 0 || a.aste > 0 || a.ribassi30gg > 0;
    const quality: AgentRadarZone["quality"] = allReal ? "reale" : someReal ? "parziale" : "stimato";

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
        annunciAttivi: a.annunciAttivi || null,
        ribassi30gg: a.ribassi30gg || null,
        aste: a.aste || null,
        venditoriMotivati: a.venditoriMotivati || null,
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
  const totalRows = (snaps?.length ?? 0) + (motivated?.length ?? 0) + (anomalies?.length ?? 0) + (signals?.length ?? 0) + (omiRows?.length ?? 0);
  let datasetStatus: "complete" | "partial" | "empty" = "empty";
  if (totalRows === 0) datasetStatus = "empty";
  else if (real.length >= 4) datasetStatus = "complete";
  else datasetStatus = "partial";

  if (datasetStatus === "partial" && missing.length > 0) partial.push(...real);

  let finalZones = topZones;
  let dataQualityOverall: AgentRadarResponse["summary"]["dataQuality"] = "reale";
  if (datasetStatus === "empty") {
    if (allowDemo) {
      finalZones = buildDemoZones(filterProv).slice(0, 3);
      dataQualityOverall = "demo";
      warnings.push("Dataset vuoto: zone restituite sono DEMO marcate quality='demo'.");
    } else {
      finalZones = [];
      dataQualityOverall = "mancante";
    }
  } else if (datasetStatus === "partial") {
    dataQualityOverall = "parziale";
  } else {
    dataQualityOverall = "reale";
  }

  const summary = {
    totalSignals: (anomalies?.length ?? 0) + (signals?.length ?? 0) + (motivated?.length ?? 0),
    hotZones: finalZones.filter((z) => z.temperature === "calda" || z.temperature === "molto_calda").length,
    priceDrops: (anomalies ?? []).filter((a) => ((a as { anomaly_type: string|null }).anomaly_type ?? "").toLowerCase().includes("ribass")).length,
    auctions: (signals ?? []).filter((s) => ((s as { signal_type: string|null }).signal_type ?? "").toLowerCase().includes("asta")).length,
    motivatedSellers: motivated?.length ?? 0,
    dataQuality: dataQualityOverall,
  };

  const message =
    datasetStatus === "empty" && !allowDemo ? "Nessun dato Veneto disponibile. Popolare omi-import, scraping portali e job radar."
    : datasetStatus === "empty" && allowDemo ? "Nessun dato reale: restituite 3 zone DEMO Veneto a scopo dimostrativo."
    : datasetStatus === "partial" ? "Dataset parziale: alcune fonti non popolate, segnali calcolati su dati disponibili."
    : "Dataset Veneto popolato: zone e opportunità calcolate su dati reali.";

  return {
    configured: !!supa,
    scope: { region: "Veneto", province: VENETO_PROVINCES, datasetStatus, message },
    summary,
    zones: finalZones,
    opportunities: datasetStatus === "empty" ? [] : opportunities,
    dataQuality: { real, partial, missing, warnings },
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
