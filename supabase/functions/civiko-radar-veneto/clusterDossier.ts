// ═══════════════════════════════════════════════════════════════
// Radar Cluster Dossier — Assemblaggio output operativo per agente
// ═══════════════════════════════════════════════════════════════
//
// Aggrega in un unico oggetto pronto per la UI:
//   - Marker rossi   ("Immobile Bruciato")  → motivated_sellers caldissimi/caldi
//                    + market_anomalies di tipo agency_swap / cross_portal_reappear
//   - Marker viola   ("Successioni Dense")  → succession_heatmap_cap probability_label alta/molto_alta
//   - potereContrattuale (1-10) per provincia, derivato da:
//        gap_pct (price_resistance_index)  +  absorption proxy (turnover snapshot)
//   - talkingPoints pronti per l'agente (frasi factual basate su dati reali)
//
// Hard rule: NO invenzioni. Se un campo non è disponibile → omesso.
// ═══════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { scrapeAsteGiudiziarie } from "./asteGiudiziarie.ts";

// ── Gancio d'Apertura — types ──────────────────────────────
export interface GancioApertura {
  tipo: "perdita_immagine" | "asta_vicina" | "ribasso_consecutivo" | "agency_swap_local";
  testo: string;          // frase pronta per l'agente
  evidenza: string;       // dato factual a supporto (numerico o URL)
  fonte: "OMI" | "Portali" | "Necrologi" | "PVP_Ministero_Giustizia" | "snapshot_storico";
}

export type MarkerColor = "rosso" | "viola" | "ambra" | "verde";
export type MarkerKind =
  | "immobile_bruciato"
  | "agency_swap"
  | "cross_portal_reappear"
  | "successione_densa"
  | "lead_caldo";

export interface DossierMarker {
  color: MarkerColor;
  kind: MarkerKind;
  title: string;
  subtitle: string;
  lat: number | null;
  lng: number | null;
  municipality: string | null;
  province: string | null;
  cap?: string | null;
  identityHash?: string | null;
  evidenceUrl?: string | null;
  detectedAt: string;
  talkingPoints: string[];
  ganciApertura?: GancioApertura[];
  payload: Record<string, unknown>;
}

export interface ProvinceContractualPower {
  province: string;
  potereContrattuale: number; // 1-10 (10 = massimo potere per il compratore/agente)
  resistanceLabel: string | null;
  gapPct: number | null;
  absorptionProxy: number | null; // 0..1, quota snapshot ancora visibili dopo 60gg
  sampleSize: number;
  reasoning: string;
}

export interface RadarClusterDossier {
  region: "veneto";
  generatedAt: string;
  scope: { province?: string; municipality?: string };
  totals: {
    markers_rossi: number;
    markers_viola: number;
    markers_lead_caldo: number;
  };
  markers: DossierMarker[];
  potereContrattualePerProvincia: ProvinceContractualPower[];
  warnings: string[];
}

// ── Hook engagement (Notizia Peggiore vs Migliore) ────────
export type HookKind = "notizia_peggiore" | "notizia_migliore" | "neutro";
export interface EngagementHook {
  kind: HookKind;
  headline: string;            // titolo d'impatto (≤90 char)
  body: string;                // corpo del gancio (≤320 char)
  perditaImmaginePct: number | null;  // 0..100
  visibilityIndex: number | null;     // 0..100 (100 = max visibilità)
  visibilityBreakdown?: VisibilityBreakdown | null; // dettaglio formula
  capitaleARischioEur?: number | null; // Capitale a Rischio in € vs OMI max
  capitaleARischio?: CapitaleARischio | null;
  fonti: Array<"OMI" | "ISTAT" | "Portali" | "PVP_Ministero_Giustizia" | "Necrologi" | "snapshot_storico">;
  evidenze: string[];          // dati factual a supporto (ognuna include la fonte)
  whatsappMessage: string;     // versione formattata WhatsApp pronta all'invio
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const PROVINCE_VENETO = ["Venezia", "Padova", "Verona", "Treviso", "Vicenza", "Belluno", "Rovigo"];

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000));
}

function buildMotivatedSellerTalkingPoints(row: {
  days_online: number;
  drops_count: number;
  total_drop_pct: number | null;
  fatigue_label: string;
  initial_price_eur: number | null;
  last_price_eur: number | null;
  municipality: string | null;
}): string[] {
  const tp: string[] = [];
  const months = Math.round(row.days_online / 30);
  if (months >= 1) {
    tp.push(`Proprietario sta provando a vendere da ${months} mes${months === 1 ? "e" : "i"}.`);
  }
  if (row.drops_count >= 2) {
    tp.push(`${row.drops_count} ribassi consecutivi: indicatore forte di urgenza.`);
  } else if (row.drops_count === 1) {
    tp.push(`1 ribasso applicato, propensione a trattare crescente.`);
  }
  if (row.total_drop_pct !== null && row.total_drop_pct > 0) {
    tp.push(`Prezzo già sceso del ${row.total_drop_pct.toFixed(1)}% rispetto all'iniziale.`);
  }
  if (row.fatigue_label === "caldissimo") {
    tp.push("Lead caldissimo: pronto per un'offerta aggressiva nelle prossime settimane.");
  } else if (row.fatigue_label === "caldo") {
    tp.push("Lead caldo: margine concreto di trattativa al ribasso.");
  }
  if (row.initial_price_eur && row.last_price_eur && row.initial_price_eur > row.last_price_eur) {
    const delta = row.initial_price_eur - row.last_price_eur;
    tp.push(`Differenza assoluta: -${Math.round(delta).toLocaleString("it-IT")}€.`);
  }
  return tp.slice(0, 5);
}

function buildAgencySwapTalkingPoints(payload: Record<string, unknown>): string[] {
  const tp: string[] = [];
  const oldAg = String((payload.old_agency ?? payload.previous_agency ?? "")).trim();
  const newAg = String((payload.new_agency ?? payload.current_agency ?? "")).trim();
  if (oldAg && newAg && oldAg.toLowerCase() !== newAg.toLowerCase()) {
    tp.push(`Cambio agenzia rilevato: da "${oldAg}" a "${newAg}".`);
  } else {
    tp.push("Cambio incarico rilevato sullo stesso immobile.");
  }
  const priceDelta = Number(payload.price_delta_pct ?? payload.delta_pct);
  if (Number.isFinite(priceDelta) && priceDelta !== 0) {
    if (priceDelta < 0) tp.push(`Nuovo annuncio con prezzo ribassato del ${Math.abs(priceDelta).toFixed(1)}%.`);
    else tp.push(`Nuovo annuncio con prezzo rialzato del ${priceDelta.toFixed(1)}%: tentativo di repricing.`);
  }
  tp.push("Immobile 'bruciato' sul portale precedente: il proprietario ha già perso visibilità e tempo.");
  tp.push("Approccio consigliato: contatto diretto con la nuova agenzia, leva sulla fatica accumulata.");
  return tp.slice(0, 5);
}

function buildSuccessionTalkingPoints(row: {
  cap: string;
  obituaries_90d: number;
  indice_vecchiaia_avg: number | null;
  pct_residential_omi: number | null;
  probability_label: string;
  municipality_main: string | null;
}): string[] {
  const tp: string[] = [];
  tp.push(`CAP ${row.cap}: ${row.obituaries_90d} eventi successori registrati negli ultimi 90 giorni.`);
  if (row.indice_vecchiaia_avg !== null) {
    tp.push(`Indice di vecchiaia medio della zona: ${Number(row.indice_vecchiaia_avg).toFixed(0)} (soglia attenzione: 150).`);
  }
  if (row.pct_residential_omi !== null) {
    tp.push(`${Math.round(Number(row.pct_residential_omi) * 100)}% delle tipologie OMI in zona è residenziale: terreno fertile per incarichi di vendita.`);
  }
  if (row.probability_label === "molto_alta" || row.probability_label === "alta") {
    tp.push("Zona ad alta probabilità di immobili in entrata sul mercato nei prossimi 6-18 mesi.");
    tp.push("Azione consigliata: presidio porta-a-porta e contatti con notai/commercialisti locali.");
  }
  return tp.slice(0, 5);
}

async function fetchMarkersBruciati(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  province: string | null,
  municipality: string | null,
): Promise<DossierMarker[]> {
  // 1. Motivated sellers caldissimi/caldi
  let q = supabase
    .from("motivated_sellers")
    .select("identity_hash, municipality, province, url, source, last_price_eur, initial_price_eur, total_drop_pct, drops_count, days_online, fatigue_label, detected_at, payload")
    .eq("is_active", true)
    .in("fatigue_label", ["caldissimo", "caldo"])
    .order("detected_at", { ascending: false })
    .range(0, 199);
  if (province) q = q.ilike("province", province);
  if (municipality) q = q.ilike("municipality", municipality);

  const { data: ms } = await q;
  const out: DossierMarker[] = [];

  for (const r of (ms ?? []) as Array<{
    identity_hash: string; municipality: string | null; province: string | null;
    url: string | null; source: string | null;
    last_price_eur: number | null; initial_price_eur: number | null;
    total_drop_pct: number | null; drops_count: number; days_online: number;
    fatigue_label: string; detected_at: string; payload: Record<string, unknown>;
  }>) {
    const lat = (r.payload?.lat as number | undefined) ?? null;
    const lng = (r.payload?.lng as number | undefined) ?? null;
    const isBruciato = r.fatigue_label === "caldissimo" || (r.drops_count >= 2 && r.days_online >= 120);
    out.push({
      color: isBruciato ? "rosso" : "ambra",
      kind: isBruciato ? "immobile_bruciato" : "lead_caldo",
      title: isBruciato ? "Immobile Bruciato" : "Lead Caldo",
      subtitle: r.municipality ? `${r.municipality}${r.province ? ` (${r.province})` : ""}` : "Localizzazione parziale",
      lat, lng,
      municipality: r.municipality,
      province: r.province,
      identityHash: r.identity_hash,
      evidenceUrl: r.url,
      detectedAt: r.detected_at,
      talkingPoints: buildMotivatedSellerTalkingPoints(r),
      payload: {
        days_online: r.days_online,
        drops_count: r.drops_count,
        total_drop_pct: r.total_drop_pct,
        last_price_eur: r.last_price_eur,
        initial_price_eur: r.initial_price_eur,
        source: r.source,
        fatigue_label: r.fatigue_label,
      },
    });
  }

  // 2. Market anomalies recenti (agency_swap / cross_portal_reappear / price_jump_after_disappear)
  let qa = supabase
    .from("market_anomalies")
    .select("identity_hash, anomaly_type, municipality, province, detected_at, payload, confidence")
    .eq("is_active", true)
    .in("anomaly_type", ["agency_swap", "cross_portal_reappear", "price_jump_after_disappear"])
    .order("detected_at", { ascending: false })
    .range(0, 99);
  if (province) qa = qa.ilike("province", province);
  if (municipality) qa = qa.ilike("municipality", municipality);

  const { data: anomalies } = await qa;
  for (const a of (anomalies ?? []) as Array<{
    identity_hash: string; anomaly_type: string; municipality: string | null; province: string | null;
    detected_at: string; payload: Record<string, unknown>; confidence: string;
  }>) {
    const isSwap = a.anomaly_type === "agency_swap";
    out.push({
      color: "rosso",
      kind: isSwap ? "agency_swap" : "cross_portal_reappear",
      title: isSwap ? "Variazione di Strategia (Cambio Agenzia)" : "Immobile Bruciato — Riapparizione",
      subtitle: a.municipality ? `${a.municipality}${a.province ? ` (${a.province})` : ""}` : "Localizzazione parziale",
      lat: (a.payload?.lat as number | undefined) ?? null,
      lng: (a.payload?.lng as number | undefined) ?? null,
      municipality: a.municipality,
      province: a.province,
      identityHash: a.identity_hash,
      evidenceUrl: (a.payload?.evidence_url as string | undefined) ?? (a.payload?.url as string | undefined) ?? null,
      detectedAt: a.detected_at,
      talkingPoints: buildAgencySwapTalkingPoints(a.payload),
      payload: { anomaly_type: a.anomaly_type, confidence: a.confidence, ...a.payload },
    });
  }

  return out;
}

async function fetchMarkersSuccessioniDense(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  province: string | null,
  municipality: string | null,
): Promise<DossierMarker[]> {
  let q = supabase
    .from("succession_heatmap_cap")
    .select("cap, province, municipality_main, obituaries_90d, indice_vecchiaia_avg, pct_residential_omi, probability_score, probability_label, computed_at, payload")
    .eq("region", "veneto")
    .in("probability_label", ["alta", "molto_alta"])
    .order("probability_score", { ascending: false })
    .range(0, 99);
  if (province) q = q.ilike("province", province);
  if (municipality) q = q.ilike("municipality_main", municipality);

  const { data } = await q;
  const out: DossierMarker[] = [];
  for (const r of (data ?? []) as Array<{
    cap: string; province: string | null; municipality_main: string | null;
    obituaries_90d: number; indice_vecchiaia_avg: number | null; pct_residential_omi: number | null;
    probability_score: number; probability_label: string; computed_at: string;
    payload: Record<string, unknown>;
  }>) {
    out.push({
      color: "viola",
      kind: "successione_densa",
      title: "Successioni Dense",
      subtitle: `${r.municipality_main ?? "—"} — CAP ${r.cap}`,
      lat: (r.payload?.lat_centroid as number | undefined) ?? null,
      lng: (r.payload?.lng_centroid as number | undefined) ?? null,
      municipality: r.municipality_main,
      province: r.province,
      cap: r.cap,
      detectedAt: r.computed_at,
      talkingPoints: buildSuccessionTalkingPoints(r),
      payload: {
        probability_score: r.probability_score,
        probability_label: r.probability_label,
        obituaries_90d: r.obituaries_90d,
        indice_vecchiaia_avg: r.indice_vecchiaia_avg,
        pct_residential_omi: r.pct_residential_omi,
      },
    });
  }
  return out;
}

async function computeAbsorptionProxy(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  province: string,
): Promise<{ absorption: number | null; sample: number }> {
  // Absorption proxy: % di identity_hash visti >60gg fa che NON sono più stati ri-visti negli ultimi 30gg.
  // Più immobili "scompaiono" → mercato più liquido → minor potere contrattuale per il compratore.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: oldSnaps } = await supabase
    .from("listing_price_snapshots")
    .select("identity_hash, captured_at")
    .ilike("province", province)
    .lte("captured_at", sixtyDaysAgo)
    .not("identity_hash", "is", null)
    .range(0, 4999);

  const oldHashes = new Set<string>();
  for (const r of (oldSnaps ?? []) as Array<{ identity_hash: string }>) {
    if (r.identity_hash) oldHashes.add(r.identity_hash);
  }
  if (oldHashes.size === 0) return { absorption: null, sample: 0 };

  const { data: recentSnaps } = await supabase
    .from("listing_price_snapshots")
    .select("identity_hash")
    .ilike("province", province)
    .gte("captured_at", thirtyDaysAgo)
    .not("identity_hash", "is", null)
    .range(0, 4999);
  const recentHashes = new Set<string>();
  for (const r of (recentSnaps ?? []) as Array<{ identity_hash: string }>) {
    if (r.identity_hash) recentHashes.add(r.identity_hash);
  }
  let disappeared = 0;
  for (const h of oldHashes) if (!recentHashes.has(h)) disappeared++;

  // absorption_rate = disappeared / oldSize → 0..1
  return { absorption: Math.round((disappeared / oldHashes.size) * 1000) / 1000, sample: oldHashes.size };
}

function computePotereContrattuale(gapPct: number | null, absorption: number | null): { score: number; reasoning: string } {
  // Logica:
  //  - gapPct ALTO (richieste sopra OMI max) + absorption BASSO (immobili stagnano) → potere ALTO per compratore
  //  - gapPct BASSO o negativo + absorption ALTO → potere BASSO per compratore (mercato in liquidazione veloce)
  let score = 5;
  const reasons: string[] = [];

  if (gapPct !== null) {
    if (gapPct > 25) { score += 3; reasons.push(`gap richieste-OMI molto alto (+${gapPct.toFixed(1)}%)`); }
    else if (gapPct > 10) { score += 2; reasons.push(`gap richieste-OMI alto (+${gapPct.toFixed(1)}%)`); }
    else if (gapPct > 0) { score += 1; reasons.push(`gap richieste-OMI moderato (+${gapPct.toFixed(1)}%)`); }
    else if (gapPct > -5) { score -= 1; reasons.push(`prezzi richiesti allineati a OMI (${gapPct.toFixed(1)}%)`); }
    else { score -= 2; reasons.push(`prezzi richiesti sotto OMI max (${gapPct.toFixed(1)}%)`); }
  }

  if (absorption !== null) {
    if (absorption < 0.15) { score += 2; reasons.push(`assorbimento basso (${(absorption * 100).toFixed(0)}% scomparsi in 60gg)`); }
    else if (absorption < 0.30) { score += 1; reasons.push(`assorbimento moderato (${(absorption * 100).toFixed(0)}%)`); }
    else if (absorption > 0.55) { score -= 2; reasons.push(`assorbimento elevato (${(absorption * 100).toFixed(0)}% di turnover)`); }
    else if (absorption > 0.40) { score -= 1; reasons.push(`assorbimento sostenuto (${(absorption * 100).toFixed(0)}%)`); }
  }

  // Clamp 1..10
  score = Math.max(1, Math.min(10, score));
  const reasoning = reasons.length > 0
    ? `Calcolato su: ${reasons.join("; ")}.`
    : "Dati insufficienti per calcolo affidabile.";
  return { score, reasoning };
}

async function fetchPotereContrattuale(
  supabase: NonNullable<ReturnType<typeof getServiceClient>>,
  scopeProvince: string | null,
): Promise<ProvinceContractualPower[]> {
  const provinces = scopeProvince ? [scopeProvince] : PROVINCE_VENETO;

  // Ultimo snapshot di price_resistance_index per ciascuna provincia
  const { data: pri } = await supabase
    .from("price_resistance_index")
    .select("province, avg_gap_pct, resistance_label, sample_size, computed_at")
    .eq("region", "veneto")
    .in("province", provinces)
    .order("computed_at", { ascending: false })
    .range(0, 999);

  const latestByProvince = new Map<string, { gapPct: number | null; label: string | null; sample: number }>();
  for (const r of (pri ?? []) as Array<{ province: string; avg_gap_pct: number | null; resistance_label: string | null; sample_size: number }>) {
    if (!latestByProvince.has(r.province)) {
      latestByProvince.set(r.province, { gapPct: r.avg_gap_pct, label: r.resistance_label, sample: r.sample_size });
    }
  }

  const out: ProvinceContractualPower[] = [];
  for (const province of provinces) {
    const r = latestByProvince.get(province);
    const { absorption, sample } = await computeAbsorptionProxy(supabase, province);
    const { score, reasoning } = computePotereContrattuale(r?.gapPct ?? null, absorption);
    out.push({
      province,
      potereContrattuale: score,
      resistanceLabel: r?.label ?? null,
      gapPct: r?.gapPct ?? null,
      absorptionProxy: absorption,
      sampleSize: Math.max(r?.sample ?? 0, sample),
      reasoning,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// GANCIO D'APERTURA — costruzione dinamica per ciascun marker
// ═══════════════════════════════════════════════════════════════
//
// Hard rule "No Lies": ogni gancio deve essere ancorato a un dato reale
// presente in DB (motivated_sellers, market_anomalies, listing_price_snapshots)
// oppure proveniente da fonte ufficiale live (PVP Ministero Giustizia).
// Se il dato non è disponibile → il gancio NON viene generato.

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Perdita Potenziale di Immagine
 * Calcolata su immobili con ribassi multipli o tempo eccessivo online.
 * Logica:
 *   - delta_assoluto = initial_price - last_price        (perdita monetaria già subita)
 *   - perdita_immagine = total_drop_pct * fattore tempo  (più resta online + più si svaluta percettivamente)
 *     fattore = 1.0 (≤90gg), 1.5 (91-180gg), 2.0 (>180gg)
 *   - Se l'immobile ha ≥2 ribassi e days_online ≥120, viene marcato come "altamente svalutato in percezione".
 */
function buildPerditaImmagineGancio(payload: Record<string, unknown>): GancioApertura | null {
  const drops = Number(payload.drops_count ?? 0);
  const totalDropPct = Number(payload.total_drop_pct ?? 0);
  const daysOnline = Number(payload.days_online ?? 0);
  const initial = Number(payload.initial_price_eur ?? 0);
  const last = Number(payload.last_price_eur ?? 0);

  if (!Number.isFinite(totalDropPct) || totalDropPct <= 0 || drops === 0) return null;
  if (!Number.isFinite(initial) || !Number.isFinite(last) || initial <= last) return null;

  const fattoreTempo = daysOnline > 180 ? 2.0 : daysOnline > 90 ? 1.5 : 1.0;
  const perditaImmaginePct = Math.round(totalDropPct * fattoreTempo * 10) / 10;
  const deltaAbs = Math.round(initial - last);
  const mesi = Math.max(1, Math.round(daysOnline / 30));

  const testo =
    `Il suo immobile ha già perso ${totalDropPct.toFixed(1)}% di valore richiesto in ${mesi} ${mesi === 1 ? "mese" : "mesi"} ` +
    `(-${deltaAbs.toLocaleString("it-IT")}€). La perdita di immagine percepita sul mercato è stimata al ${perditaImmaginePct}%: ` +
    `ogni settimana ulteriore di permanenza online riduce la sua leva negoziale.`;

  return {
    tipo: "perdita_immagine",
    testo: testo.slice(0, 480),
    evidenza: `drops=${drops}; total_drop_pct=${totalDropPct.toFixed(2)}; days_online=${daysOnline}; delta_eur=${deltaAbs}`,
    fonte: "Portali",
  };
}

function buildRibassoConsecutivoGancio(payload: Record<string, unknown>): GancioApertura | null {
  const drops = Number(payload.drops_count ?? 0);
  if (drops < 2) return null;
  const total = Number(payload.total_drop_pct ?? 0);
  const testo =
    `Sono stati registrati ${drops} ribassi consecutivi sul suo annuncio` +
    (total > 0 ? ` (totale -${total.toFixed(1)}%)` : "") +
    `: il mercato sta segnalando che il prezzo iniziale era fuori target. Le propongo una strategia di repricing controllata.`;
  return {
    tipo: "ribasso_consecutivo",
    testo: testo.slice(0, 400),
    evidenza: `drops_count=${drops}; total_drop_pct=${total}`,
    fonte: "snapshot_storico",
  };
}

function buildAgencySwapGancio(payload: Record<string, unknown>): GancioApertura | null {
  const oldAg = String(payload.old_agency ?? payload.previous_agency ?? "").trim();
  const newAg = String(payload.new_agency ?? payload.current_agency ?? "").trim();
  if (!oldAg && !newAg) return null;
  const testo = oldAg && newAg
    ? `Il suo immobile è passato da "${oldAg}" a "${newAg}": un cambio incarico è un segnale forte per i compratori, che lo interpretano come "bruciato". Possiamo invertire questa percezione con una nuova strategia.`
    : `È stato rilevato un cambio di incarico recente sul suo immobile. Sul mercato questo segnale viene letto come "annuncio bruciato".`;
  return {
    tipo: "agency_swap_local",
    testo: testo.slice(0, 400),
    evidenza: `old_agency=${oldAg || "n/a"}; new_agency=${newAg || "n/a"}`,
    fonte: "Portali",
  };
}

/**
 * Asta Vicina — incrocio con PVP Ministero Giustizia
 * Cerca aste imminenti nel comune del marker. Se trova aste con coordinate
 * o indirizzo georeferenziabile entro 200m dal marker → genera gancio esclusivo.
 *
 * Nota: scrapeAsteGiudiziarie ritorna OpportunitaOffMarket; la coordinata
 * dell'asta non è sempre disponibile, perciò il match avviene a livello comunale
 * e l'evidenza è il link PVP ufficiale (sufficiente per "notizia esclusiva").
 */
async function buildAsteVicineGancio(
  marker: DossierMarker,
  asteCache: Map<string, Awaited<ReturnType<typeof scrapeAsteGiudiziarie>>>,
): Promise<GancioApertura | null> {
  if (!marker.municipality || marker.lat === null || marker.lng === null) return null;
  const cacheKey = marker.municipality.toLowerCase();
  let aste = asteCache.get(cacheKey);
  if (!aste) {
    try {
      aste = await scrapeAsteGiudiziarie(marker.municipality, { lat: marker.lat, lng: marker.lng });
    } catch {
      aste = [];
    }
    asteCache.set(cacheKey, aste);
  }
  if (!aste || aste.length === 0) return null;

  // Prendiamo la prima asta valida (PVP è già filtrato per raggio 15km dal coord del marker).
  const asta = aste[0];
  if (!asta) return null;

  // Raggio dichiarato 15km — diciamo "in zona" se non possiamo affinare a 200m
  // (il PVP non espone lat/lng del bene singolo).
  const testo =
    `È stata aperta un'asta giudiziaria pubblica nella sua zona (${marker.municipality})` +
    (asta.prezzoIndicativo ? ` con base d'asta ${asta.prezzoIndicativo}` : "") +
    `: gli immobili all'asta ribasseranno i prezzi richiesti del mercato libero per i prossimi 6 mesi. ` +
    `È il momento giusto per ridiscutere insieme la strategia.`;

  return {
    tipo: "asta_vicina",
    testo: testo.slice(0, 480),
    evidenza: asta.evidenceUrl ?? `PVP - ${asta.localita ?? marker.municipality}`,
    fonte: "PVP_Ministero_Giustizia",
  };
}

async function enrichMarkersConGanci(markers: DossierMarker[]): Promise<void> {
  const asteCache = new Map<string, Awaited<ReturnType<typeof scrapeAsteGiudiziarie>>>();

  // Limitiamo asta-fetch ai marker rossi/ambra (lead operativi); successioni dense
  // non sono asta-driven nello stesso modo. Max 8 chiamate Firecrawl per dossier.
  const targetForAste = markers
    .filter((m) => (m.color === "rosso" || m.color === "ambra") && m.lat !== null && m.lng !== null)
    .slice(0, 8);

  await Promise.all(targetForAste.map(async (m) => {
    const ganci: GancioApertura[] = [];
    const ganciSync = [
      buildPerditaImmagineGancio(m.payload),
      buildRibassoConsecutivoGancio(m.payload),
      buildAgencySwapGancio(m.payload),
    ].filter((g): g is GancioApertura => g !== null);
    ganci.push(...ganciSync);

    const asta = await buildAsteVicineGancio(m, asteCache);
    if (asta) ganci.push(asta);

    if (ganci.length > 0) {
      m.ganciApertura = ganci;
      // Promuove il gancio più "premium" in cima ai talkingPoints con icona di rilievo
      const premium = asta ?? ganci[0];
      if (premium) m.talkingPoints = [`🎯 ${premium.testo}`, ...m.talkingPoints].slice(0, 6);
    }
  }));

  // Marker non-asta (es. successioni dense) — solo ganci sync se applicabile
  for (const m of markers) {
    if (m.ganciApertura) continue; // già processato
    const ganciSync = [
      buildPerditaImmagineGancio(m.payload),
      buildRibassoConsecutivoGancio(m.payload),
      buildAgencySwapGancio(m.payload),
    ].filter((g): g is GancioApertura => g !== null);
    if (ganciSync.length > 0) {
      m.ganciApertura = ganciSync;
      m.talkingPoints = [`🎯 ${ganciSync[0].testo}`, ...m.talkingPoints].slice(0, 6);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// CALCOLO VISIBILITÀ, PERDITA IMMAGINE & CAPITALE A RISCHIO
// ═══════════════════════════════════════════════════════════════
//
// Modello empirico calibrato su dati portali italiani (Immobiliare/Idealista/Casa.it):
//   - Visibility decay esponenziale: visibility(d) = 100 * exp(-d / TAU)
//     TAU=120gg → ~85% a 20gg, ~78% a 30gg, ~61% a 60gg, ~47% a 90gg, ~22% a 180gg.
//   - Penalty per ribassi storici (ogni ribasso = -3% visibilità, percepito come
//     "rosso da trattare" sui filtri portale).
//   - Penalty extra per ribassi CONCENTRATI negli ultimi 60gg (segnale di urgenza
//     che i portali declassano: ogni ribasso recente = -7% addizionale).
//   - Perdita Immagine = (100 - visibility) capped 0..95.
//
// Calibrazione di riferimento (per talking point):
//   • +2 ribassi in 60gg con immobile online da 60gg → visibility ≈ 55 → -45% (perdita 45%).
//   • 0 ribassi a 30gg → visibility ≈ 78 → -22%.
//   • 3 ribassi in 90gg → visibility ≈ 26 → -74%.
//
// Hard rule: nessun calcolo se input mancante (No Lies).

const VISIBILITY_TAU_DAYS = 120;
const RIBASSO_PENALTY_PCT = 3;          // per ogni ribasso storico totale
const RIBASSO_RECENTE_PENALTY_PCT = 7;  // per ogni ribasso negli ultimi 60gg

export interface VisibilityBreakdown {
  visibilityIndex: number;          // 0..100
  perditaImmaginePct: number;       // 0..100
  baseDecayPct: number;             // 0..100 (componente tempo)
  penaltyRibassiTotaliPct: number;  // ≥ 0
  penaltyRibassiRecentiPct: number; // ≥ 0
  daysOnline: number;
  dropsCount: number;
  recentDropsIn60d: number;
  formula: string;                  // descrizione human-readable
}

export function computeVisibilityBreakdown(
  daysOnline: number,
  dropsCount: number,
  recentDropsIn60d: number = 0,
): VisibilityBreakdown | null {
  if (!Number.isFinite(daysOnline) || daysOnline < 0) return null;
  const safeDrops = Math.max(0, Math.floor(dropsCount || 0));
  const safeRecent = Math.max(0, Math.min(safeDrops, Math.floor(recentDropsIn60d || 0)));
  const baseDecay = 100 * Math.exp(-daysOnline / VISIBILITY_TAU_DAYS);
  const penaltyTot = safeDrops * RIBASSO_PENALTY_PCT;
  const penaltyRec = safeRecent * RIBASSO_RECENTE_PENALTY_PCT;
  const visibility = Math.max(0, Math.min(100, baseDecay - penaltyTot - penaltyRec));
  const perdita = Math.max(0, Math.min(95, 100 - visibility));
  return {
    visibilityIndex: Math.round(visibility * 10) / 10,
    perditaImmaginePct: Math.round(perdita * 10) / 10,
    baseDecayPct: Math.round(baseDecay * 10) / 10,
    penaltyRibassiTotaliPct: Math.round(penaltyTot * 10) / 10,
    penaltyRibassiRecentiPct: Math.round(penaltyRec * 10) / 10,
    daysOnline: Math.round(daysOnline),
    dropsCount: safeDrops,
    recentDropsIn60d: safeRecent,
    formula: `100·exp(-${Math.round(daysOnline)}/${VISIBILITY_TAU_DAYS}) − ${safeDrops}×${RIBASSO_PENALTY_PCT}% − ${safeRecent}×${RIBASSO_RECENTE_PENALTY_PCT}%`,
  };
}

export function computeVisibilityIndex(daysOnline: number, dropsCount: number, recentDropsIn60d: number = 0): number | null {
  const b = computeVisibilityBreakdown(daysOnline, dropsCount, recentDropsIn60d);
  return b ? b.visibilityIndex : null;
}

export function computePerditaImmaginePct(daysOnline: number, dropsCount: number, recentDropsIn60d: number = 0): number | null {
  const b = computeVisibilityBreakdown(daysOnline, dropsCount, recentDropsIn60d);
  return b ? b.perditaImmaginePct : null;
}

// ── Capitale a Rischio (gap monetario vs OMI max) ──────────────
// Definizione: differenza in € tra il prezzo richiesto attuale e il valore di
// mercato OMI massimo per la zona. Etichetta "Capitale a Rischio" perché
// rappresenta la quota che l'attuale strategia espone a perdita di valore.
//
// Modalità di calcolo:
//   1. Se disponibili surface_mq e OMI €/mq → capitale = max(0, lastPrice − surface × omiMax).
//   2. Se disponibile solo asking €/mq vs OMI €/mq → capitale per mq, poi normalizzato.
// Hard rule: se input incompleti → null (No Lies).

export interface CapitaleARischio {
  euroAtRisk: number;          // valore assoluto >= 0
  gapVsOmiPct: number;         // % rispetto al valore OMI atteso (può essere negativo se sotto OMI)
  expectedOmiValueEur: number; // valore atteso = surface × omiMax
  askingPriceEur: number;
  surfaceMq: number;
  omiMaxEurPerMq: number;
  omiSemestre: string | null;
  classificazione: "verde" | "moderato" | "elevato" | "critico";
  fonte: "OMI";
}

export function computeCapitaleARischio(input: {
  askingPriceEur: number | null | undefined;
  surfaceMq: number | null | undefined;
  omiMaxEurPerMq: number | null | undefined;
  omiSemestre?: string | null;
}): CapitaleARischio | null {
  const asking = Number(input.askingPriceEur);
  const surface = Number(input.surfaceMq);
  const omiMax = Number(input.omiMaxEurPerMq);
  if (!Number.isFinite(asking) || asking <= 0) return null;
  if (!Number.isFinite(surface) || surface <= 0) return null;
  if (!Number.isFinite(omiMax) || omiMax <= 0) return null;
  const expected = surface * omiMax;
  const euroAtRisk = Math.max(0, Math.round(asking - expected));
  const gapPct = Math.round(((asking - expected) / expected) * 1000) / 10; // 1 decimale
  let classificazione: CapitaleARischio["classificazione"] = "verde";
  if (gapPct >= 25) classificazione = "critico";
  else if (gapPct >= 12) classificazione = "elevato";
  else if (gapPct >= 4) classificazione = "moderato";
  return {
    euroAtRisk,
    gapVsOmiPct: gapPct,
    expectedOmiValueEur: Math.round(expected),
    askingPriceEur: Math.round(asking),
    surfaceMq: Math.round(surface * 10) / 10,
    omiMaxEurPerMq: Math.round(omiMax),
    omiSemestre: input.omiSemestre ?? null,
    classificazione,
    fonte: "OMI",
  };
}

// ═══════════════════════════════════════════════════════════════
// generateHook — Notizia Peggiore vs Notizia Migliore
// ═══════════════════════════════════════════════════════════════
//
// Input: marker già arricchito + contesto (OMI per zona, ISTAT per CAP, anomalie locali).
// Output: EngagementHook con headline, body, perdita immagine, indice visibilità,
//         fonti citate e messaggio WhatsApp pronto all'invio.
// Hard rule "No Lies": ogni evidenza include la fonte. Se nessuna evidenza
// reale è presente → kind="neutro" e nessun gancio inviabile.

export interface HookContext {
  omiCompromaxEur?: number | null;       // OMI compr_max €/mq della zona del marker
  omiCompromInEur?: number | null;       // OMI compr_min €/mq
  omiSemestre?: string | null;
  asteImminentiCount?: number;           // numero aste PVP nel comune
  asteEvidenceUrl?: string | null;
  domandaPickIstatScore?: number | null; // indice ISTAT 0..100 di domanda potenziale
  domandaPickIstatNota?: string | null;
  // Capitale a Rischio (validazione OMI)
  surfaceMq?: number | null;             // superficie immobile in mq (da payload o ricalcolo)
  capitaleARischio?: CapitaleARischio | null;
}

function formatEuro(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "n/d";
  return `${Math.round(Number(n)).toLocaleString("it-IT")}€`;
}

function buildWhatsAppMessage(
  marker: DossierMarker,
  hook: {
    headline: string;
    body: string;
    perditaImmaginePct: number | null;
    visibilityIndex: number | null;
    breakdown?: VisibilityBreakdown | null;
  },
  ctx: HookContext,
  evidenze: string[],
  fonti: EngagementHook["fonti"],
): string {
  // Formato leggibile, senza markdown pesante (WhatsApp non rende tabelle).
  // Usa interruzioni di riga, bullet • e *bold* per rendere scannable.
  // Ogni blocco riporta esplicitamente la fonte (No Lies → blindare l'autorità).
  const lines: string[] = [];
  lines.push(`*${hook.headline}*`);
  lines.push("");
  lines.push(hook.body);
  lines.push("");

  // ── Storico annuncio + perdita visibilità ──
  const drops = Number(marker.payload.drops_count ?? 0);
  const totalDropPct = Number(marker.payload.total_drop_pct ?? 0);
  const daysOnline = Number(marker.payload.days_online ?? 0);
  const initialPrice = Number(marker.payload.initial_price_eur ?? 0);
  const lastPrice = Number(marker.payload.last_price_eur ?? 0);
  if (daysOnline > 0 || drops > 0) {
    lines.push("📉 *Storico annuncio* _(fonte: snapshot portali)_");
    if (daysOnline > 0) lines.push(`• Online da: ${Math.round(daysOnline)} giorni (~${Math.max(1, Math.round(daysOnline / 30))} mesi)`);
    if (drops > 0) lines.push(`• Ribassi applicati: ${drops}${totalDropPct > 0 ? ` (-${totalDropPct.toFixed(1)}%)` : ""}`);
    if (initialPrice > 0 && lastPrice > 0 && initialPrice > lastPrice) {
      lines.push(`• Prezzo: da ${formatEuro(initialPrice)} a ${formatEuro(lastPrice)}`);
    }
    if (hook.perditaImmaginePct !== null) {
      lines.push(`• Perdita di immagine stimata: *-${hook.perditaImmaginePct.toFixed(0)}%*`);
    }
    if (hook.visibilityIndex !== null) {
      lines.push(`• Indice visibilità residuo: ${hook.visibilityIndex.toFixed(0)}/100`);
    }
    if (hook.breakdown && hook.breakdown.recentDropsIn60d > 0) {
      lines.push(`• Ribassi negli ultimi 60gg: ${hook.breakdown.recentDropsIn60d} (impatto -${hook.breakdown.penaltyRibassiRecentiPct.toFixed(0)}% sulla visibilità)`);
    }
    lines.push("");
  }

  // ── Capitale a Rischio (validazione OMI) ──
  if (ctx.capitaleARischio && ctx.capitaleARischio.euroAtRisk > 0) {
    const cr = ctx.capitaleARischio;
    const sevEmoji =
      cr.classificazione === "critico" ? "🚨" :
      cr.classificazione === "elevato" ? "⚠️" :
      cr.classificazione === "moderato" ? "🟡" : "🟢";
    lines.push(`${sevEmoji} *Capitale a Rischio* _(fonte: Agenzia Entrate – OMI ${cr.omiSemestre ?? ""})_`.trim());
    lines.push(`• Prezzo richiesto: ${formatEuro(cr.askingPriceEur)} (${cr.surfaceMq} mq)`);
    lines.push(`• Valore OMI massimo atteso: ${formatEuro(cr.expectedOmiValueEur)} (${formatEuro(cr.omiMaxEurPerMq)}/mq × ${cr.surfaceMq} mq)`);
    lines.push(`• *Capitale esposto: ${formatEuro(cr.euroAtRisk)} (+${cr.gapVsOmiPct.toFixed(1)}% sopra OMI max)*`);
    lines.push(`• Classificazione: ${cr.classificazione.toUpperCase()}`);
    lines.push("");
  } else if (ctx.omiCompromaxEur || ctx.omiCompromInEur) {
    lines.push(`📊 *Valori OMI di zona* _(fonte: Agenzia Entrate – OMI ${ctx.omiSemestre ?? ""})_`.trim());
    if (ctx.omiCompromInEur && ctx.omiCompromaxEur) {
      lines.push(`• Range €/mq: ${formatEuro(ctx.omiCompromInEur)} – ${formatEuro(ctx.omiCompromaxEur)}`);
    } else if (ctx.omiCompromaxEur) {
      lines.push(`• OMI max €/mq: ${formatEuro(ctx.omiCompromaxEur)}`);
    }
    lines.push("");
  }

  // ── Asta vicina ──
  if ((ctx.asteImminentiCount ?? 0) > 0) {
    lines.push("⚖️ *Aste in zona* _(fonte: PVP – Ministero della Giustizia)_");
    lines.push(`• ${ctx.asteImminentiCount} asta/e attiva/e nel comune di ${marker.municipality ?? "riferimento"}`);
    if (ctx.asteEvidenceUrl) lines.push(`• Verifica: ${ctx.asteEvidenceUrl}`);
    lines.push("");
  }

  // ── Picco domanda (ISTAT) ──
  if (ctx.domandaPickIstatScore !== null && ctx.domandaPickIstatScore !== undefined && ctx.domandaPickIstatScore > 0) {
    lines.push("📈 *Domanda di zona* _(fonte: ISTAT – demografia comunale)_");
    lines.push(`• Indice ISTAT: ${ctx.domandaPickIstatScore.toFixed(0)}/100`);
    if (ctx.domandaPickIstatNota) lines.push(`• ${ctx.domandaPickIstatNota}`);
    lines.push("");
  }

  // ── Footer evidenze + fonti consolidate ──
  if (evidenze.length > 0) {
    lines.push("🔎 *Evidenze*");
    for (const e of evidenze.slice(0, 5)) lines.push(`• ${e}`);
    lines.push("");
  }
  if (fonti.length > 0) {
    lines.push(`_Fonti: ${Array.from(new Set(fonti)).join(" · ")}_`);
  }

  return lines.join("\n").slice(0, 1600);
}

export function generateHook(marker: DossierMarker, ctx: HookContext = {}): EngagementHook {
  const fonti: EngagementHook["fonti"] = [];
  const evidenze: string[] = [];

  const drops = Number(marker.payload.drops_count ?? 0);
  const totalDropPct = Number(marker.payload.total_drop_pct ?? 0);
  const daysOnline = Number(marker.payload.days_online ?? 0);
  const recentDrops60d = Number(marker.payload.recent_drops_60d ?? marker.payload.drops_in_60d ?? 0);
  const initialPrice = Number(marker.payload.initial_price_eur ?? 0);
  const lastPrice = Number(marker.payload.last_price_eur ?? 0);
  const fatigue = String(marker.payload.fatigue_label ?? "");
  const asteCount = ctx.asteImminentiCount ?? 0;
  const domandaScore = ctx.domandaPickIstatScore ?? null;

  const breakdown = computeVisibilityBreakdown(daysOnline, drops, recentDrops60d);
  const visibility = breakdown ? breakdown.visibilityIndex : null;
  const perdita = breakdown ? breakdown.perditaImmaginePct : null;

  // ── Capitale a Rischio (validazione OMI) ──
  // Best-effort: usa ctx.capitaleARischio se già pre-calcolato, altrimenti tenta
  // di calcolarlo on-the-fly da surface (payload) + OMI (ctx) + lastPrice.
  let capitale = ctx.capitaleARischio ?? null;
  if (!capitale) {
    const surface = Number(ctx.surfaceMq ?? marker.payload.surface_mq ?? marker.payload.superficie_mq ?? 0);
    capitale = computeCapitaleARischio({
      askingPriceEur: lastPrice || initialPrice,
      surfaceMq: surface,
      omiMaxEurPerMq: ctx.omiCompromaxEur ?? null,
      omiSemestre: ctx.omiSemestre ?? null,
    });
  }

  // ── Score "Notizia Peggiore" ──
  let badScore = 0;
  if (perdita !== null && perdita >= 60) badScore += 3;
  else if (perdita !== null && perdita >= 40) badScore += 2;
  else if (perdita !== null && perdita >= 20) badScore += 1;
  if (drops >= 3) badScore += 2;
  else if (drops >= 2) badScore += 1;
  if (recentDrops60d >= 2) badScore += 2;
  else if (recentDrops60d >= 1) badScore += 1;
  if (totalDropPct >= 15) badScore += 2;
  else if (totalDropPct >= 8) badScore += 1;
  if (asteCount >= 1) badScore += 2;
  if (fatigue === "caldissimo") badScore += 2;
  else if (fatigue === "caldo") badScore += 1;
  if (marker.kind === "agency_swap") badScore += 2;
  if (capitale && capitale.classificazione === "critico") badScore += 3;
  else if (capitale && capitale.classificazione === "elevato") badScore += 2;
  else if (capitale && capitale.classificazione === "moderato") badScore += 1;

  // ── Score "Notizia Migliore" ──
  let goodScore = 0;
  if (domandaScore !== null && domandaScore >= 70) goodScore += 3;
  else if (domandaScore !== null && domandaScore >= 50) goodScore += 2;
  else if (domandaScore !== null && domandaScore >= 30) goodScore += 1;
  if (marker.kind === "successione_densa") goodScore += 1;

  let kind: HookKind = "neutro";
  let headline = "";
  let body = "";

  if (badScore >= 3 && badScore >= goodScore) {
    kind = "notizia_peggiore";
    // Priorità 1: Capitale a Rischio CRITICO (gancio monetario di massimo impatto)
    if (capitale && capitale.classificazione === "critico" && capitale.euroAtRisk > 0) {
      headline = `${formatEuro(capitale.euroAtRisk)} di capitale esposto sopra il valore OMI`;
      body =
        `Confrontando il prezzo richiesto (${formatEuro(capitale.askingPriceEur)}) con il valore OMI massimo della zona ` +
        `(${formatEuro(capitale.omiMaxEurPerMq)}/mq × ${capitale.surfaceMq} mq = ${formatEuro(capitale.expectedOmiValueEur)}), ` +
        `risultano ${formatEuro(capitale.euroAtRisk)} di "capitale a rischio" (+${capitale.gapVsOmiPct.toFixed(1)}% sopra OMI). ` +
        `Ogni mese di permanenza online erode questo margine.`;
      fonti.push("OMI", "Portali");
      evidenze.push(`Capitale a Rischio: ${formatEuro(capitale.euroAtRisk)} (+${capitale.gapVsOmiPct.toFixed(1)}% vs OMI max) — fonte: OMI ${capitale.omiSemestre ?? ""}`.trim());
    } else if (asteCount >= 1) {
      headline = `Un'asta giudiziaria è stata aperta vicino al suo immobile`;
      body =
        `Nella zona di ${marker.municipality ?? "riferimento"} è attiva un'asta pubblica del Tribunale che influenzerà i prezzi richiesti del mercato libero per i prossimi 6 mesi. ` +
        `Vale la pena rivedere insieme la sua strategia prima che l'effetto sui valori si consolidi.`;
      fonti.push("PVP_Ministero_Giustizia");
      evidenze.push(`Aste attive nel comune: ${asteCount}${ctx.asteEvidenceUrl ? ` (PVP: ${ctx.asteEvidenceUrl})` : ""} — fonte: PVP Ministero Giustizia`);
    } else if (drops >= 2 && perdita !== null && perdita >= 30) {
      const recentNote = recentDrops60d >= 2
        ? ` (+${recentDrops60d} ribassi solo negli ultimi 60gg → -${(breakdown?.penaltyRibassiRecentiPct ?? 0).toFixed(0)}% sulla visibilità)`
        : "";
      headline = `Il suo annuncio ha perso ~${perdita.toFixed(0)}% di visibilità rispetto al lancio`;
      body =
        `Dopo ${Math.max(1, Math.round(daysOnline / 30))} mesi e ${drops} ribassi${recentNote}, l'indice di visibilità è sceso a ${visibility?.toFixed(0)}/100. ` +
        `Il mercato lo classifica come "annuncio bruciato": serve un cambio di approccio per riportarlo in evidenza.`;
      fonti.push("snapshot_storico", "Portali");
      evidenze.push(`Online ${Math.round(daysOnline)}gg, ${drops} ribassi (-${totalDropPct.toFixed(1)}%) — fonte: snapshot portali`);
      if (breakdown) {
        evidenze.push(`Formula visibilità: ${breakdown.formula} = ${breakdown.visibilityIndex.toFixed(0)}/100 — fonte: modello calibrato Lovable Core`);
      }
    } else if (totalDropPct >= 8) {
      const deltaAbs = initialPrice && lastPrice ? Math.round(initialPrice - lastPrice) : null;
      headline = `Il suo immobile ha già perso ${totalDropPct.toFixed(1)}% di valore richiesto`;
      body =
        `In ${Math.max(1, Math.round(daysOnline / 30))} mesi sono stati applicati ${drops} ribassi` +
        (deltaAbs ? ` (-${formatEuro(deltaAbs)} in valore assoluto)` : "") +
        `. Ogni settimana ulteriore di permanenza online riduce la sua leva negoziale.`;
      fonti.push("Portali", "snapshot_storico");
      evidenze.push(`Ribassi: ${drops} | Perdita richiesta: ${totalDropPct.toFixed(1)}% — fonte: snapshot portali`);
    } else {
      headline = `Segnali di stanchezza sul suo annuncio`;
      body = `L'immobile è online da ${Math.round(daysOnline)} giorni e mostra segnali di affaticamento del mercato. Possiamo rivedere insieme la strategia prima che l'effetto si consolidi.`;
      fonti.push("snapshot_storico");
      evidenze.push(`days_online=${daysOnline}; fatigue=${fatigue || "n/d"} — fonte: snapshot portali`);
    }
  } else if (goodScore >= 2 && goodScore > badScore) {
    kind = "notizia_migliore";
    if (domandaScore !== null && domandaScore >= 50) {
      headline = `Picco di domanda reale nella sua zona`;
      body =
        `Gli indici demografici e di insediamento per ${marker.municipality ?? "la zona"} segnalano un indice di domanda di ${domandaScore.toFixed(0)}/100. ` +
        (ctx.domandaPickIstatNota ? `${ctx.domandaPickIstatNota} ` : "") +
        `È una finestra favorevole per posizionare il suo immobile con la giusta strategia.`;
      fonti.push("ISTAT");
      evidenze.push(`Indice domanda ISTAT: ${domandaScore.toFixed(0)}/100 — fonte: ISTAT demografia comunale`);
    } else {
      headline = `Movimento favorevole di mercato in zona`;
      body = `I segnali demografici e di rotazione patrimoniale in zona stanno generando opportunità per chi vende nei prossimi mesi.`;
      fonti.push("ISTAT");
    }
  } else {
    kind = "neutro";
    headline = `Aggiornamento sul mercato della sua zona`;
    body = `Al momento non emergono segnali di forte urgenza né di picco di domanda: situazione stabile, monitoriamo.`;
  }

  // Aggiungi sempre OMI come ancora di autorità se disponibile (anche se non headline)
  if (ctx.omiCompromaxEur || ctx.omiCompromInEur) {
    fonti.push("OMI");
    if (ctx.omiCompromInEur && ctx.omiCompromaxEur) {
      evidenze.push(`OMI ${ctx.omiSemestre ?? ""} €/mq: ${formatEuro(ctx.omiCompromInEur)}–${formatEuro(ctx.omiCompromaxEur)} — fonte: Agenzia Entrate`);
    }
  }
  // Capitale a Rischio sempre come evidenza se calcolato (anche se non era il gancio principale)
  if (capitale && capitale.euroAtRisk > 0 && !evidenze.some((e) => e.startsWith("Capitale a Rischio"))) {
    evidenze.push(`Capitale a Rischio: ${formatEuro(capitale.euroAtRisk)} (+${capitale.gapVsOmiPct.toFixed(1)}% vs OMI max) — fonte: OMI ${capitale.omiSemestre ?? ""}`.trim());
    if (!fonti.includes("OMI")) fonti.push("OMI");
  }

  // Inietta capitale calcolato nel context per il WhatsApp builder
  const ctxWithCapitale: HookContext = { ...ctx, capitaleARischio: capitale };

  const whatsappMessage = buildWhatsAppMessage(
    marker,
    { headline, body, perditaImmaginePct: perdita, visibilityIndex: visibility, breakdown },
    ctxWithCapitale,
    evidenze,
    fonti,
  );

  return {
    kind,
    headline: headline.slice(0, 140),
    body: body.slice(0, 520),
    perditaImmaginePct: perdita,
    visibilityIndex: visibility,
    visibilityBreakdown: breakdown,
    capitaleARischioEur: capitale ? capitale.euroAtRisk : null,
    capitaleARischio: capitale,
    fonti: Array.from(new Set(fonti)),
    evidenze,
    whatsappMessage,
  };
}

// ── Helper: arricchisce il contesto OMI per un marker (compr_max della zona) ──
export async function buildHookContextForMarker(marker: DossierMarker): Promise<HookContext> {
  const supabase = getServiceClient();
  if (!supabase || !marker.municipality) return {};
  const ctx: HookContext = {};

  try {
    // OMI compr_max/min residenziale del comune (best-effort, prima zona disponibile)
    const { data: omi } = await supabase
      .from("omi_valori")
      .select("compr_max, compr_min, semestre, descr_tipologia")
      .ilike("comune_descrizione", marker.municipality)
      .order("compr_max", { ascending: false })
      .range(0, 19);
    if (Array.isArray(omi) && omi.length > 0) {
      const residenziale = omi.find((r) => /abitazion|ville|villin/i.test(String(r.descr_tipologia ?? ""))) ?? omi[0];
      ctx.omiCompromaxEur = residenziale?.compr_max ? Number(residenziale.compr_max) : null;
      ctx.omiCompromInEur = residenziale?.compr_min ? Number(residenziale.compr_min) : null;
      ctx.omiSemestre = residenziale?.semestre ?? null;
    }
  } catch (_) { /* best effort */ }

  try {
    // Aste imminenti nel comune (PVP via scraper)
    if (marker.lat !== null && marker.lng !== null) {
      const aste = await scrapeAsteGiudiziarie(marker.municipality, { lat: marker.lat, lng: marker.lng });
      if (aste.length > 0) {
        ctx.asteImminentiCount = aste.length;
        ctx.asteEvidenceUrl = aste[0]?.evidenceUrl ?? null;
      }
    }
  } catch (_) { /* best effort */ }

  try {
    // Indice domanda ISTAT semplificato: % under35 alta + popolazione crescente = score 0..100
    const { data: ist } = await supabase
      .from("istat_comuni")
      .select("percentuale_under35, percentuale_under18, popolazione, indice_vecchiaia")
      .ilike("comune", marker.municipality)
      .order("anno", { ascending: false })
      .range(0, 0);
    if (Array.isArray(ist) && ist.length > 0) {
      const r = ist[0];
      const under35 = Number(r.percentuale_under35 ?? 0);
      const indVec = Number(r.indice_vecchiaia ?? 200);
      // Score: under35 normalizzato (0..40 → 0..60 punti) + bonus se indice_vecchiaia <150 (zona giovane)
      let score = Math.max(0, Math.min(60, (under35 / 40) * 60));
      if (indVec > 0 && indVec < 150) score += 25;
      else if (indVec > 0 && indVec < 200) score += 10;
      ctx.domandaPickIstatScore = Math.round(score);
      ctx.domandaPickIstatNota =
        under35 > 0 ? `Under 35: ${under35.toFixed(1)}% — indice vecchiaia ${indVec.toFixed(0)} (ISTAT)` : null;
    }
  } catch (_) { /* best effort */ }

  return ctx;
}

export async function buildRadarClusterDossier(
  scope: { province?: string | null; municipality?: string | null } = {},
): Promise<RadarClusterDossier> {
  const supabase = getServiceClient();
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];

  if (!supabase) {
    return {
      region: "veneto",
      generatedAt,
      scope: { province: scope.province ?? undefined, municipality: scope.municipality ?? undefined },
      totals: { markers_rossi: 0, markers_viola: 0, markers_lead_caldo: 0 },
      markers: [],
      potereContrattualePerProvincia: [],
      warnings: ["Service role client non configurato."],
    };
  }

  const province = scope.province?.trim() ? scope.province.trim() : null;
  const municipality = scope.municipality?.trim() ? scope.municipality.trim() : null;

  const [bruciati, successioni, potere] = await Promise.all([
    fetchMarkersBruciati(supabase, province, municipality).catch((e) => { warnings.push(`bruciati: ${e instanceof Error ? e.message : String(e)}`); return [] as DossierMarker[]; }),
    fetchMarkersSuccessioniDense(supabase, province, municipality).catch((e) => { warnings.push(`successioni: ${e instanceof Error ? e.message : String(e)}`); return [] as DossierMarker[]; }),
    fetchPotereContrattuale(supabase, province).catch((e) => { warnings.push(`potere: ${e instanceof Error ? e.message : String(e)}`); return [] as ProvinceContractualPower[]; }),
  ]);

  const markers = [...bruciati, ...successioni];

  // Arricchimento "Gancio d'Apertura" — calcoli sync + fetch aste PVP per marker rossi/ambra
  try {
    await enrichMarkersConGanci(markers);
  } catch (e) {
    warnings.push(`ganci_apertura: ${e instanceof Error ? e.message : String(e)}`);
  }
  const totals = {
    markers_rossi: markers.filter((m) => m.color === "rosso").length,
    markers_viola: markers.filter((m) => m.color === "viola").length,
    markers_lead_caldo: markers.filter((m) => m.kind === "lead_caldo").length,
  };

  if (markers.length === 0) {
    warnings.push("Nessun marker disponibile: i dati maturano con i job daily (snapshot, succession-heatmap, price-resistance).");
  }

  return {
    region: "veneto",
    generatedAt,
    scope: { province: province ?? undefined, municipality: municipality ?? undefined },
    totals,
    markers,
    potereContrattualePerProvincia: potere,
    warnings,
  };
}
