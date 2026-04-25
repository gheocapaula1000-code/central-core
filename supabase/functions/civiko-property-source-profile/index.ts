// ═══════════════════════════════════════════════════════════════
// Civiko One — Property Source Profile (Central Core V3)
// POST /civiko/property-source-profile
//
// Protected backend endpoint that returns a clean, source-aware
// profile of a property for the Civiko One PWA "Presentazione
// Proprietario". The PWA never sees datasets, secrets, formulas
// or processing logic — only the structured source-area output.
//
// Source areas:
//   1. Riferimenti OMI            (Agenzia delle Entrate / OMI)
//   2. Comune di Padova           (cartografia / PI)
//   3. Contesto di Quartiere      (Comune di Padova / ISTAT)
//   4. Dati Territoriali          (ISPRA / sismica regionale)
//   5. Verifiche Catastali        (documentazione agenzia)
//   6. Scuole e Servizi           (MIM)
//   7. Segnali di Zona            (fonti locali — futuro)
//
// HARD RULES enforced here:
//   - never invent values
//   - never expose secrets, datasets, internal logic
//   - never use forbidden user-facing words (AI / IA / smart /
//     intelligente / stima / perizia / valutazione ufficiale /
//     prezzo giusto / valore reale / garantito ...)
//   - sanitize ALL outgoing strings against the ban list
// ═══════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  makeDebugId,
  handleOptions,
  json,
  fail,
  CORE_VERSION,
  CORE_CONTRACT,
  addIdentityHeaders,
  buildManifest,
  enforceOriginPolicy,
} from "../_shared/http.ts";

// ── constants ─────────────────────────────────────────────────

const FUNCTION_NAME = "civiko-property-source-profile";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-source-profile";
const ALL_ROUTES = [
  "GET  /health",
  "GET  /manifest",
  "POST /civiko/property-source-profile",
];

const PADOVA_COMUNE_ISTAT_LONG = "5028060";
const PADOVA_COMUNE_ISTAT_SHORT = "028060";
const PADOVA_COMUNE_DESCR = "PADOVA";

// ── forbidden user-facing vocabulary (hard sanitizer) ─────────
// Only enforced on outgoing copy strings. Internal logs/keys are
// untouched. Matches whole words case-insensitively.
const FORBIDDEN_WORDS = [
  "ai", "ia",
  "intelligenza", "intelligence",
  "machine learning",
  "smart",
  "intelligent", "intelligente",
  "stima",
  "perizia",
  "valutazione ufficiale", "valutazioni ufficiali",
  "prezzo giusto", "prezzo corretto",
  "valore reale",
  "garantito", "garantita",
];

// Compiled once. \b doesn't work well with non-ASCII, so we use
// lookarounds on letter classes.
const FORBIDDEN_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    FORBIDDEN_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![\\p{L}\\p{N}])",
  "giu",
);

function sanitizeCopy(value: string): string {
  if (!value) return value;
  return value.replace(FORBIDDEN_RE, "").replace(/\s{2,}/g, " ").trim();
}

/** Recursively sanitize every string in a JSON-like value. */
function sanitizeOutgoing<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeCopy(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeOutgoing) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeOutgoing(v);
    }
    return out as unknown as T;
  }
  return value;
}

// ── types ─────────────────────────────────────────────────────

type SourceAreaId =
  | "omi"
  | "padova_municipality"
  | "neighborhood_context"
  | "territorial_data"
  | "cadastral_checks"
  | "schools_services"
  | "zone_signals";

type SourceStatus =
  | "da_collegare"
  | "da_consultare"
  | "collegata"
  | "da_rivedere"
  | "non_disponibile";

interface PropertyDraft {
  title?: string;
  address?: string;
  zone?: string;
  propertyType?: string;
  sizeSqm?: number | string;
  rooms?: number | string;
  floor?: string;
  hasElevator?: boolean;
  hasGarage?: boolean;
  hasTerrace?: boolean;
  hasGarden?: boolean;
  condition?: string;
  askingPrice?: number | string;
  energyClass?: string;
  internalNotes?: string;
  ownerGoal?: string;
  ownerTiming?: string;
  ownerPriority?: string;
  strengths?: string;
  knownIssues?: string;
  ownerQuestions?: string;
}

interface RequestBody {
  agencyId?: string;
  propertyDraft?: PropertyDraft;
  requestedSourceAreas?: SourceAreaId[];
}

interface SourceArea {
  id: SourceAreaId;
  title: string;
  label: string;
  status: SourceStatus;
  sourceOwner: string;
  purpose: string;
  summary: string;
  displayItems: Array<{ label: string; value: string }>;
  lastCheckedAt: string | null;
  notes: string[];
}

interface PresentationHint {
  title: string;
  body: string;
  section:
    | "Presentazione Proprietario"
    | "Dossier Venditore"
    | "Fonti da Collegare"
    | "Piano di Valorizzazione";
}

interface ProfileResponse {
  profileId: string;
  status: "ok" | "partial" | "unavailable";
  propertySummary: {
    title: string;
    address: string;
    zone: string;
    propertyType: string;
    displayLabel: "Immobile Reale";
  };
  sourceAreas: SourceArea[];
  presentationHints: PresentationHint[];
  warnings: string[];
  updatedAt: string;
}

// ── helpers ───────────────────────────────────────────────────

const STATUS_TO_LABEL: Record<SourceStatus, string> = {
  da_collegare: "Fonte da Collegare",
  da_consultare: "Verifica di Supporto",
  collegata: "Collegata",
  da_rivedere: "Da Rivedere",
  non_disponibile: "Non Disponibile",
};

const ALL_AREAS: SourceAreaId[] = [
  "omi",
  "padova_municipality",
  "neighborhood_context",
  "territorial_data",
  "cadastral_checks",
  "schools_services",
  "zone_signals",
];

function safeStr(v: unknown, fallback = ""): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v.trim();
  return String(v);
}

function getSupabase(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key);
}

function isPadovaAddress(address: string, zone: string): boolean {
  const hay = `${address} ${zone}`.toLowerCase();
  return /\bpadova\b/.test(hay);
}

// ── area builders ─────────────────────────────────────────────

function emptyArea(id: SourceAreaId): SourceArea {
  const meta = AREA_META[id];
  return {
    id,
    title: meta.title,
    label: STATUS_TO_LABEL["da_collegare"],
    status: "da_collegare",
    sourceOwner: meta.sourceOwner,
    purpose: meta.purpose,
    summary: meta.defaultSummary,
    displayItems: [],
    lastCheckedAt: null,
    notes: [],
  };
}

const AREA_META: Record<SourceAreaId, {
  title: string;
  sourceOwner: string;
  purpose: string;
  defaultSummary: string;
}> = {
  omi: {
    title: "Riferimenti OMI",
    sourceOwner: "Agenzia delle Entrate",
    purpose: "Riferimenti di Mercato e zona OMI quando disponibili.",
    defaultSummary: "Fonte da collegare per i Riferimenti di Mercato della zona.",
  },
  padova_municipality: {
    title: "Comune di Padova",
    sourceOwner: "Comune di Padova",
    purpose: "Cartografia comunale, Piano degli Interventi ed Elementi di Zona.",
    defaultSummary: "Fonte comunale da collegare per gli Elementi di Zona.",
  },
  neighborhood_context: {
    title: "Contesto di Quartiere",
    sourceOwner: "Comune di Padova / ISTAT",
    purpose: "Quadro territoriale e dati di contesto quando disponibili.",
    defaultSummary: "Quadro di contesto del quartiere da collegare.",
  },
  territorial_data: {
    title: "Dati Territoriali",
    sourceOwner: "Fonti territoriali regionali / ISPRA where available",
    purpose: "Elementi territoriali utili alla pratica.",
    defaultSummary: "Verifica di Supporto Territoriale da preparare.",
  },
  cadastral_checks: {
    title: "Verifiche Catastali",
    sourceOwner: "Documentazione Agenzia / Fonti catastali",
    purpose: "Documenti, riferimenti e controlli disponibili per la pratica.",
    defaultSummary: "Documenti catastali da raccogliere e verificare con l'agenzia.",
  },
  schools_services: {
    title: "Scuole e Servizi",
    sourceOwner: "MIM / Fonti disponibili / Dati interni disponibili",
    purpose: "Elementi di Zona utili alla Presentazione Proprietario.",
    defaultSummary: "Elementi di Zona da collegare per scuole e servizi.",
  },
  zone_signals: {
    title: "Segnali di Zona",
    sourceOwner: "Fonti Locali da Collegare",
    purpose: "Temi ricorrenti e segnali pubblici utili per preparare l'Appuntamento Venditore.",
    defaultSummary: "Segnali di Zona da collegare in una fase successiva.",
  },
};

// ── area resolvers (real data, honest statuses) ───────────────

async function resolveOmi(
  sb: SupabaseClient | null,
  draft: PropertyDraft,
  isPadova: boolean,
): Promise<SourceArea> {
  const area = emptyArea("omi");
  if (!sb) {
    area.notes.push("Fonte dati non configurata in questo ambiente.");
    return area;
  }
  if (!isPadova) {
    area.status = "non_disponibile";
    area.label = STATUS_TO_LABEL["non_disponibile"];
    area.summary = "Riferimenti OMI disponibili solo per immobili in Padova nel pilot V1.";
    return area;
  }

  // Probe OMI valori for Padova — return only safe metadata, no euro values.
  try {
    const { data, error } = await sb
      .from("omi_valori")
      .select("link_zona, zona, descr_tipologia, semestre, fascia, comune_descrizione")
      .or(`comune_istat.eq.${PADOVA_COMUNE_ISTAT_LONG},comune_istat.eq.${PADOVA_COMUNE_ISTAT_SHORT}`)
      .limit(50);

    if (error || !data || data.length === 0) {
      area.notes.push("Tabella riferimenti non popolata per il comune di Padova.");
      return area;
    }

    const zones = new Set<string>();
    const tipologie = new Set<string>();
    let semestre: string | null = null;
    for (const row of data) {
      if (row.zona) zones.add(String(row.zona));
      if (row.descr_tipologia) tipologie.add(String(row.descr_tipologia));
      if (!semestre && row.semestre) semestre = String(row.semestre);
    }

    area.status = "collegata";
    area.label = STATUS_TO_LABEL["collegata"];
    area.lastCheckedAt = new Date().toISOString();
    area.summary = "Riferimenti di Mercato della zona OMI di Padova disponibili come supporto alla pratica.";
    area.displayItems = [
      { label: "Comune", value: "Padova" },
      { label: "Semestre", value: semestre ?? "—" },
      { label: "Zone OMI Disponibili", value: String(zones.size) },
      { label: "Tipologie Coperte", value: String(tipologie.size) },
      { label: "Stato Fonte", value: "Collegata" },
    ];

    if (!draft.zone) {
      area.notes.push("Indicare la zona consente un riscontro più preciso dei Riferimenti di Mercato.");
    }
    return area;
  } catch {
    area.status = "da_rivedere";
    area.label = STATUS_TO_LABEL["da_rivedere"];
    area.notes.push("Riscontro non completato — riprovare più tardi.");
    return area;
  }
}

async function resolveNeighborhoodContext(
  sb: SupabaseClient | null,
  isPadova: boolean,
): Promise<SourceArea> {
  const area = emptyArea("neighborhood_context");
  if (!sb || !isPadova) return area;

  try {
    const { data, error } = await sb
      .from("istat_comuni")
      .select("popolazione, eta_media, percentuale_under35, percentuale_over65, anno")
      .or(`codice_istat.eq.${PADOVA_COMUNE_ISTAT_LONG},codice_istat.eq.${PADOVA_COMUNE_ISTAT_SHORT}`)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      area.notes.push("Dati di contesto non disponibili in questo momento.");
      return area;
    }

    area.status = "collegata";
    area.label = STATUS_TO_LABEL["collegata"];
    area.lastCheckedAt = new Date().toISOString();
    area.summary = "Quadro di contesto del Comune di Padova disponibile come supporto alla pratica.";
    area.displayItems = [
      { label: "Comune", value: "Padova" },
      { label: "Popolazione", value: data.popolazione != null ? String(data.popolazione) : "—" },
      { label: "Età Media", value: data.eta_media != null ? String(data.eta_media) : "—" },
      { label: "Quota Under 35", value: data.percentuale_under35 != null ? `${data.percentuale_under35}%` : "—" },
      { label: "Quota Over 65", value: data.percentuale_over65 != null ? `${data.percentuale_over65}%` : "—" },
      { label: "Periodo", value: data.anno != null ? String(data.anno) : "—" },
      { label: "Fonte", value: "ISTAT" },
    ];
    return area;
  } catch {
    area.status = "da_rivedere";
    area.label = STATUS_TO_LABEL["da_rivedere"];
    area.notes.push("Riscontro non completato — riprovare più tardi.");
    return area;
  }
}

async function resolveTerritorialData(
  sb: SupabaseClient | null,
  isPadova: boolean,
): Promise<SourceArea> {
  const area = emptyArea("territorial_data");
  if (!sb || !isPadova) return area;

  try {
    const [{ data: ispra }, { data: sismica }] = await Promise.all([
      sb.from("ispra_rischio")
        .select("frana_p3_perc, frana_p4_perc, idro_p3_perc, idro_p2_perc")
        .or(`codice_istat.eq.${PADOVA_COMUNE_ISTAT_LONG},codice_istat.eq.${PADOVA_COMUNE_ISTAT_SHORT}`)
        .limit(1)
        .maybeSingle(),
      sb.from("classificazione_sismica")
        .select("zona_sismica")
        .or(`codice_istat.eq.${PADOVA_COMUNE_ISTAT_LONG},codice_istat.eq.${PADOVA_COMUNE_ISTAT_SHORT}`)
        .limit(1)
        .maybeSingle(),
    ]);

    const items: Array<{ label: string; value: string }> = [
      { label: "Comune", value: "Padova" },
    ];
    let collegata = false;

    if (ispra) {
      collegata = true;
      items.push(
        { label: "Indicatore Idrogeologico (P2)", value: ispra.idro_p2_perc != null ? `${ispra.idro_p2_perc}%` : "—" },
        { label: "Indicatore Idrogeologico (P3)", value: ispra.idro_p3_perc != null ? `${ispra.idro_p3_perc}%` : "—" },
        { label: "Indicatore Frana (P3)", value: ispra.frana_p3_perc != null ? `${ispra.frana_p3_perc}%` : "—" },
        { label: "Fonte Territoriale", value: "ISPRA" },
      );
    }
    if (sismica?.zona_sismica != null) {
      collegata = true;
      items.push({ label: "Classificazione Sismica", value: `Zona ${sismica.zona_sismica}` });
    }

    if (!collegata) {
      area.notes.push("Verifica di Supporto Territoriale non disponibile in questo momento.");
      return area;
    }

    area.status = "collegata";
    area.label = STATUS_TO_LABEL["collegata"];
    area.summary = "Verifica di Supporto Territoriale disponibile come riferimento per la pratica.";
    area.displayItems = items;
    area.lastCheckedAt = new Date().toISOString();
    return area;
  } catch {
    area.status = "da_rivedere";
    area.label = STATUS_TO_LABEL["da_rivedere"];
    area.notes.push("Riscontro non completato — riprovare più tardi.");
    return area;
  }
}

function resolvePadovaMunicipality(isPadova: boolean): SourceArea {
  const area = emptyArea("padova_municipality");
  if (!isPadova) {
    area.status = "non_disponibile";
    area.label = STATUS_TO_LABEL["non_disponibile"];
    area.summary = "Fonte comunale prevista solo per immobili in Padova nel pilot V1.";
    return area;
  }
  area.status = "da_consultare";
  area.label = STATUS_TO_LABEL["da_consultare"];
  area.summary = "Cartografia comunale ed Elementi di Zona da consultare presso il Comune di Padova.";
  area.notes.push("Verifica di Supporto sul Piano degli Interventi consigliata prima dell'incarico.");
  return area;
}

function resolveCadastralChecks(draft: PropertyDraft): SourceArea {
  const area = emptyArea("cadastral_checks");
  area.status = "da_consultare";
  area.label = STATUS_TO_LABEL["da_consultare"];
  area.summary = "Documenti e riferimenti catastali da raccogliere e verificare con l'agenzia.";
  const items: Array<{ label: string; value: string }> = [];
  if (draft.address) items.push({ label: "Indirizzo Inserito", value: draft.address });
  if (draft.energyClass) items.push({ label: "Classe Energetica Inserita", value: String(draft.energyClass) });
  area.displayItems = items;
  area.notes.push("Documentazione catastale e di conformità non risulta automaticamente verificata.");
  return area;
}

async function resolveSchoolsServices(
  sb: SupabaseClient | null,
  isPadova: boolean,
): Promise<SourceArea> {
  const area = emptyArea("schools_services");
  if (!sb || !isPadova) return area;

  // No reliable per-property coordinates yet → comune-level signal only.
  try {
    const { count, error } = await sb
      .from("mim_schools")
      .select("*", { count: "exact", head: true })
      .or(`codice_istat.eq.${PADOVA_COMUNE_ISTAT_LONG},codice_istat.eq.${PADOVA_COMUNE_ISTAT_SHORT}`);

    if (error || count == null || count === 0) {
      area.notes.push("Riscontri di prossimità non disponibili senza coordinate puntuali.");
      return area;
    }

    area.status = "da_rivedere";
    area.label = STATUS_TO_LABEL["da_rivedere"];
    area.summary = "Elementi di Zona disponibili a livello comunale; riscontro puntuale richiede coordinate.";
    area.displayItems = [
      { label: "Comune", value: "Padova" },
      { label: "Strutture Scolastiche Censite (Comune)", value: String(count) },
      { label: "Fonte", value: "MIM" },
    ];
    area.lastCheckedAt = new Date().toISOString();
    area.notes.push("Per riscontri puntuali serve la geolocalizzazione dell'immobile.");
    return area;
  } catch {
    area.status = "da_rivedere";
    area.notes.push("Riscontro non completato — riprovare più tardi.");
    return area;
  }
}

function resolveZoneSignals(): SourceArea {
  const area = emptyArea("zone_signals");
  // Future area: explicitly da_collegare; never call external services here.
  area.summary = "Segnali di Zona pubblici previsti come Verifica di Supporto futura.";
  area.notes.push("Modulo non attivo nel pilot V1.");
  return area;
}

// ── presentation hints ────────────────────────────────────────

function buildHints(draft: PropertyDraft, areas: SourceArea[]): PresentationHint[] {
  const hints: PresentationHint[] = [];

  hints.push({
    title: "Presentazione Proprietario",
    body: "Aprire l'Appuntamento Venditore con i Dati Inseriti dall'Agenzia e gli Elementi di Zona disponibili come supporto.",
    section: "Presentazione Proprietario",
  });

  const collegate = areas.filter((a) => a.status === "collegata").map((a) => a.title);
  if (collegate.length > 0) {
    hints.push({
      title: "Verifiche di Supporto Disponibili",
      body: `Riferimenti utili già collegati: ${collegate.join(", ")}.`,
      section: "Dossier Venditore",
    });
  }

  const daCollegare = areas.filter((a) => a.status === "da_collegare" || a.status === "da_consultare").map((a) => a.title);
  if (daCollegare.length > 0) {
    hints.push({
      title: "Fonti da Collegare",
      body: `Da preparare prima dell'Incarico in Esclusiva: ${daCollegare.join(", ")}.`,
      section: "Fonti da Collegare",
    });
  }

  if (draft.strengths || draft.knownIssues) {
    hints.push({
      title: "Piano di Valorizzazione",
      body: "Strutturare il Piano di Valorizzazione partendo dai Punti di Forza inseriti dall'agenzia e dagli aspetti da gestire con il proprietario.",
      section: "Piano di Valorizzazione",
    });
  }

  return hints;
}

// ── core handler ──────────────────────────────────────────────

async function buildProfile(body: RequestBody, debugId: string): Promise<ProfileResponse> {
  const draft = body.propertyDraft ?? {};
  const requested = (body.requestedSourceAreas && body.requestedSourceAreas.length > 0)
    ? body.requestedSourceAreas
    : ALL_AREAS;

  const address = safeStr(draft.address);
  const zone = safeStr(draft.zone);
  const isPadova = isPadovaAddress(address, zone);

  const sb = getSupabase();
  const warnings: string[] = [];

  if (!address) warnings.push("Indirizzo non fornito: alcuni riscontri restano da collegare.");
  if (!sb) warnings.push("Fonti interne non configurate: risposta limitata.");

  // Resolve every requested area defensively.
  const resolvers: Record<SourceAreaId, () => Promise<SourceArea> | SourceArea> = {
    omi: () => resolveOmi(sb, draft, isPadova),
    padova_municipality: () => resolvePadovaMunicipality(isPadova),
    neighborhood_context: () => resolveNeighborhoodContext(sb, isPadova),
    territorial_data: () => resolveTerritorialData(sb, isPadova),
    cadastral_checks: () => resolveCadastralChecks(draft),
    schools_services: () => resolveSchoolsServices(sb, isPadova),
    zone_signals: () => resolveZoneSignals(),
  };

  const areas: SourceArea[] = [];
  for (const id of ALL_AREAS) {
    if (!requested.includes(id)) continue;
    try {
      const r = await resolvers[id]();
      areas.push(r);
    } catch (err) {
      console.error(`[civiko-profile] area=${id} failed debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
      const fallback = emptyArea(id);
      fallback.status = "da_rivedere";
      fallback.label = STATUS_TO_LABEL["da_rivedere"];
      fallback.notes.push("Riscontro non completato in questa sessione.");
      areas.push(fallback);
    }
  }

  // Overall status
  let status: ProfileResponse["status"] = "ok";
  const hasCollegata = areas.some((a) => a.status === "collegata");
  const allUnavailable = areas.every((a) => a.status === "non_disponibile");
  if (allUnavailable) status = "unavailable";
  else if (!hasCollegata || warnings.length > 0 || areas.some((a) => a.status === "da_rivedere")) status = "partial";

  const profile: ProfileResponse = {
    profileId: debugId,
    status,
    propertySummary: {
      title: safeStr(draft.title) || "Immobile Reale",
      address: address || "",
      zone: zone || "",
      propertyType: safeStr(draft.propertyType) || "",
      displayLabel: "Immobile Reale",
    },
    sourceAreas: areas,
    presentationHints: buildHints(draft, areas),
    warnings,
    updatedAt: new Date().toISOString(),
  };

  return sanitizeOutgoing(profile);
}

// ── routing ───────────────────────────────────────────────────

function withIdentity(res: Response, route: string): Response {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function handleHealth(req: Request, debugId: string): Response {
  return withIdentity(
    json(req, 200, {
      status: "healthy",
      function: FUNCTION_NAME,
      version: CORE_VERSION,
      contract: CORE_CONTRACT,
      expectedBasePath: EXPECTED_BASE_PATH,
      time: new Date().toISOString(),
    }, debugId),
    "health",
  );
}

function handleManifest(req: Request, debugId: string): Response {
  const manifest = buildManifest({
    functionName: FUNCTION_NAME,
    serviceKind: "civiko-source-profile",
    expectedBasePath: EXPECTED_BASE_PATH,
    routes: ALL_ROUTES,
    callingMode: "direct",
  });
  return withIdentity(json(req, 200, manifest, debugId), "manifest");
}

function isProfileRoute(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "");
  return (
    p.endsWith("/civiko/property-source-profile") ||
    p.endsWith("/property-source-profile") ||
    p.endsWith("/civiko-property-source-profile") ||
    p === EXPECTED_BASE_PATH ||
    p === "" ||
    p === "/"
  );
}

function validateBody(raw: unknown): { ok: true; body: RequestBody } | { ok: false; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  if (b.propertyDraft != null && (typeof b.propertyDraft !== "object" || Array.isArray(b.propertyDraft))) {
    return { ok: false, message: "propertyDraft must be an object." };
  }
  if (b.requestedSourceAreas != null && !Array.isArray(b.requestedSourceAreas)) {
    return { ok: false, message: "requestedSourceAreas must be an array." };
  }
  if (Array.isArray(b.requestedSourceAreas)) {
    for (const a of b.requestedSourceAreas) {
      if (typeof a !== "string" || !ALL_AREAS.includes(a as SourceAreaId)) {
        return { ok: false, message: `Unknown source area: ${String(a)}` };
      }
    }
  }
  return { ok: true, body: b as RequestBody };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const debugId = makeDebugId();
  const pathname = new URL(req.url).pathname;
  console.log(`[civiko-profile] method=${req.method} pathname=${pathname} debug_id=${debugId}`);

  try {
    const originBlock = enforceOriginPolicy(req, debugId);
    if (originBlock) return withIdentity(originBlock, "origin-blocked");

    if (req.method === "GET") {
      if (pathname.endsWith("/health") || pathname === "/" || pathname === EXPECTED_BASE_PATH) {
        return handleHealth(req, debugId);
      }
      if (pathname.endsWith("/manifest")) {
        return handleManifest(req, debugId);
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${pathname} not found`, debugId), "error");
    }

    if (req.method !== "POST") {
      return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");
    }

    if (!isProfileRoute(pathname)) {
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `POST ${pathname} not found`, debugId), "error");
    }

    // NOTE (internal TODO): wire per-app secret / verified JWT once
    // Civiko One client integration is finalized. For now the endpoint
    // is gated by origin policy + CORS allowlist only. Do not surface
    // this note to the user-facing payload.
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error");
    }

    const v = validateBody(raw);
    if (!v.ok) {
      return withIdentity(fail(req, 400, "INVALID_BODY", v.message, debugId), "error");
    }

    const profile = await buildProfile(v.body, debugId);
    return withIdentity(json(req, 200, profile, debugId), "property-source-profile");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[civiko-profile] Error debug_id=${debugId}: ${errMsg}`);
    return withIdentity(
      json(req, 500, {
        error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` },
        debug_id: debugId,
      }, debugId),
      "error",
    );
  }
});
