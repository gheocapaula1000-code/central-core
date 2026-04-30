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

interface PwaPhoto {
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  sizeKb?: number;
}
interface PwaGeo {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  manualAddress?: string;
  source?: "device" | "manual" | "missing";
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
interface RequestBody {
  agencyId?: string;
  photo?: PwaPhoto;
  geo?: PwaGeo;
  quickFacts?: PwaQuickFacts;
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

async function orchestrate(body: RequestBody, debugId: string) {
  const ctx = evaluateInput(body);
  const facts = body.quickFacts ?? {};
  const immobile = buildImmobileReale(body, ctx);
  const warnings = [...ctx.warnings];

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

  const payload = {
    configured,
    ...(message ? { message } : {}),
    warnings,
    updatedAt: new Date().toISOString(),
    inputQuality: ctx.inputQuality,
    immobileReale: immobile,
    fontiDaCollegare,
    poiHints: sottraCtx.poiHints,
    zonaInMovimento,
    pianoEsclusiva,
    presentazioneProprietario,
    kitMarketing: { available: false, items: [] as unknown[] },
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
