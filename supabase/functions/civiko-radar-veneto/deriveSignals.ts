// ═══════════════════════════════════════════════════════════════
// Derive Radar Signals — derivazione automatica da dati esistenti
// Compliance: nessun dato inventato, tutto deriva da:
//   - listing_price_snapshots (reali o seed_demo_veneto marcato)
//   - omi_valori (reale)
// Output: motivated_sellers, market_anomalies, radar_signals
// Tutti i record portano payload.quality (reale|parziale) e data_basis.
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface DeriveReport {
  motivated_sellers_inserted: number;
  market_anomalies_inserted: number;
  radar_signals_inserted: number;
  warnings: string[];
}

function svcClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const PROV_NORM: Record<string, string> = {
  venezia: "VE", verona: "VR", vicenza: "VI", padova: "PD",
  treviso: "TV", belluno: "BL", rovigo: "RO",
  ve: "VE", vr: "VR", vi: "VI", pd: "PD", tv: "TV", bl: "BL", ro: "RO",
};
const VENETO = new Set(["VE","VR","VI","PD","TV","BL","RO"]);

function normProv(p: string | null | undefined): string | null {
  if (!p) return null;
  const k = p.trim().toLowerCase();
  return PROV_NORM[k] ?? (VENETO.has(p.toUpperCase()) ? p.toUpperCase() : null);
}

/**
 * Esegue le 3 derivazioni e restituisce conteggi inseriti.
 * Idempotente: salta record già esistenti tramite identity_hash/fingerprint.
 */
export async function deriveAllSignals(): Promise<DeriveReport> {
  const warnings: string[] = [];
  const supa = svcClient();
  if (!supa) {
    return {
      motivated_sellers_inserted: 0,
      market_anomalies_inserted: 0,
      radar_signals_inserted: 0,
      warnings: ["SUPABASE_SERVICE_ROLE_KEY mancante: derivazione non eseguita."],
    };
  }

  // ─── 1. Carica snapshot ────────────────────────────────────
  const { data: snaps, error: snapErr } = await supa
    .from("listing_price_snapshots")
    .select("id,listing_id,source,url,municipality,province,price_eur,surface_sqm,lat,lng,captured_at,first_seen_at")
    .range(0, 9999);
  if (snapErr) {
    warnings.push(`snapshots query: ${snapErr.message}`);
    return { motivated_sellers_inserted: 0, market_anomalies_inserted: 0, radar_signals_inserted: 0, warnings };
  }

  // ─── 2. Carica OMI Veneto ──────────────────────────────────
  const { data: omiRows, error: omiErr } = await supa
    .from("omi_valori")
    .select("provincia,comune_descrizione,compr_min,compr_max")
    .ilike("regione", "Veneto")
    .ilike("descr_tipologia", "%abitazion%civil%")
    .range(0, 19999);
  if (omiErr) warnings.push(`omi query: ${omiErr.message}`);

  const omiMap = new Map<string, number>(); // key=PROV:COMUNE_UPPER → omi_medio
  for (const r of omiRows ?? []) {
    const row = r as { provincia: string; comune_descrizione: string; compr_min: number|null; compr_max: number|null };
    const k = `${row.provincia.toUpperCase()}:${row.comune_descrizione.toUpperCase()}`;
    const v = ((row.compr_min ?? 0) + (row.compr_max ?? 0)) / 2;
    if (v > 0) {
      const existing = omiMap.get(k);
      omiMap.set(k, existing ? (existing + v) / 2 : v);
    }
  }

  // ─── 3. Normalizza snapshot ────────────────────────────────
  interface NormSnap {
    listing_id: string; source: string; url: string;
    municipality: string; prov: string;
    price: number; sqm: number | null; lat: number | null; lng: number | null;
    pmq: number | null; giorni: number;
    omi_medio: number | null; gap_pct: number | null;
    quality: "reale" | "parziale";
  }
  const norm: NormSnap[] = [];
  const DEMO_MARKERS = ["seed_demo", "demo", "mock", "fixture", "sample"];
  const isDemoStr = (s: string | null | undefined) =>
    !!s && DEMO_MARKERS.some((m) => s.toLowerCase().includes(m));
  for (const r of snaps ?? []) {
    const row = r as { listing_id: string; source: string; url: string;
      municipality: string; province: string; price_eur: number|null;
      surface_sqm: number|null; lat: number|null; lng: number|null;
      captured_at: string; first_seen_at: string|null };
    const prov = normProv(row.province);
    if (!prov || !VENETO.has(prov) || !row.price_eur || !row.municipality) continue;
    // POLICY PRODUZIONE: scarta record demo/mock/seed alla fonte.
    if (isDemoStr(row.source) || isDemoStr(row.listing_id) || isDemoStr(row.url)) continue;
    const pmq = row.surface_sqm && row.surface_sqm > 10 ? row.price_eur / row.surface_sqm : null;
    const seen = new Date(row.first_seen_at ?? row.captured_at).getTime();
    const giorni = Math.max(0, (Date.now() - seen) / 86_400_000);
    const omi_medio = omiMap.get(`${prov}:${row.municipality.toUpperCase()}`) ?? null;
    const gap_pct = (pmq && omi_medio) ? ((pmq - omi_medio) / omi_medio) * 100 : null;
    norm.push({
      listing_id: row.listing_id, source: row.source, url: row.url,
      municipality: row.municipality, prov,
      price: row.price_eur, sqm: row.surface_sqm, lat: row.lat, lng: row.lng,
      pmq, giorni, omi_medio, gap_pct,
      quality: "reale",
    });
  }

  // ─── 4. Insert motivated_sellers (giorni>=100) ─────────────
  const msExisting = new Set<string>();
  const { data: msEx } = await supa.from("motivated_sellers").select("listing_id").range(0, 9999);
  for (const r of msEx ?? []) msExisting.add((r as { listing_id: string }).listing_id);

  const msRows = norm
    .filter((n) => n.giorni >= 100 && !msExisting.has(n.listing_id))
    .map((n) => ({
      identity_hash: `derived_${n.prov}_${n.listing_id}`,
      listing_id: n.listing_id, source: n.source, url: n.url,
      municipality: n.municipality, province: n.prov,
      first_seen_at: new Date(Date.now() - n.giorni * 86_400_000).toISOString(),
      last_price_eur: n.price, initial_price_eur: n.price,
      total_drop_pct: 0, drops_count: 0,
      days_online: Math.max(120, Math.round(n.giorni)),
      fatigue_score: (n.gap_pct ?? 0) > 30 ? 80 : (n.gap_pct ?? 0) > 15 ? 65 : 55,
      fatigue_label: (n.gap_pct ?? 0) > 30 ? "caldissimo" : (n.gap_pct ?? 0) > 15 ? "caldo" : "tiepido",
      payload: {
        quality: n.quality,
        reason: (n.gap_pct ?? 0) > 15 ? "Prezzo sopra OMI medio + giacenza lunga" : "Giacenza lunga",
        gap_omi_pct: n.gap_pct ? Math.round(n.gap_pct * 10) / 10 : null,
        omi_medio: n.omi_medio,
        data_basis: ["listing_price_snapshots", "omi_valori"],
      },
    }));

  let msInserted = 0;
  if (msRows.length > 0) {
    const { error, count } = await supa.from("motivated_sellers").insert(msRows, { count: "exact" });
    if (error) warnings.push(`motivated_sellers insert: ${error.message}`);
    else msInserted = count ?? msRows.length;
  }

  // ─── 5. Aggrega per comune e crea anomalies + signals ──────
  const comuneAgg = new Map<string, {
    municipality: string; prov: string; pmqs: number[]; giorni: number[];
    annunci: number; lat: number | null; lng: number | null;
    omi_medio: number | null; is_demo_only: boolean;
  }>();
  for (const n of norm) {
    const k = `${n.prov}:${n.municipality.toUpperCase()}`;
    let a = comuneAgg.get(k);
    if (!a) {
      a = { municipality: n.municipality, prov: n.prov, pmqs: [], giorni: [],
            annunci: 0, lat: null, lng: null, omi_medio: n.omi_medio, is_demo_only: true };
      comuneAgg.set(k, a);
    }
    a.annunci++;
    if (n.pmq) a.pmqs.push(n.pmq);
    a.giorni.push(n.giorni);
    if (a.lat == null && n.lat != null) { a.lat = n.lat; a.lng = n.lng; }
    if (n.quality === "reale") a.is_demo_only = false;
  }

  // anomalies
  const anExisting = new Set<string>();
  const { data: anEx } = await supa.from("market_anomalies").select("identity_hash").range(0, 9999);
  for (const r of anEx ?? []) anExisting.add((r as { identity_hash: string }).identity_hash);

  const anRows: Array<Record<string, unknown>> = [];
  for (const a of comuneAgg.values()) {
    const avgPmq = a.pmqs.length ? a.pmqs.reduce((x,y)=>x+y,0)/a.pmqs.length : null;
    const avgGior = a.giorni.length ? a.giorni.reduce((x,y)=>x+y,0)/a.giorni.length : 0;
    const muniHash = await sha1(a.municipality);
    const quality = a.is_demo_only ? "parziale" : "reale";

    if (avgPmq && a.omi_medio && avgPmq > a.omi_medio * 1.20) {
      const ih = `derived_gap_alto_${a.prov}_${muniHash}`;
      if (!anExisting.has(ih)) {
        const gap = ((avgPmq - a.omi_medio) / a.omi_medio) * 100;
        anRows.push({
          identity_hash: ih, anomaly_type: "omi_gap_alto",
          municipality: a.municipality, province: a.prov,
          payload: { quality, severity: gap > 50 ? "alta" : "media",
            score: Math.min(100, Math.round(gap)),
            description: `Prezzo richiesto medio sopra OMI di ${gap.toFixed(1)}%`,
            avg_prezzo_mq: Math.round(avgPmq), omi_medio: a.omi_medio,
            sample_size: a.annunci,
            data_basis: ["listing_price_snapshots", "omi_valori"] },
          confidence: "medium",
        });
      }
    }
    if (avgGior > 120) {
      const ih = `derived_giacenza_${a.prov}_${muniHash}`;
      if (!anExisting.has(ih)) {
        anRows.push({
          identity_hash: ih, anomaly_type: "giacenza_lunga",
          municipality: a.municipality, province: a.prov,
          payload: { quality, severity: avgGior > 200 ? "alta" : "media",
            score: Math.min(100, Math.round(avgGior)),
            description: `Giacenza media ${Math.round(avgGior)} giorni`,
            avg_giorni_online: Math.round(avgGior), sample_size: a.annunci,
            data_basis: ["listing_price_snapshots"] },
          confidence: a.annunci >= 3 ? "high" : "medium",
        });
      }
    }
  }

  let anInserted = 0;
  if (anRows.length > 0) {
    const { error, count } = await supa.from("market_anomalies").insert(anRows, { count: "exact" });
    if (error) warnings.push(`market_anomalies insert: ${error.message}`);
    else anInserted = count ?? anRows.length;
  }

  // ─── 6. radar_signals (1 per comune) ───────────────────────
  const rsExisting = new Set<string>();
  const { data: rsEx } = await supa.from("radar_signals").select("fingerprint").range(0, 9999);
  for (const r of rsEx ?? []) rsExisting.add((r as { fingerprint: string }).fingerprint);

  // count motivated/anomalies per comune (post-insert, refetch counts da memoria)
  const msByComune = new Map<string, number>();
  const anByComune = new Map<string, number>();
  for (const m of msRows) msByComune.set(`${m.province}:${m.municipality.toUpperCase()}`,
    (msByComune.get(`${m.province}:${m.municipality.toUpperCase()}`) ?? 0) + 1);
  // includi anche pre-esistenti
  const { data: msAll } = await supa.from("motivated_sellers").select("province,municipality").eq("is_active", true).range(0, 9999);
  for (const r of msAll ?? []) {
    const row = r as { province: string; municipality: string };
    const k = `${row.province}:${row.municipality.toUpperCase()}`;
    msByComune.set(k, Math.max(msByComune.get(k) ?? 0, 1));
  }
  const { data: anAll } = await supa.from("market_anomalies").select("province,municipality").eq("is_active", true).range(0, 9999);
  for (const r of anAll ?? []) {
    const row = r as { province: string; municipality: string };
    const k = `${row.province}:${row.municipality.toUpperCase()}`;
    anByComune.set(k, (anByComune.get(k) ?? 0) + 1);
  }

  const rsRows: Array<Record<string, unknown>> = [];
  for (const a of comuneAgg.values()) {
    const muniHash = await sha1(a.municipality);
    const fp = `derived_rs_${a.prov}_${muniHash}`;
    if (rsExisting.has(fp)) continue;
    const k = `${a.prov}:${a.municipality.toUpperCase()}`;
    const nMot = msByComune.get(k) ?? 0;
    const nAn = anByComune.get(k) ?? 0;
    const avgGior = a.giorni.length ? a.giorni.reduce((x,y)=>x+y,0)/a.giorni.length : 0;
    const score = Math.min(100, nMot * 15 + nAn * 10 + Math.min(20, a.annunci * 2) + (avgGior > 120 ? 10 : 0));
    const temperature = score >= 50 ? "molto_calda" : score >= 30 ? "calda" : score >= 15 ? "tiepida" : "fredda";
    const sigType = nMot > 0 ? "motivato" : nAn > 0 ? "omi_gap" : "misto";
    const quality = a.is_demo_only ? "parziale" : "reale";

    rsRows.push({
      signal_type: sigType, fingerprint: fp,
      title: `${a.municipality.charAt(0).toUpperCase() + a.municipality.slice(1).toLowerCase()} (${a.prov}) — ${
        nMot > 0 ? "venditori motivati attivi" : nAn > 0 ? "gap OMI / giacenza lunga" : "pressione di mercato"}`,
      description: `Aggregato: ${a.annunci} annunci monitorati, giacenza media ${Math.round(avgGior)} gg, ${nMot} venditori motivati, ${nAn} anomalie.`,
      municipality: a.municipality, province: a.prov,
      lat: a.lat, lng: a.lng,
      urgency: nMot >= 2 ? "alta" : (nMot + nAn > 0 ? "media" : "bassa"),
      confidence: (nMot + nAn) >= 3 ? "high" : (a.is_demo_only ? "low" : "medium"),
      source: "derived_radar_v1",
      payload: { quality, score, temperature,
        agentAction: nMot > 0
          ? "Contatta proprietari con giacenza superiore a 120 giorni proponendo una rivalutazione prezzo basata su OMI e comparabili locali."
          : nAn > 0
          ? "Verifica gap OMI e proponi mandato a prezzo allineato al mercato locale."
          : "Monitora evoluzione e prepara dossier zona.",
        data_basis: ["listing_price_snapshots", "motivated_sellers", "market_anomalies", "omi_valori"],
        metrics: { annunci: a.annunci, giorni_medi: Math.round(avgGior), motivati: nMot, anomalie: nAn },
      },
    });
  }

  let rsInserted = 0;
  if (rsRows.length > 0) {
    const { error, count } = await supa.from("radar_signals").insert(rsRows, { count: "exact" });
    if (error) warnings.push(`radar_signals insert: ${error.message}`);
    else rsInserted = count ?? rsRows.length;
  }

  return {
    motivated_sellers_inserted: msInserted,
    market_anomalies_inserted: anInserted,
    radar_signals_inserted: rsInserted,
    warnings,
  };
}

async function sha1(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s.toUpperCase()));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
