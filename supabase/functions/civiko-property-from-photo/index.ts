// ═══════════════════════════════════════════════════════════════
// Civiko One — Metodo Sottra: Foto + Geolocalizzazione → Piano Esclusiva
//
// POST /civiko/property-from-photo
// Alias: POST /civiko/metodo-civiko-one
//
// Orchestrates the existing Civiko One endpoints server-side:
//   - civiko-property-source-profile
//   - civiko-property-hyperlocal-signals
//   - civiko-property-zona-in-movimento
//   - civiko-property-piano-esclusiva
//   - civiko-property-owner-report
//
// HARD RULES:
//   - Photo never persisted by default.
//   - Photo binary never echoed back.
//   - Forbidden vocabulary stripped from every outgoing string.
//   - All facts come from already-validated Civiko endpoints.
//   - No Stripe secret leakage; if billing not configured, returns
//     billingGate.billingReady=false but still serves the response.
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import {
  sanitizeOutgoing, isPadovaMunicipality, isPadovaText, isPadovaCoord,
} from "../_shared/civiko.ts";
import { evaluateBillingGate, recordUsage, readStripeEnv } from "../_shared/billing.ts";

const FUNCTION_NAME = "civiko-property-from-photo";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-from-photo";
const ROUTES = [
  "GET  /health",
  "GET  /manifest",
  "POST /civiko/property-from-photo",
  "POST /civiko/metodo-civiko-one",
];

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB

interface CapturePayload {
  photoBase64?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  capturedAt?: string;
  device?: string;
}
interface GeoPayload {
  lat?: number;
  lng?: number;
  accuracyMeters?: number;
  source?: "gps" | "manual" | "exif" | "unknown";
}
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
  mainObjection?: string;
  targetBuyer?: string;
}
interface RequestBody {
  agencyId?: string;
  capture?: CapturePayload;
  geo?: GeoPayload;
  propertyDraft?: PropertyDraft;
  requestedOutputs?: string[];
}

const DEFAULT_OUTPUTS = [
  "source_profile",
  "hyperlocal_signals",
  "zona_in_movimento",
  "piano_esclusiva",
  "owner_report",
];

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

// ── input validation ──────────────────────────────────────────

interface ValidationOutcome {
  inputQuality: {
    photoAccepted: boolean;
    geoAccepted: boolean;
    geoAccuracyMeters: number | null;
    needsManualAddress: boolean;
    needsBetterPhoto: boolean;
    needsLocation: boolean;
    notes: string[];
  };
  warnings: string[];
}

function validateInputs(body: RequestBody): ValidationOutcome {
  const notes: string[] = [];
  const warnings: string[] = [];
  const cap = body.capture ?? {};
  const geo = body.geo ?? {};
  const draft = body.propertyDraft ?? {};

  let photoAccepted = false;
  let needsBetterPhoto = false;
  if (cap.photoBase64 && typeof cap.photoBase64 === "string" && cap.photoBase64.length > 200) {
    const approxBytes = cap.fileSizeBytes ?? Math.floor(cap.photoBase64.length * 0.75);
    if (approxBytes > MAX_PHOTO_BYTES) {
      needsBetterPhoto = true;
      notes.push("La foto supera la dimensione consentita: caricarne una più leggera.");
    } else if (cap.mimeType && !["image/jpeg", "image/webp", "image/png"].includes(cap.mimeType)) {
      needsBetterPhoto = true;
      notes.push("Formato foto non supportato: usare JPG, PNG o WebP.");
    } else {
      photoAccepted = true;
    }
  } else {
    needsBetterPhoto = true;
    notes.push("Nessuna foto fornita: il contesto verrà costruito solo sui dati inseriti.");
  }

  let geoAccepted = false;
  let needsLocation = false;
  let geoAccuracyMeters: number | null = null;
  if (typeof geo.lat === "number" && typeof geo.lng === "number" &&
      Math.abs(geo.lat) <= 90 && Math.abs(geo.lng) <= 180) {
    geoAccepted = true;
    geoAccuracyMeters = typeof geo.accuracyMeters === "number" ? geo.accuracyMeters : null;
    if (geoAccuracyMeters != null && geoAccuracyMeters > 200) {
      notes.push("Precisione della posizione bassa: l'identificazione potrebbe richiedere conferma manuale.");
    }
  } else {
    needsLocation = true;
    notes.push("Geolocalizzazione mancante: usare un indirizzo manuale per consentire l'identificazione.");
  }

  const needsManualAddress = !geoAccepted && !draft.address;

  // Cross-check Padova
  const isPadova =
    isPadovaMunicipality(draft.zone || draft.address || "") ||
    isPadovaText(draft.address, draft.zone) ||
    (geoAccepted && isPadovaCoord(geo.lat, geo.lng));
  if (!isPadova) {
    warnings.push("Pilot V1 limitato al Comune di Padova: il contesto sarà incompleto fuori area.");
  }

  return {
    inputQuality: {
      photoAccepted, geoAccepted, geoAccuracyMeters,
      needsManualAddress, needsBetterPhoto, needsLocation, notes,
    },
    warnings,
  };
}

// ── internal HTTP fan-out to sibling Civiko functions ─────────

function projectBaseUrl(): string | null {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return null;
  return `${url.replace(/\/$/, "")}/functions/v1`;
}

async function callSibling(
  fnName: string,
  payload: unknown,
  debugId: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
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
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    if (!res.ok) {
      console.warn(`[${FUNCTION_NAME}] sibling ${fnName} status=${res.status} debug_id=${debugId}`);
    }
    return { ok: res.ok, status: res.status, data: parsed };
  } catch (e) {
    console.error(`[${FUNCTION_NAME}] sibling ${fnName} fetch failed: ${e instanceof Error ? e.message : String(e)} debug_id=${debugId}`);
    return { ok: false, status: 0, data: null };
  }
}

// Civiko sibling endpoints return the payload as the response body
// directly (no { ok, data } envelope). The wire format is whatever
// `json(req, 200, payload, debugId)` writes, which IS the payload.
function unwrap(d: unknown): Record<string, unknown> | null {
  if (d == null || typeof d !== "object") return null;
  return d as Record<string, unknown>;
}

// ── identity assembly ────────────────────────────────────────-

function buildIdentity(body: RequestBody, vq: ValidationOutcome) {
  const draft = body.propertyDraft ?? {};
  const geo = body.geo ?? {};
  const isPadova =
    isPadovaMunicipality(draft.zone || draft.address || "") ||
    isPadovaText(draft.address, draft.zone) ||
    (vq.inputQuality.geoAccepted && isPadovaCoord(geo.lat, geo.lng));

  let confidence: "high" | "medium" | "low" = "low";
  if (vq.inputQuality.geoAccepted && draft.address) confidence = "high";
  else if (vq.inputQuality.geoAccepted || draft.address) confidence = "medium";

  let source: "gps" | "photo_context" | "manual" | "mixed" = "manual";
  if (vq.inputQuality.geoAccepted && draft.address) source = "mixed";
  else if (vq.inputQuality.geoAccepted) source = "gps";
  else if (vq.inputQuality.photoAccepted) source = "photo_context";

  return {
    title: draft.title ?? "Immobile Reale",
    address: draft.address ?? "",
    zone: draft.zone ?? "",
    municipality: isPadova ? "Padova" : (draft.zone ?? ""),
    lat: vq.inputQuality.geoAccepted ? (geo.lat ?? null) : null,
    lng: vq.inputQuality.geoAccepted ? (geo.lng ?? null) : null,
    confidence,
    source,
  };
}

// ── main orchestration ────────────────────────────────────────

async function orchestrate(body: RequestBody, debugId: string) {
  const validation = validateInputs(body);
  const identity = buildIdentity(body, validation);
  const requested = new Set(body.requestedOutputs && body.requestedOutputs.length ? body.requestedOutputs : DEFAULT_OUTPUTS);

  const draft = body.propertyDraft ?? {};
  const coords = validation.inputQuality.geoAccepted
    ? { lat: body.geo!.lat!, lng: body.geo!.lng! }
    : null;
  const municipality = identity.municipality;

  // Billing gate: scan-level
  const gate = await evaluateBillingGate(body.agencyId ?? null, "scan");
  if (gate.billingReady && !gate.allowed) {
    return sanitizeOutgoing({
      runId: debugId,
      status: "unavailable",
      inputQuality: validation.inputQuality,
      propertyIdentity: identity,
      sourceProfile: null,
      hyperlocalSignals: null,
      zonaInMovimento: null,
      pianoEsclusiva: null,
      ownerReport: null,
      materialsToValidate: [],
      billingGate: {
        allowed: false, billingReady: true, plan: gate.plan, status: gate.status,
        usage: gate.usage, limits: gate.limits,
        upgradeRequired: gate.upgradeRequired, reason: gate.reason,
      },
      warnings: validation.warnings.concat(["Limite del piano raggiunto: aggiornare l'abbonamento per continuare."]),
      updatedAt: new Date().toISOString(),
    });
  }

  // Fan out — independent calls in parallel
  const sourceProfilePayload = { agencyId: body.agencyId, propertyDraft: draft };
  const hyperlocalPayload = {
    agencyId: body.agencyId, propertyDraft: { address: draft.address, zone: draft.zone, title: draft.title, propertyType: draft.propertyType },
    coordinates: coords, municipality,
  };
  const zonaPayload = { ...hyperlocalPayload };

  const [spRes, hlRes, zmRes] = await Promise.all([
    requested.has("source_profile") ? callSibling("civiko-property-source-profile", sourceProfilePayload, debugId) : Promise.resolve({ ok: true, status: 0, data: null }),
    requested.has("hyperlocal_signals") ? callSibling("civiko-property-hyperlocal-signals", hyperlocalPayload, debugId) : Promise.resolve({ ok: true, status: 0, data: null }),
    requested.has("zona_in_movimento") ? callSibling("civiko-property-zona-in-movimento", zonaPayload, debugId) : Promise.resolve({ ok: true, status: 0, data: null }),
  ]);

  const sourceProfile = unwrap(spRes.data);
  const hyperlocalSignals = unwrap(hlRes.data);
  const zonaInMovimento = unwrap(zmRes.data);

  // Piano Esclusiva needs upstream context, run after fan-out.
  let pianoEsclusiva: Record<string, unknown> | null = null;
  if (requested.has("piano_esclusiva")) {
    const peRes = await callSibling("civiko-property-piano-esclusiva", {
      agencyId: body.agencyId, propertyDraft: draft,
      sourceProfile, hyperlocalSignals,
    }, debugId);
    pianoEsclusiva = unwrap(peRes.data);
  }

  // Owner report aggregates everything.
  let ownerReport: Record<string, unknown> | null = null;
  if (requested.has("owner_report")) {
    const orRes = await callSibling("civiko-property-owner-report", {
      agencyId: body.agencyId, propertyDraft: draft,
      sourceProfile, hyperlocalSignals, pianoEsclusiva,
    }, debugId);
    ownerReport = unwrap(orRes.data);
  }

  // Status assessment
  const successes = [spRes, hlRes, zmRes].filter((r) => r.status === 0 || r.ok).length;
  const total = [spRes, hlRes, zmRes].filter((r) => r.status !== 0).length;
  const status: "ok" | "partial" | "unavailable" =
    total === 0 ? "ok"
      : successes === total ? "ok"
      : successes > 0 ? "partial"
      : "unavailable";

  const moduleStatuses = {
    sourceProfile: spRes.status === 0 ? "skipped" : (spRes.ok ? "ok" : "failed"),
    hyperlocalSignals: hlRes.status === 0 ? "skipped" : (hlRes.ok ? "ok" : "failed"),
    zonaInMovimento: zmRes.status === 0 ? "skipped" : (zmRes.ok ? "ok" : "failed"),
    pianoEsclusiva: pianoEsclusiva ? "ok" : (requested.has("piano_esclusiva") ? "failed" : "skipped"),
    ownerReport: ownerReport ? "ok" : (requested.has("owner_report") ? "failed" : "skipped"),
  };

  // Materials to validate (always present as agency checklist).
  const materialsToValidate = [
    { label: "Documentazione catastale e di conformità", status: "da_verificare" },
    { label: "Riferimenti di Mercato della zona OMI", status: "da_verificare" },
    { label: "Verifiche di Supporto Territoriale", status: "da_verificare" },
    { label: "Eventuali Segnali di Zona da rivedere prima della pubblicazione", status: "da_verificare" },
  ];

  // Record usage if billing is configured and we actually produced output.
  if (gate.billingReady && body.agencyId && status !== "unavailable") {
    try { await recordUsage(body.agencyId, "scan", 1); } catch { /* swallow */ }
    if (ownerReport && body.agencyId) {
      try { await recordUsage(body.agencyId, "owner_report", 1); } catch { /* swallow */ }
    }
    if (pianoEsclusiva && body.agencyId) {
      try { await recordUsage(body.agencyId, "piano_esclusiva", 1); } catch { /* swallow */ }
    }
  }

  return sanitizeOutgoing({
    runId: debugId,
    status,
    inputQuality: validation.inputQuality,
    propertyIdentity: identity,
    sourceProfile,
    hyperlocalSignals,
    zonaInMovimento,
    pianoEsclusiva,
    ownerReport,
    materialsToValidate,
    moduleStatuses,
    billingGate: {
      allowed: gate.allowed,
      billingReady: gate.billingReady,
      plan: gate.plan,
      status: gate.status,
      usage: gate.usage,
      limits: gate.limits,
      upgradeRequired: gate.upgradeRequired,
    },
    warnings: validation.warnings,
    updatedAt: new Date().toISOString(),
  });
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
          billingReady: readStripeEnv().configured,
        }, debugId), "health");
      }
      if (pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({
          functionName: FUNCTION_NAME, serviceKind: "civiko-metodo-sottra",
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
    return withIdentity(json(req, 500, {
      error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` },
      debug_id: debugId,
    }, debugId), "error");
  }
});
