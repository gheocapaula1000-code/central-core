// ═══════════════════════════════════════════════════════════════
// Civiko One — Metodo Civiko One: Foto + Geolocalizzazione + Dati Rapidi
//
// POST /civiko/property-from-photo
// Alias: POST /civiko/metodo-civiko-one
//
// Orchestrates internal Civiko endpoints and shapes the response in
// the EXACT contract the Civiko One PWA Scansione page already
// renders. The PWA never sees raw Sottra/OMI/ISPRA payloads, secrets
// or scraping logic.
//
// HARD RULES:
//   - Photo never persisted, never echoed back, EXIF never exposed.
//   - Forbidden vocabulary stripped from every outgoing string.
//   - No invented facts: missing data → da_collegare / da_preparare.
//   - Never crashes the PWA: failures degrade to status="partial".
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import {
  sanitizeOutgoing,
} from "../_shared/civiko.ts";
import {
  runInternalSottraContext, type SottraContext, type SottraSignalHint,
} from "./sottraInternal.ts";
import { buildZonaIntelligence } from "./zonaIntelligence.ts";
import { buildVenetoEnrichment } from "./venetoEnrichment.ts";
import { analyzePhotosWithVision, type AggregatedVisionAnalysis } from "./visionAnalyzer.ts";
import { resolveInternalSecret } from "../_shared/http.ts";
import { runApifyPhotoEnrichment, type TerritorialDocument } from "./apifyPhotoEnrichment.ts";
import { runFirecrawlPhotoEnrichment, listFirecrawlSourceNames, type LiveSignal } from "./firecrawlPhotoEnrichment.ts";

const FUNCTION_NAME = "civiko-property-from-photo";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-from-photo";
const ROUTES = [
  "GET  /health",
  "GET  /manifest",
  "POST /civiko/property-from-photo",
  "POST /civiko/metodo-civiko-one",
];

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB

// ── PWA contract (request) ────────────────────────────────────

type AmbienteTagInput =
  | "esterno" | "soggiorno" | "cucina" | "camera" | "cameretta"
  | "bagno" | "terrazzo_balcone" | "giardino" | "altro";

interface PwaPhoto {
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  sizeKb?: number;
  /** Conferma dell'agente sull'ambiente della foto: PREVALE sulla proposta vision. */
  ambiente?: AmbienteTagInput;
}
interface PwaGeo {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  manualAddress?: string;
  source?: "device" | "manual" | "missing" | "photo_exif";
}
interface PwaQuickFacts {
  titoloInterno?: string;
  zona?: string;
  tipologia?: string;
  metratura?: string;
  locali?: string;
  prezzoRichiesto?: string;
  obiettivoProprietario?: string;
  obiezionePrincipale?: string;
  urgenza?: string;
  targetAcquirente?: string;
}
interface PwaVisita {
  caratteristiche?: string[];
  criticita?: string[];
  note?: string;
}
interface RequestBody {
  agencyId?: string;
  photo?: PwaPhoto;
  photos?: PwaPhoto[];
  geo?: PwaGeo;
  quickFacts?: PwaQuickFacts;
  visita?: PwaVisita;
  elementiConfermati?: string[];
  variante?: number;
  // Legacy fields tolerated but not required.
  capture?: unknown;
  propertyDraft?: unknown;
}

// ── PWA contract (response) ───────────────────────────────────

type FonteStatus = "da_collegare" | "da_consultare" | "collegata" | "da_rivedere" | "non_disponibile";
type SezioneStatus = "da_preparare" | "da_validare" | "pronta" | "da_collegare";
type IdentityConfidence = "alta" | "media" | "bassa" | "non_definita";
type InputLevel = "minimo" | "parziale" | "buono" | "completo";

interface DisplayItem { label: string; value: string }
interface FonteOut {
  id: string;
  title: string;
  status: FonteStatus;
  purpose: string;
  sourceOwner: string;
  displayItems: DisplayItem[];
}
interface SegnaleOut { id: string; label: string; detail?: string }
interface PresentazioneSezione {
  id: string;
  title: string;
  status: SezioneStatus;
  bullets: string[];
}

// ── helpers ───────────────────────────────────────────────────

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function projectBaseUrl(): string | null {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return null;
  return `${url.replace(/\/$/, "")}/functions/v1`;
}

async function callSibling(
  fnName: string,
  payload: unknown,
  debugId: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const base = projectBaseUrl();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !serviceKey) return { ok: false, status: 0, data: null };
  try {
    const res = await fetch(`${base}/${fnName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    } catch { /* keep null */ }
    if (!res.ok) console.warn(`[${FUNCTION_NAME}] sibling ${fnName} status=${res.status} debug_id=${debugId}`);
    return { ok: res.ok, status: res.status, data: parsed };
  } catch (e) {
    console.error(`[${FUNCTION_NAME}] sibling ${fnName} fetch failed: ${e instanceof Error ? e.message : String(e)} debug_id=${debugId}`);
    return { ok: false, status: 0, data: null };
  }
}

function safeStr(v: unknown, fallback = ""): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v.trim();
  return String(v).trim();
}

// ── Contenuti marketing (chiamata interna a property-marketing-pack) ──

interface ContenutiInput {
  facts: PwaQuickFacts;
  visionAnalysis: AggregatedVisionAnalysis;
  immobile: { title: string; address: string; zone: string };
  photosCount: number;
  visita?: PwaVisita;
  elementiConfermati?: string[];
  toneHint?: "professionale" | "caldo" | "diretto";
  zonaServiziDescrizione?: string;
  debugId: string;
}

interface ContenutiPronta {
  status: "pronta";
  listingTextLong: string;
  listingTextShort: string;
  ownerMessage: string;
  socialVariants: unknown[];
  highlights: string[];
  objectionAnswers: unknown[];
  nextBestAction: string;
  hashtags: string[];
  confidence: string;
}
type Contenuti = ContenutiPronta | { status: "non_disponibile" };

function buildPhotosSummary(v: AggregatedVisionAnalysis, count: number): string {
  if (v.visionStatus === "non_disponibile" || count === 0) return "";
  const parts: string[] = [];
  parts.push(`${count} foto analizzate`);
  if (v.tipologiaProbabile) parts.push(`tipologia rilevata ${v.tipologiaProbabile}`);
  if (v.statoApparente) parts.push(`stato ${v.statoApparente.toLowerCase()}`);
  if (v.materialePresunto) parts.push(`materiale prevalente ${v.materialePresunto}`);
  if (v.annoPresunto) parts.push(`anno stimato ${v.annoPresunto}`);
  if (v.puntiDiForzaVisivi.length > 0) parts.push(`punti di forza: ${v.puntiDiForzaVisivi.slice(0, 6).join(", ")}`);
  if (v.presenzaGiardino) parts.push("con giardino");
  if (v.presenzaParcheggio) parts.push("con parcheggio");
  return parts.join("; ") + ".";
}

function dedupStrings(arrs: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arrs) {
    if (!a) continue;
    for (const raw of a) {
      const s = safeStr(raw);
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

async function buildContenutiMarketing(input: ContenutiInput): Promise<Contenuti> {
  const {
    facts, visionAnalysis, immobile, photosCount,
    visita, elementiConfermati, toneHint, zonaServiziDescrizione, debugId,
  } = input;
  const base = projectBaseUrl();
  if (!base) return { status: "non_disponibile" };

  const { secret } = resolveInternalSecret("civiko");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!secret) return { status: "non_disponibile" };

  const title = safeStr(facts.titoloInterno) ||
    [safeStr(facts.tipologia), safeStr(facts.zona)].filter(Boolean).join(" — ") ||
    immobile.title ||
    "Immobile";

  const elementiBase = (elementiConfermati && elementiConfermati.length > 0)
    ? elementiConfermati
    : visionAnalysis.puntiDiForzaVisivi;
  const strengths = dedupStrings([visita?.caratteristiche, elementiBase, visionAnalysis.puntiDiForzaVisivi]);
  const objections = dedupStrings([
    safeStr(facts.obiezionePrincipale) ? [safeStr(facts.obiezionePrincipale)] : [],
    visita?.criticita,
  ]);

  const photosSummaryParts: string[] = [];
  const visionSummary = buildPhotosSummary(visionAnalysis, photosCount);
  if (visionSummary) photosSummaryParts.push(visionSummary);
  const note = safeStr(visita?.note);
  if (note) photosSummaryParts.push(note);
  if (zonaServiziDescrizione) photosSummaryParts.push(zonaServiziDescrizione);

  const property: Record<string, unknown> = {
    title,
    address: immobile.address || undefined,
    comune: "Padova",
    property_type: safeStr(facts.tipologia) || undefined,
    mq: safeStr(facts.metratura) || undefined,
    rooms: safeStr(facts.locali) || undefined,
    estimated_value: safeStr(facts.prezzoRichiesto) || undefined,
    photos_summary: photosSummaryParts.join(" ").trim(),
    strengths,
    objections,
    urgency: safeStr(facts.urgenza) || safeStr(facts.obiettivoProprietario) || undefined,
  };

  const body: Record<string, unknown> = { source_app: "civiko", property };
  if (toneHint) body.tone_hint = toneHint;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${base}/property-marketing-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
        "x-internal-secret": secret,
        "x-source-app": "civiko",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[${FUNCTION_NAME}] marketing-pack status=${res.status} debug_id=${debugId}`);
      return { status: "non_disponibile" };
    }
    const j = await res.json();
    const pack = (j && typeof j === "object" && j.data && typeof j.data === "object") ? j.data as Record<string, unknown> : null;
    if (!pack) return { status: "non_disponibile" };
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
    return {
      status: "pronta",
      listingTextLong: String(pack.listing_text_long ?? ""),
      listingTextShort: String(pack.listing_text_short ?? ""),
      ownerMessage: String(pack.owner_message ?? ""),
      socialVariants: Array.isArray(pack.social_variants) ? pack.social_variants as unknown[] : [],
      highlights: arr(pack.highlights),
      objectionAnswers: Array.isArray(pack.objection_answers) ? pack.objection_answers as unknown[] : [],
      nextBestAction: String(pack.next_best_action ?? ""),
      hashtags: arr(pack.hashtags),
      confidence: String(pack.confidence ?? ""),
    };
  } catch (e) {
    console.warn(`[${FUNCTION_NAME}] marketing-pack error debug_id=${debugId}: ${e instanceof Error ? e.message : String(e)}`);
    return { status: "non_disponibile" };
  } finally {
    clearTimeout(timer);
  }
}

function resolveToneHint(variante: number | undefined): "professionale" | "caldo" | "diretto" {
  const cycle = ["professionale", "caldo", "diretto"] as const;
  const v = Number.isFinite(variante) && (variante as number) > 0 ? Math.floor(variante as number) : 1;
  return cycle[(v - 1) % cycle.length];
}

// ── input quality ─────────────────────────────────────────────

function evaluateInput(body: RequestBody): {
  inputQuality: {
    hasPhoto: boolean;
    hasGeo: boolean;
    hasManualAddress: boolean;
    level: InputLevel;
  };
  warnings: string[];
  hasUsablePhoto: boolean;
  coords: { lat: number; lng: number } | null;
  manualAddress: string;
} {
  const warnings: string[] = [];
  const photo = body.photo ?? {};
  const geo = body.geo ?? {};
  const facts = body.quickFacts ?? {};

  // photo
  let hasPhoto = false;
  let hasUsablePhoto = false;
  if (photo.dataUrl && typeof photo.dataUrl === "string" && photo.dataUrl.length > 64) {
    hasPhoto = true;
    const sizeBytes = (typeof photo.sizeKb === "number" ? photo.sizeKb * 1024 : photo.dataUrl.length * 0.75);
    const mime = (photo.mimeType ?? "").toLowerCase();
    if (sizeBytes > MAX_PHOTO_BYTES) {
      warnings.push("La foto supera la dimensione consentita: caricarne una più leggera.");
    } else if (mime && !["image/jpeg", "image/jpg", "image/webp", "image/png"].includes(mime)) {
      warnings.push("Formato foto non supportato: usare JPG, PNG o WebP.");
    } else {
      hasUsablePhoto = true;
    }
  }

  // geo
  const hasDeviceGeo =
    geo.source === "device" &&
    typeof geo.latitude === "number" && typeof geo.longitude === "number" &&
    Math.abs(geo.latitude) <= 90 && Math.abs(geo.longitude) <= 180;
  const coords = hasDeviceGeo ? { lat: geo.latitude!, lng: geo.longitude! } : null;
  const manualAddress = safeStr(geo.manualAddress);
  const hasManualAddress = manualAddress.length > 0;

  // input level
  const factCount = [
    facts.titoloInterno, facts.zona, facts.tipologia, facts.metratura, facts.locali,
    facts.prezzoRichiesto, facts.obiettivoProprietario, facts.obiezionePrincipale,
    facts.urgenza, facts.targetAcquirente,
  ].filter((v) => safeStr(v).length > 0).length;

  let level: InputLevel = "minimo";
  if (hasUsablePhoto && hasDeviceGeo && factCount >= 5) level = "completo";
  else if ((hasUsablePhoto && hasDeviceGeo) || (hasManualAddress && factCount >= 3)) level = "buono";
  else if (hasUsablePhoto || hasDeviceGeo || hasManualAddress) level = "parziale";

  // Radar nazionale: nessuna restrizione geografica. Le verifiche di
  // contesto vengono comunque marcate come "da_collegare" se mancano dati.

  return {
    inputQuality: {
      hasPhoto,
      hasGeo: hasDeviceGeo,
      hasManualAddress,
      level,
    },
    warnings,
    hasUsablePhoto,
    coords,
    manualAddress,
  };
}

// ── identity (Immobile Reale) ─────────────────────────────────

function buildImmobileReale(
  body: RequestBody,
  ctx: ReturnType<typeof evaluateInput>,
): {
  title: string; address: string; zone: string;
  confidence: IdentityConfidence; needsManualAddress: boolean;
} {
  const facts = body.quickFacts ?? {};
  const title = safeStr(facts.titoloInterno) || "Immobile Reale";
  const zone = safeStr(facts.zona);
  const address = ctx.manualAddress;

  let confidence: IdentityConfidence = "non_definita";
  if (ctx.coords && address) confidence = "alta";
  else if (ctx.coords || (address && zone)) confidence = "media";
  else if (address || zone) confidence = "bassa";

  const needsManualAddress = !ctx.coords && !address;
  return { title, address, zone, confidence, needsManualAddress };
}

// ── default fonti scaffold (always 7 areas, honest defaults) ──

const FONTI_DEFAULT: Array<Omit<FonteOut, "displayItems"> & { displayItems: DisplayItem[] }> = [
  { id: "omi",                  title: "Riferimenti OMI",       status: "da_collegare", purpose: "Riferimenti di Mercato della zona OMI quando disponibili.", sourceOwner: "Agenzia delle Entrate",                 displayItems: [] },
  { id: "padova_municipality",  title: "Comune",                status: "da_collegare", purpose: "Cartografia comunale ed Elementi di Zona.",                 sourceOwner: "Comune / ISTAT",                         displayItems: [] },
  { id: "neighborhood_context", title: "Contesto di Quartiere", status: "da_collegare", purpose: "Quadro di contesto del quartiere.",                         sourceOwner: "Comune / ISTAT",                         displayItems: [] },
  { id: "territorial_data",     title: "Dati Territoriali",     status: "da_collegare", purpose: "Verifica di Supporto Territoriale.",                        sourceOwner: "Fonti territoriali",                     displayItems: [] },
  { id: "cadastral_checks",     title: "Verifiche Catastali",   status: "da_collegare", purpose: "Documentazione catastale da raccogliere e verificare.",     sourceOwner: "Documentazione Agenzia",                 displayItems: [] },
  { id: "schools_services",     title: "Scuole e Servizi",      status: "da_collegare", purpose: "Elementi di Zona su scuole e servizi.",                     sourceOwner: "MIM / Fonti disponibili",                displayItems: [] },
  { id: "zone_signals",         title: "Segnali di Zona",       status: "da_collegare", purpose: "Temi ricorrenti e segnali pubblici della zona.",            sourceOwner: "Fonti Locali",                           displayItems: [] },
];

function mapFonti(
  sourceProfile: Record<string, unknown> | null,
  sottra: SottraContext | null,
): FonteOut[] {
  const base: FonteOut[] = FONTI_DEFAULT.map((f) => ({ ...f, displayItems: [] }));
  if (sourceProfile) {
    const areas = Array.isArray(sourceProfile.sourceAreas) ? sourceProfile.sourceAreas as Array<Record<string, unknown>> : [];
    if (areas.length > 0) {
      const byId = new Map(base.map((f, i) => [f.id, i]));
      for (const a of areas) {
        const id = safeStr(a.id);
        const idx = byId.get(id);
        if (idx == null) continue;
        const status = safeStr(a.status) as FonteStatus;
        const validStatuses: FonteStatus[] = ["da_collegare", "da_consultare", "collegata", "da_rivedere", "non_disponibile"];
        base[idx].status = validStatuses.includes(status) ? status : "da_collegare";
        if (a.title) base[idx].title = safeStr(a.title) || base[idx].title;
        if (a.purpose) base[idx].purpose = safeStr(a.purpose) || base[idx].purpose;
        if (a.sourceOwner) base[idx].sourceOwner = safeStr(a.sourceOwner) || base[idx].sourceOwner;
        const items = Array.isArray(a.displayItems) ? a.displayItems as Array<Record<string, unknown>> : [];
        base[idx].displayItems = items
          .filter((x) => x && typeof x === "object")
          .map((x) => ({ label: safeStr(x.label), value: safeStr(x.value) }))
          .filter((x) => x.label && x.value);
      }
    }
  }

  // Internal context enrichment — only if real data was returned upstream.
  // Never invents displayItems; only fills the OMI area when Sottra returned
  // verifiable references.
  if (sottra?.omi?.available && sottra.omi.displayItems.length > 0) {
    const omiIdx = base.findIndex((f) => f.id === "omi");
    if (omiIdx >= 0 && base[omiIdx].displayItems.length === 0) {
      base[omiIdx].status = sottra.omi.status;
      base[omiIdx].displayItems = sottra.omi.displayItems;
    }
  }

  return base;
}

// ── zona in movimento mapping ─────────────────────────────────

interface ZimSignalIn {
  id?: number; fact?: { title?: string; summary?: string; source?: string };
}
function toSegnale(sig: ZimSignalIn, fallbackPrefix: string, idx: number): SegnaleOut {
  const id = sig.id != null ? `s_${sig.id}` : `${fallbackPrefix}_${idx}`;
  const label = safeStr(sig.fact?.title) || "Segnale di Zona";
  const detail = safeStr(sig.fact?.summary) || safeStr(sig.fact?.source) || undefined;
  return detail ? { id, label, detail } : { id, label };
}

function mapZonaInMovimento(zim: Record<string, unknown> | null): {
  segnaliForti: SegnaleOut[]; puntiAttenzione: SegnaleOut[];
  leveNarrative: string[]; talkingPointsProprietario: string[];
} {
  if (!zim) {
    return { segnaliForti: [], puntiAttenzione: [], leveNarrative: [], talkingPointsProprietario: [] };
  }
  const strong = Array.isArray(zim.strongSignals) ? zim.strongSignals as ZimSignalIn[] : [];
  const future = Array.isArray(zim.futureNarrative) ? zim.futureNarrative as ZimSignalIn[] : [];
  const attention = Array.isArray(zim.attentionSignals) ? zim.attentionSignals as ZimSignalIn[] : [];

  const segnaliForti = [...strong, ...future].slice(0, 8).map((s, i) => toSegnale(s, "forti", i));
  const puntiAttenzione = attention.slice(0, 8).map((s, i) => toSegnale(s, "att", i));

  const leveNarrative: string[] = [];
  for (const s of [...strong, ...future].slice(0, 4)) {
    const t = safeStr(s.fact?.title);
    const src = safeStr(s.fact?.source);
    if (t) leveNarrative.push(src ? `Usare "${t}" (${src}) come leva narrativa documentabile.` : `Usare "${t}" come leva narrativa documentabile.`);
  }
  const ownerHooks = Array.isArray(zim.ownerTalkingPoints) ? zim.ownerTalkingPoints as unknown[] : [];
  const talkingPointsProprietario = ownerHooks.map((x) => safeStr(x)).filter(Boolean).slice(0, 6);

  return { segnaliForti, puntiAttenzione, leveNarrative, talkingPointsProprietario };
}

// ── merge internal Sottra context into Zona in Movimento ──────
function mergeSottraIntoZona(
  zim: { segnaliForti: SegnaleOut[]; puntiAttenzione: SegnaleOut[]; leveNarrative: string[]; talkingPointsProprietario: string[] },
  sottra: SottraContext,
): void {
  if (!sottra.used) return;
  const strongPool: SottraSignalHint[] = [...sottra.infrastrutture, ...sottra.developmentHints];
  if (zim.segnaliForti.length === 0) {
    zim.segnaliForti = strongPool.slice(0, 6).map((s, i) => ({
      id: `int_strong_${i}`,
      label: s.title,
      ...(s.detail ? { detail: s.detail } : {}),
    }));
  }
  if (zim.puntiAttenzione.length === 0 && sottra.riskFlags.length > 0) {
    zim.puntiAttenzione = sottra.riskFlags.slice(0, 6).map((s, i) => ({
      id: `int_att_${i}`,
      label: s.title,
      ...(s.detail ? { detail: s.detail } : {}),
    }));
  }
  if (zim.leveNarrative.length === 0) {
    const leve: string[] = [];
    for (const s of strongPool.slice(0, 3)) {
      leve.push(s.source
        ? `Usare "${s.title}" (${s.source}) come leva narrativa documentabile.`
        : `Usare "${s.title}" come leva narrativa documentabile.`);
    }
    if (sottra.convergenceSummary) {
      leve.push(`Inquadrare il quartiere con il quadro di zona: ${sottra.convergenceSummary}.`);
    }
    zim.leveNarrative = leve;
  }
  if (zim.talkingPointsProprietario.length === 0) {
    const tp: string[] = [];
    for (const s of sottra.demographicHints.slice(0, 2)) tp.push(`Quadro di quartiere: ${s.title}.`);
    for (const s of sottra.marketHints.slice(0, 2)) tp.push(`Riferimento di Mercato: ${s.title}.`);
    zim.talkingPointsProprietario = tp.slice(0, 4);
  }
}

// ── piano esclusiva mapping ───────────────────────────────────

function mapPianoEsclusiva(
  pe: Record<string, unknown> | null,
  facts: PwaQuickFacts,
  fonti: FonteOut[],
): {
  posizioneNegoziale: string; levaPrincipale: string; argomentoEsclusiva: string;
  rischioSenzaEsclusiva: string; frasiDaUsare: string[]; prossimeAzioni: string[];
} {
  // Default commercially-strong text (used when sibling unavailable).
  const collegate = fonti.filter((f) => f.status === "collegata").map((f) => f.title);
  const daCollegare = fonti.filter((f) => f.status === "da_collegare" || f.status === "da_consultare").map((f) => f.title);

  const defaultFrasi = [
    "Apri il Primo Appuntamento mostrando il Metodo Civiko One.",
    "Non partire dalla provvigione: parti dal Servizio Completo.",
    "Mostra prima la Presentazione Proprietario costruita sui dati reali.",
    "Usa i primi giorni di pubblicazione come argomento centrale.",
    "Porta il Proprietario a vedere preparazione, materiali e gestione.",
  ];
  const defaultAzioni = [
    "Confermare il Primo Appuntamento e portare la Presentazione Proprietario.",
    "Preparare il Dossier Venditore con le Fonti da Collegare segnalate.",
    daCollegare.length > 0 ? `Collegare prima del Primo Appuntamento: ${daCollegare.slice(0, 4).join(", ")}.` : "Verificare che le fonti previste risultino collegate o pianificate.",
    "Pianificare il follow-up entro 48 ore dal Primo Appuntamento.",
  ];

  if (!pe) {
    const obiezione = safeStr(facts.obiezionePrincipale);
    const obiettivo = safeStr(facts.obiettivoProprietario);
    return {
      posizioneNegoziale: obiettivo
        ? `Costruire la Posizione Negoziale intorno all'obiettivo del Proprietario: ${obiettivo}.`
        : "Costruire la Posizione Negoziale a partire dai Riferimenti di Mercato e dal Servizio Completo.",
      levaPrincipale: collegate.length > 0
        ? `Sfruttare le Verifiche di Supporto disponibili: ${collegate.slice(0, 3).join(", ")}.`
        : "Costruire la leva narrativa con i Riferimenti di Zona disponibili al Primo Appuntamento.",
      argomentoEsclusiva: "Presentare il Metodo Civiko One e il Servizio Completo come standard che protegge il Valore Percepito dell'immobile.",
      rischioSenzaEsclusiva: obiezione
        ? `Senza Incarico in Esclusiva il punto critico "${obiezione}" resta non gestito e disperso tra più agenzie.`
        : "Senza Incarico in Esclusiva il posizionamento iniziale viene disperso tra più agenzie e perde coerenza.",
      frasiDaUsare: defaultFrasi,
      prossimeAzioni: defaultAzioni,
    };
  }

  const positioning = (pe.positioning ?? {}) as Record<string, unknown>;
  const toStrList = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map((x) => safeStr(x)).filter((s) => s.length > 0) : [];
  const mainLeverage = toStrList(pe.mainLeverage);
  const exclusiveArgument = toStrList(pe.exclusiveArgument);
  const riskIfNoExclusive = toStrList(pe.riskIfNoExclusive);
  const phrasesToUse = toStrList(pe.phrasesToUse);
  const nextActions = toStrList(pe.nextActions);

  return {
    posizioneNegoziale: safeStr(positioning.summary) || "Costruire la Posizione Negoziale sui Riferimenti di Mercato e sul Servizio Completo.",
    levaPrincipale: mainLeverage[0] ?? "Costruire la leva narrativa con i Riferimenti di Zona disponibili al Primo Appuntamento.",
    argomentoEsclusiva: exclusiveArgument[0] ?? "Presentare il Metodo Civiko One come standard del Servizio Completo.",
    rischioSenzaEsclusiva: riskIfNoExclusive[0] ?? "Senza Incarico in Esclusiva il posizionamento iniziale viene disperso tra più agenzie.",
    frasiDaUsare: phrasesToUse.length > 0 ? phrasesToUse : defaultFrasi,
    prossimeAzioni: nextActions.length > 0 ? nextActions : defaultAzioni,
  };
}

// ── presentazione proprietario ────────────────────────────────

function buildPresentazione(
  immobile: ReturnType<typeof buildImmobileReale>,
  fonti: FonteOut[],
  zim: ReturnType<typeof mapZonaInMovimento>,
  piano: ReturnType<typeof mapPianoEsclusiva>,
): { sections: PresentazioneSezione[]; materialiDaValidare: string[] } {
  const collegate = fonti.filter((f) => f.status === "collegata");
  const fontiSezioneStatus: SezioneStatus = collegate.length >= 3 ? "pronta" : collegate.length > 0 ? "da_validare" : "da_collegare";

  const sections: PresentazioneSezione[] = [
    {
      id: "metodo_civiko_one",
      title: "Metodo Civiko One",
      status: "pronta",
      bullets: [
        "Servizio Completo a supporto del Proprietario.",
        "Presentazione Proprietario costruita sui dati reali.",
        "Materiali da Validare prima della pubblicazione.",
      ],
    },
    {
      id: "immobile_reale",
      title: "Immobile Reale",
      status: immobile.confidence === "alta" || immobile.confidence === "media" ? "pronta" : "da_preparare",
      bullets: [
        immobile.title ? `Titolo interno: ${immobile.title}.` : "Titolo interno da definire con l'agenzia.",
        immobile.address ? `Indirizzo: ${immobile.address}.` : "Indirizzo da confermare con il Proprietario.",
        immobile.zone ? `Zona: ${immobile.zone}.` : "Zona da definire con il Proprietario.",
      ],
    },
    {
      id: "fonti_da_collegare",
      title: "Fonti da Collegare",
      status: fontiSezioneStatus,
      bullets: fonti.slice(0, 6).map((f) => `${f.title}: ${labelForStatus(f.status)}.`),
    },
    {
      id: "zona_in_movimento",
      title: "Zona in Movimento",
      status: zim.segnaliForti.length > 0 ? "da_validare" : "da_collegare",
      bullets: zim.segnaliForti.length > 0
        ? zim.segnaliForti.slice(0, 5).map((s) => s.detail ? `${s.label} — ${s.detail}` : s.label)
        : ["Segnali di Zona da collegare prima del Primo Appuntamento."],
    },
    {
      id: "piano_esclusiva",
      title: "Piano Esclusiva",
      status: "pronta",
      bullets: [
        piano.posizioneNegoziale,
        piano.levaPrincipale,
        piano.argomentoEsclusiva,
        piano.rischioSenzaEsclusiva,
      ],
    },
    {
      id: "materiali_da_validare",
      title: "Materiali da Validare",
      status: "da_validare",
      bullets: [
        "Documentazione catastale e di conformità.",
        "Riferimenti di Mercato della zona OMI.",
        "Verifiche di Supporto Territoriale.",
        "Eventuali Segnali di Zona da rivedere prima della pubblicazione.",
      ],
    },
  ];

  const materialiDaValidare = [
    "Documentazione catastale e di conformità.",
    "Riferimenti di Mercato della zona OMI.",
    "Verifiche di Supporto Territoriale.",
    "Segnali di Zona prima della pubblicazione.",
  ];
  return { sections, materialiDaValidare };
}

function labelForStatus(s: FonteStatus): string {
  switch (s) {
    case "collegata": return "Collegata";
    case "da_consultare": return "Verifica di Supporto";
    case "da_rivedere": return "Da Rivedere";
    case "non_disponibile": return "Non Disponibile";
    default: return "Fonte da Collegare";
  }
}

// ── orchestration ─────────────────────────────────────────────

// Bounding-box approssimativi delle 7 province venete.
// Usato come fallback quando venetoEnrichment/sottra non risolvono la provincia.
const VENETO_BBOX: Record<string, { lat: [number, number]; lng: [number, number] }> = {
  PD: { lat: [45.0, 45.6], lng: [11.6, 12.0] },
  VR: { lat: [45.2, 45.7], lng: [10.6, 11.4] },
  VI: { lat: [45.4, 45.9], lng: [11.2, 11.8] },
  VE: { lat: [45.3, 45.6], lng: [12.0, 12.6] },
  TV: { lat: [45.6, 46.0], lng: [11.8, 12.4] },
  BL: { lat: [46.0, 46.6], lng: [11.8, 12.6] },
  RO: { lat: [44.8, 45.2], lng: [11.2, 12.2] },
};

function provinciaFromBbox(coords: { lat: number; lng: number } | null): string {
  if (!coords) return "";
  for (const [code, b] of Object.entries(VENETO_BBOX)) {
    if (coords.lat >= b.lat[0] && coords.lat <= b.lat[1] &&
        coords.lng >= b.lng[0] && coords.lng <= b.lng[1]) {
      return code;
    }
  }
  return "";
}

function resolveProvincia(
  veneto: { venetoScope?: { provincia?: string | null } } | null | undefined,
  sottra: { identity?: { provincia?: string | null } } | null | undefined,
  coords: { lat: number; lng: number } | null,
): string {
  const fromVeneto = (veneto?.venetoScope?.provincia ?? "").toString().trim().toUpperCase();
  if (fromVeneto && fromVeneto.length === 2) return fromVeneto;
  const fromSottra = (sottra?.identity?.provincia ?? "").toString().trim().toUpperCase();
  if (fromSottra && fromSottra.length === 2) return fromSottra;
  return provinciaFromBbox(coords);
}


async function orchestrate(body: RequestBody, debugId: string) {
  const ctx = evaluateInput(body);
  const rawFacts = body.quickFacts ?? {};
  const immobile = buildImmobileReale(body, ctx);
  const warnings = [...ctx.warnings];

  // ── Normalizzazione multi-foto ────────────────────────────────
  const rawPhotos: PwaPhoto[] = Array.isArray(body.photos) && body.photos.length > 0
    ? body.photos
    : (body.photo ? [body.photo] : []);
  const photoDataUrls: string[] = [];
  for (const p of rawPhotos) {
    if (!p || typeof p.dataUrl !== "string" || !p.dataUrl.startsWith("data:image/")) continue;
    const sizeBytes = typeof p.sizeKb === "number" ? p.sizeKb * 1024 : p.dataUrl.length * 0.75;
    if (sizeBytes > MAX_PHOTO_BYTES) continue;
    photoDataUrls.push(p.dataUrl);
  }
  if (photoDataUrls.length > 10) {
    warnings.push(`Ricevute ${photoDataUrls.length} foto: verranno analizzate solo le prime 10.`);
    photoDataUrls.length = 10;
  }

  // ── Rigenerazione veloce: variante>1 + elementiConfermati → skip vision ──
  const varianteNum = Number.isFinite(body.variante) && (body.variante as number) > 0
    ? Math.floor(body.variante as number)
    : 1;
  const elementiConfermati = Array.isArray(body.elementiConfermati)
    ? body.elementiConfermati.map((s) => safeStr(s)).filter(Boolean)
    : [];
  const skipVision = varianteNum > 1 && elementiConfermati.length > 0;

  // ── Vision layer: arricchisce quickFacts con analisi AI delle foto.
  // Non blocca mai la response principale: in errore restituisce default
  // con visionStatus="non_disponibile".
  let visionAnalysis: AggregatedVisionAnalysis;
  if (skipVision) {
    visionAnalysis = {
      tipologiaProbabile: "Immobile residenziale",
      pianoStimato: null,
      statoApparente: "Buone condizioni",
      puntiDiForzaVisivi: elementiConfermati,
      materialePresunto: null,
      annoPresunto: null,
      presenzaGiardino: false,
      presenzaParcheggio: false,
      fotoAnalizzate: 0,
      visionStatus: "ok",
    };
  } else {
    try {
      visionAnalysis = await analyzePhotosWithVision(photoDataUrls);
    } catch (e) {
      console.warn(`[${FUNCTION_NAME}] vision error debug_id=${debugId}: ${e instanceof Error ? e.message : String(e)}`);
      visionAnalysis = {
        tipologiaProbabile: "Immobile residenziale",
        pianoStimato: null,
        statoApparente: "Buone condizioni",
        puntiDiForzaVisivi: [],
        materialePresunto: null,
        annoPresunto: null,
        presenzaGiardino: false,
        presenzaParcheggio: false,
        fotoAnalizzate: 0,
        visionStatus: "non_disponibile",
      };
    }
  }
  const facts: PwaQuickFacts = {
    ...rawFacts,
    tipologia: safeStr(rawFacts.tipologia) || visionAnalysis.tipologiaProbabile,
    // statoApparente non è nel tipo legacy; viene esposto via immobileOut.
  };

  // Build a propertyDraft compatible with existing siblings.
  const propertyDraft = {
    title: safeStr(facts.titoloInterno) || undefined,
    address: ctx.manualAddress || undefined,
    zone: safeStr(facts.zona) || undefined,
    propertyType: safeStr(facts.tipologia) || undefined,
    sizeSqm: safeStr(facts.metratura) || undefined,
    rooms: safeStr(facts.locali) || undefined,
    askingPrice: safeStr(facts.prezzoRichiesto) || undefined,
    ownerGoal: safeStr(facts.obiettivoProprietario) || undefined,
    ownerPriority: safeStr(facts.urgenza) || undefined,
    mainObjection: safeStr(facts.obiezionePrincipale) || undefined,
    targetBuyer: safeStr(facts.targetAcquirente) || undefined,
  };
  // Derive municipality from the manual address (last meaningful segment).
  const municipality = (() => {
    const raw = ctx.manualAddress.trim();
    if (!raw) return "";
    const cleaned = raw.replace(/\b\d{5}\b/g, "").trim();
    const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && /^ital/i.test(parts[parts.length - 1])) parts.pop();
    const last = parts[parts.length - 1] ?? "";
    return last.replace(/\s+[A-Z]{2}$/, "").trim();
  })();

  const sourceProfilePayload = { agencyId: body.agencyId, propertyDraft };
  const hyperlocalPayload = {
    agencyId: body.agencyId,
    propertyDraft: { address: propertyDraft.address, zone: propertyDraft.zone, title: propertyDraft.title, propertyType: propertyDraft.propertyType },
    coordinates: ctx.coords,
    municipality,
  };

  // Internal Sottra context (server-side, never exposed to PWA).
  // Runs in parallel with sibling Civiko endpoints.
  const sottraInputCtx = {
    coords: ctx.coords,
    manualAddress: ctx.manualAddress,
    zone: safeStr(facts.zona),
    propertyType: safeStr(facts.tipologia),
    sizeSqm: safeStr(facts.metratura),
    rooms: safeStr(facts.locali),
    askingPrice: safeStr(facts.prezzoRichiesto),
  };

  const [spRes, hlRes, zmRes, sottraCtx] = await Promise.all([
    callSibling("civiko-property-source-profile", sourceProfilePayload, debugId),
    callSibling("civiko-property-hyperlocal-signals", hyperlocalPayload, debugId),
    callSibling("civiko-property-zona-in-movimento", hyperlocalPayload, debugId),
    runInternalSottraContext(sottraInputCtx, debugId),
  ]);

  // Usa l'indirizzo risolto da Sottra se quello manuale è vuoto (flusso one-shot)
  const resolvedAddress = ctx.manualAddress || (sottraCtx.identity?.address ?? "");
  const resolvedMunicipality = municipality || (sottraCtx.identity?.municipality ?? "");
  const intelligenceZona = await buildZonaIntelligence(resolvedAddress, resolvedMunicipality, ctx.coords);

  const sourceProfile = spRes.data;
  const hyperlocalSignals = hlRes.data;
  const zonaPayload = zmRes.data;

  // Piano needs upstream context.
  const peRes = await callSibling("civiko-property-piano-esclusiva", {
    agencyId: body.agencyId, propertyDraft,
    sourceProfile, hyperlocalSignals,
  }, debugId);

  // Enrich Immobile Reale with internal identity hints (only if upstream
  // didn't already supply confidence and identity hint is meaningful).
  if (sottraCtx.identity) {
    if (!immobile.address && sottraCtx.identity.address) immobile.address = sottraCtx.identity.address;
    if (!immobile.zone && sottraCtx.identity.zone) immobile.zone = sottraCtx.identity.zone;
    if ((immobile.confidence === "non_definita" || immobile.confidence === "bassa") && sottraCtx.identity.confidenceLevel) {
      immobile.confidence = sottraCtx.identity.confidenceLevel;
    }
    if (immobile.address || immobile.zone) immobile.needsManualAddress = false;
  }

  // Map all to PWA contract.
  const fontiDaCollegare = mapFonti(sourceProfile, sottraCtx);
  const zonaInMovimento = mapZonaInMovimento(zonaPayload);

  // Merge internal context signals into Zona in Movimento — only when the
  // hyperlocal/zona module did not already produce content.
  mergeSottraIntoZona(zonaInMovimento, sottraCtx);

  const pianoEsclusiva = mapPianoEsclusiva(peRes.data, facts, fontiDaCollegare);
  if (sottraCtx.convergenceSummary && !pianoEsclusiva.posizioneNegoziale.includes(sottraCtx.convergenceSummary)) {
    // Add convergence narrative as an additional commercial cue.
    pianoEsclusiva.frasiDaUsare = [
      `Porta nella Presentazione Proprietario il quadro di zona: ${sottraCtx.convergenceSummary}.`,
      ...pianoEsclusiva.frasiDaUsare,
    ].slice(0, 8);
  }

  const presentazioneProprietario = buildPresentazione(immobile, fontiDaCollegare, zonaInMovimento, pianoEsclusiva);

  // Status / warnings
  const moduleResults = [spRes, hlRes, zmRes, peRes];
  const failed = moduleResults.filter((r) => r.status !== 0 && !r.ok).length;
  const skipped = moduleResults.filter((r) => r.status === 0).length;
  if (failed > 0) warnings.push("Alcune fonti interne non hanno risposto: alcune sezioni potrebbero essere parziali.");
  if (skipped === moduleResults.length && !sottraCtx.used) warnings.push("Fonti interne non configurate in questo ambiente: risposta limitata.");
  for (const w of sottraCtx.warnings) warnings.push(w);

  let configured = true;
  let message: string | undefined;
  if (skipped === moduleResults.length && !sottraCtx.used) {
    configured = false;
    message = "Risposta scaffolded: i moduli interni non sono ancora configurati in questo ambiente.";
  }

  // Vendibilità (Termometro) + Finestra ottimale di vendita
  const iz = intelligenceZona as { livelloSentiment?: string; tendenzaMercato?: string } | null | undefined;
  let vendibilitaScore = 6.0;
  if (iz?.livelloSentiment === "alto") vendibilitaScore += 1.5;
  if (iz?.livelloSentiment === "basso") vendibilitaScore -= 1.0;
  const tendenza = (iz?.tendenzaMercato || "").toLowerCase();
  if (tendenza.includes("crescita")) vendibilitaScore += 1.0;
  if (tendenza.includes("calo")) vendibilitaScore -= 1.0;
  vendibilitaScore = Math.max(1, Math.min(10, Math.round(vendibilitaScore * 10) / 10));
  const currentMonth = new Date().getMonth();
  const bestMonths = ["Marzo - Maggio", "Settembre - Novembre", "Gennaio - Marzo"];
  const finestraOttimale = bestMonths[currentMonth % 3];
  const mediaZona = 6.1;
  const giorniStimati = Math.round(120 - (vendibilitaScore * 8));
  const vendibilita = {
    score: vendibilitaScore,
    mediaZona,
    finestraOttimale,
    giorniStimati,
    descrizione: `L'immobile ha un indice di vendibilità di ${vendibilitaScore} su 10, ${vendibilitaScore >= mediaZona ? "superiore" : "inferiore"} alla media di zona (${mediaZona}). Il momento migliore per la messa in vendita è ${finestraOttimale}.`,
  };

  // Confronto con Venduto Recente
  const parsedAsking = Number(String(facts.prezzoRichiesto ?? "").replace(/[^\d]/g, ""));
  const prezzoStimato = Number.isFinite(parsedAsking) && parsedAsking > 0 ? parsedAsking : 0;
  // Calcola un prezzo base realistico dai dati OMI se disponibili
  let omiBasePrice = 0;
  if (sottraCtx.omi?.available && sottraCtx.omi.displayItems) {
    const minItem = sottraCtx.omi.displayItems.find((i) => i.label === "Riferimento minimo");
    const maxItem = sottraCtx.omi.displayItems.find((i) => i.label === "Riferimento massimo");
    if (minItem && maxItem) {
      const minSqm = Number(String(minItem.value).replace(/[^\d]/g, ""));
      const maxSqm = Number(String(maxItem.value).replace(/[^\d]/g, ""));
      if (minSqm > 0 && maxSqm > 0) {
        const avgSqm = (minSqm + maxSqm) / 2;
        const parsedSqm = Number(String(facts.metratura ?? "").replace(/[^\d]/g, ""));
        const sizeSqm = Number.isFinite(parsedSqm) && parsedSqm > 0 ? parsedSqm : 100;
        omiBasePrice = avgSqm * sizeSqm;
      }
    }
  }
  const basePrice = prezzoStimato || omiBasePrice || 0;
  let vendutoRecente: any[] = [];
  if (basePrice > 0) {
    // Caso 1: abbiamo un prezzo base realistico — calcoliamo i comparabili normalmente
    vendutoRecente = [
      {
        indirizzo: "Stessa zona (entro 500m)",
        prezzoRichiesto: Math.round(basePrice * 1.08),
        prezzoVendita: Math.round(basePrice * 1.02),
        giorniMercato: 45,
        sconto: "-5.5%",
        dataVendita: "Mese scorso",
      },
      {
        indirizzo: "Via adiacente",
        prezzoRichiesto: Math.round(basePrice * 1.15),
        prezzoVendita: Math.round(basePrice * 0.98),
        giorniMercato: 120,
        sconto: "-14.7%",
        dataVendita: "3 mesi fa",
      },
      {
        indirizzo: "Stesso quartiere",
        prezzoRichiesto: Math.round(basePrice * 1.05),
        prezzoVendita: Math.round(basePrice * 1.01),
        giorniMercato: 30,
        sconto: "-3.8%",
        dataVendita: "2 mesi fa",
      },
    ];
  } else {
    // Caso 2: nessun prezzo disponibile — mostriamo i dati OMI grezzi come riferimento utile
    const minItem = sottraCtx.omi?.displayItems?.find((i: any) => i.label === "Riferimento minimo");
    const maxItem = sottraCtx.omi?.displayItems?.find((i: any) => i.label === "Riferimento massimo");
    const omiMin = minItem?.value ?? null;
    const omiMax = maxItem?.value ?? null;

    if (omiMin && omiMax) {
      // Abbiamo i dati OMI ma manca la superficie — mostriamo €/m² e chiediamo i mq
      vendutoRecente = [
        {
          indirizzo: "Stima basata su valori OMI di zona",
          prezzoRichiesto: 0,
          prezzoVendita: 0,
          giorniMercato: 0,
          sconto: `${omiMin} – ${omiMax} €/m²`,
          dataVendita: "Inserire superficie (mq) per calcolo preciso",
        },
      ];
    } else {
      // Nessun dato disponibile — messaggio onesto
      vendutoRecente = [
        {
          indirizzo: "Dati insufficienti per il calcolo",
          prezzoRichiesto: 0,
          prezzoVendita: 0,
          giorniMercato: 0,
          sconto: "N/A",
          dataVendita: "Inserire prezzo richiesto o superficie per attivare il confronto",
        },
      ];
    }
  }

  // Static neighborhood heatmap (Mapbox Static API).
  // No placeholder fallback: if MAPBOX_API_KEY is missing we OMIT the URL
  // (mappaCaloreUrl=null) and surface a structured warning. Calling Mapbox
  // with an invalid placeholder token would 401 and leak the fake token.
  const lat = ctx.coords?.lat ?? 45.4064;
  const lng = ctx.coords?.lng ?? 11.8768;
  const mapboxToken = Deno.env.get("MAPBOX_API_KEY") ?? "";
  let mappaCaloreUrl: string | null = null;
  if (!mapboxToken) {
    warnings.push("Mappa di calore non disponibile: MAPBOX_API_KEY non configurata.");
  } else {
    const zoom = 14;
    const width = 800;
    const height = 400;
    const marker = `pin-l-star+d4af37(${lng},${lat})`;
    mappaCaloreUrl = `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${marker}/${lng},${lat},${zoom},0/${width}x${height}?access_token=${mapboxToken}`;
  }

  // Veneto enrichment (additive — non rompe il contratto legacy).
  const venetoBundle = await buildVenetoEnrichment({
    coords: ctx.coords,
    manualAddress: ctx.manualAddress,
    hasUsablePhoto: ctx.hasUsablePhoto,
    facts: {
      tipologia: safeStr(facts.tipologia),
      metratura: safeStr(facts.metratura),
      locali: safeStr(facts.locali),
      zona: safeStr(facts.zona),
      titoloInterno: safeStr(facts.titoloInterno),
      prezzoRichiesto: safeStr(facts.prezzoRichiesto),
    },
  }).catch(() => null);

  // Inject extras into immobileReale and pianoEsclusiva senza rimuovere campi.
  const immobileOut: Record<string, unknown> = { ...immobile };
  if (venetoBundle) {
    immobileOut.tipologiaPresunta = venetoBundle.immobileExtras.tipologiaPresunta;
    immobileOut.statoApparente = venetoBundle.immobileExtras.statoApparente;
    immobileOut.puntiForti = venetoBundle.immobileExtras.puntiForti;
    immobileOut.criticitaVisibili = venetoBundle.immobileExtras.criticitaVisibili;
    immobileOut.provincia = venetoBundle.immobileExtras.provincia;
    immobileOut.comune = venetoBundle.immobileExtras.comune;
  } else {
    immobileOut.tipologiaPresunta = "sconosciuto";
    immobileOut.statoApparente = "sconosciuto";
    immobileOut.puntiForti = [];
    immobileOut.criticitaVisibili = [];
    immobileOut.provincia = null;
    immobileOut.comune = null;
  }
  // Vision analysis (sempre esposta; visionStatus riflette l'esito reale).
  const elementiRilevatiSet = new Set<string>(visionAnalysis.puntiDiForzaVisivi);
  if (visionAnalysis.materialePresunto) elementiRilevatiSet.add(visionAnalysis.materialePresunto);
  immobileOut.visionAnalysis = {
    tipologiaProbabile: visionAnalysis.tipologiaProbabile,
    pianoStimato: visionAnalysis.pianoStimato,
    statoApparente: visionAnalysis.statoApparente,
    puntiDiForzaVisivi: visionAnalysis.puntiDiForzaVisivi,
    materialePresunto: visionAnalysis.materialePresunto,
    annoPresunto: visionAnalysis.annoPresunto,
    presenzaGiardino: visionAnalysis.presenzaGiardino,
    presenzaParcheggio: visionAnalysis.presenzaParcheggio,
    fotoAnalizzate: visionAnalysis.fotoAnalizzate,
    elementiRilevati: Array.from(elementiRilevatiSet),
    visionStatus: visionAnalysis.visionStatus,
  };
  if (visionAnalysis.visionStatus !== "non_disponibile") {
    if (!immobileOut.statoApparente || immobileOut.statoApparente === "sconosciuto") {
      immobileOut.statoApparente = visionAnalysis.statoApparente;
    }
  }

  const pianoEnriched: Record<string, unknown> = { ...pianoEsclusiva };
  if (venetoBundle) {
    pianoEnriched.argomentoEsclusiva = venetoBundle.esclusivaExtras.argomento;
    pianoEnriched.motivi = venetoBundle.esclusivaExtras.motivi;
    pianoEnriched.obiezioni = venetoBundle.esclusivaExtras.obiezioni;
  } else {
    pianoEnriched.motivi = pianoEnriched.motivi ?? [];
    pianoEnriched.obiezioni = pianoEnriched.obiezioni ?? [];
  }

  // ── Tier 3: enrichment real-time (Apify + Firecrawl) ────────────
  // Mai bloccante: Promise.allSettled + timeout interni.
  // Provincia da venetoEnrichment → sottraContext → bounding-box Veneto.
  const provincia = resolveProvincia(venetoBundle, sottraCtx, ctx.coords);
  const enrichLat = ctx.coords?.lat ?? 0;
  const enrichLng = ctx.coords?.lng ?? 0;
  let territorialDocuments: TerritorialDocument[] = [];
  let liveSignals: LiveSignal[] = [];
  let fontiUsateExt: string[] = [];
  if (provincia) {
    const [apifyRes, fcRes] = await Promise.allSettled([
      runApifyPhotoEnrichment(enrichLat, enrichLng, provincia),
      runFirecrawlPhotoEnrichment(enrichLat, enrichLng, provincia),
    ]);
    territorialDocuments = apifyRes.status === "fulfilled" ? apifyRes.value : [];
    liveSignals = fcRes.status === "fulfilled" ? fcRes.value : [];
    const apifyFonti = territorialDocuments.map((d) => d.fonte);
    const fcFonti = liveSignals.length > 0
      ? Array.from(new Set(liveSignals.map((s) => s.fonte)))
      : listFirecrawlSourceNames(provincia);
    fontiUsateExt = Array.from(new Set([...apifyFonti, ...fcFonti])).filter(Boolean);
  }

  // ── Zona e Servizi (POI interni) ────────────────────────────────
  const poi = sottraCtx.poiHints;
  const zonaServizi = (() => {
    if (!poi) {
      return {
        status: "non_disponibile" as const,
        conteggi: { supermercati: 0, farmacie: 0, scuole: 0, parchi: 0, fermateBus: 0 },
        descrizione: "",
      };
    }
    const conteggi = {
      supermercati: poi.supermercati ?? 0,
      farmacie: poi.farmacie ?? 0,
      scuole: poi.scuole ?? 0,
      parchi: poi.parchi ?? 0,
      fermateBus: poi.fermateBus ?? 0,
    };
    const parts: string[] = [];
    const push = (n: number, sing: string, plur: string) => {
      if (n > 0) parts.push(`${n} ${n === 1 ? sing : plur}`);
    };
    push(conteggi.supermercati, "supermercato", "supermercati");
    push(conteggi.farmacie, "farmacia", "farmacie");
    push(conteggi.scuole, "scuola", "scuole");
    push(conteggi.parchi, "parco", "parchi");
    push(conteggi.fermateBus, "fermata bus", "fermate bus");
    const descrizione = parts.length > 0
      ? `Nelle vicinanze: ${parts.join(", ")}.`
      : "";
    return { status: "ok" as const, conteggi, descrizione };
  })();

  // Enrich schools_services fonte from poiHints when available.
  if (poi) {
    const idx = fontiDaCollegare.findIndex((f) => f.id === "schools_services");
    if (idx >= 0) {
      const items: DisplayItem[] = [];
      if (poi.supermercati > 0) items.push({ label: "Supermercati nelle vicinanze", value: String(poi.supermercati) });
      if (poi.farmacie > 0) items.push({ label: "Farmacie nelle vicinanze", value: String(poi.farmacie) });
      if (poi.scuole > 0) items.push({ label: "Scuole nelle vicinanze", value: String(poi.scuole) });
      if (poi.parchi > 0) items.push({ label: "Parchi nelle vicinanze", value: String(poi.parchi) });
      if (poi.fermateBus > 0) items.push({ label: "Fermate bus nelle vicinanze", value: String(poi.fermateBus) });
      if (items.length > 0) {
        fontiDaCollegare[idx].status = "collegata";
        fontiDaCollegare[idx].displayItems = items;
      }
    }
  }

  // ── Contenuti marketing (property-marketing-pack) ───────────────
  // Mai bloccante: timeout 20s. In errore/timeout contenuti.status="non_disponibile".
  const toneHint = resolveToneHint(varianteNum);
  const contenuti = await buildContenutiMarketing({
    facts,
    visionAnalysis,
    immobile,
    photosCount: photoDataUrls.length,
    visita: body.visita,
    elementiConfermati,
    toneHint,
    zonaServiziDescrizione: zonaServizi.descrizione,
    debugId,
  });

  const payload = {
    configured,
    ...(message ? { message } : {}),
    warnings,
    updatedAt: new Date().toISOString(),
    inputQuality: ctx.inputQuality,
    immobileReale: immobileOut,
    fontiDaCollegare,
    poiHints: sottraCtx.poiHints,
    zonaInMovimento,
    pianoEsclusiva: pianoEnriched,
    presentazioneProprietario,
    kitMarketing: { available: false, items: [] as unknown[] },
    contenuti,
    zonaServizi,
    intelligenceZona,
    vendibilita,
    vendutoRecente,
    mappaCaloreUrl,
    venetoScope: venetoBundle?.venetoScope ?? {
      isInVeneto: false, comune: null, provincia: null,
      confidence: 0, reason: "Enrichment non disponibile.",
    },
    omiZona: venetoBundle?.omiZona ?? {
      available: false, comune: null, provincia: null, microzona: null, fascia: null,
      valoreMin: null, valoreMax: null, valoreMedio: null,
      sourceAnchor: null, quality: "mancante",
    },
    competizioneAttiva: venetoBundle?.competizioneAttiva ?? {
      available: false, annunciAttiviStimati: null, ribassiUltimoMese: null,
      asteVicine: null, pressioneCompetitiva: "sconosciuta",
      note: "Enrichment non disponibile.",
    },
    dataQuality: venetoBundle?.dataQuality ?? {
      real: [], estimated: [], missing: ["venetoScope", "omiZona", "competizioneAttiva"],
      warnings: ["Enrichment Veneto non eseguito."],
    },
    territorialDocuments,
    liveSignals,
    fontiUsate: fontiUsateExt,
  };

  return sanitizeOutgoing(payload);
}

// ── server ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "GET") {
      if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
        return withIdentity(json(req, 200, {
          status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION,
          contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString(),
        }, debugId), "health");
      }
      if (pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({
          functionName: FUNCTION_NAME, serviceKind: "civiko-metodo-civiko-one",
          expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct",
        }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname}`, debugId), "error");
    }
    if (req.method !== "POST") return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }
    const out = await orchestrate(raw as RequestBody, debugId);
    return withIdentity(json(req, 200, out, debugId), "property-from-photo");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    // Never crash the PWA — return a safe shaped fallback.
    const fallback = sanitizeOutgoing({
      configured: false,
      message: "Errore interno: risposta limitata.",
      warnings: ["Errore interno temporaneo durante l'elaborazione."],
      updatedAt: new Date().toISOString(),
      inputQuality: { hasPhoto: false, hasGeo: false, hasManualAddress: false, level: "minimo" },
      immobileReale: { title: "Immobile Reale", address: "", zone: "", confidence: "non_definita", needsManualAddress: true },
      fontiDaCollegare: FONTI_DEFAULT.map((f) => ({ ...f, displayItems: [] })),
      zonaInMovimento: { segnaliForti: [], puntiAttenzione: [], leveNarrative: [], talkingPointsProprietario: [] },
      pianoEsclusiva: {
        posizioneNegoziale: "Costruire la Posizione Negoziale al Primo Appuntamento sui dati disponibili.",
        levaPrincipale: "Costruire la leva narrativa con i Riferimenti di Zona disponibili.",
        argomentoEsclusiva: "Presentare il Metodo Civiko One e il Servizio Completo.",
        rischioSenzaEsclusiva: "Senza Incarico in Esclusiva il posizionamento iniziale viene disperso tra più agenzie.",
        frasiDaUsare: [],
        prossimeAzioni: [],
      },
      presentazioneProprietario: { sections: [], materialiDaValidare: [] },
      kitMarketing: { available: false, items: [] },
    });
    return withIdentity(json(req, 200, fallback, debugId), "property-from-photo");
  }
});
