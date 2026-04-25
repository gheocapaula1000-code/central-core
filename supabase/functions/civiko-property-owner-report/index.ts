// ═══════════════════════════════════════════════════════════════
// Civiko One — Presentazione Proprietario (owner-facing report)
// POST /civiko/property-owner-report
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-property-owner-report";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-owner-report";
const ROUTES = ["GET  /health", "GET  /manifest", "POST /civiko/property-owner-report"];

interface RequestBody {
  agencyId?: string;
  propertyDraft?: { title?: string; address?: string; zone?: string; propertyType?: string; strengths?: string; knownIssues?: string; askingPrice?: number | string };
  sourceProfile?: { sourceAreas?: Array<{ id: string; title: string; status: string; summary: string; displayItems?: Array<{ label: string; value: string }> }> };
  hyperlocalSignals?: { matchedSignals?: Array<{ fact: { title: string; source: string; summary: string; confidence: string; publishedAt: string | null }; commercialUse: { label: string; suggestedUse: string; useInReport: boolean }; sourceLevel: number }> };
  pianoEsclusiva?: { mainLeverage?: string[]; phrasesToUse?: string[]; nextActions?: string[] };
}

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function build(body: RequestBody, debugId: string) {
  const draft = body.propertyDraft ?? {};
  const areas = body.sourceProfile?.sourceAreas ?? [];
  const reportable = (body.hyperlocalSignals?.matchedSignals ?? []).filter((s) => s.commercialUse?.useInReport && s.sourceLevel !== 3);

  const presentazione = {
    title: "Presentazione Proprietario",
    intro: "Documento di lavoro per il Primo Appuntamento. Mostra il contesto documentabile del Suo immobile.",
    propertyHeader: {
      title: draft.title ?? "Immobile Reale",
      address: draft.address ?? "",
      zone: draft.zone ?? "",
      propertyType: draft.propertyType ?? "",
    },
    keyPoints: [
      "I dati e le Verifiche di Supporto sono frutto delle fonti collegate dall'agenzia.",
      "Le leve narrative sono indicazioni di contesto, non promesse di risultato.",
      "Il Piano di Valorizzazione si attiva con l'Incarico in Esclusiva.",
    ],
  };

  const dossier = {
    title: "Dossier Venditore",
    sections: areas.filter((a) => a.status === "collegata").map((a) => ({
      title: a.title,
      summary: a.summary,
      items: a.displayItems ?? [],
    })),
  };

  const fontiDaCollegare = {
    title: "Fonti da Collegare",
    items: areas.filter((a) => a.status === "da_collegare" || a.status === "da_consultare").map((a) => ({
      label: a.title, note: a.summary,
    })),
  };

  const zonaInMovimento = {
    title: "Zona in Movimento",
    signals: reportable.slice(0, 8).map((s) => ({
      title: s.fact.title,
      summary: s.fact.summary,
      source: s.fact.source,
      publishedAt: s.fact.publishedAt,
      confidence: s.fact.confidence,
      commercialUse: s.commercialUse.label,
      suggestedUse: s.commercialUse.suggestedUse,
    })),
  };

  const pianoEsclusiva = {
    title: "Piano Esclusiva",
    mainLeverage: body.pianoEsclusiva?.mainLeverage ?? [],
    phrasesToUse: body.pianoEsclusiva?.phrasesToUse ?? [],
    nextActions: body.pianoEsclusiva?.nextActions ?? [],
  };

  const materialiDaValidare = {
    title: "Materiali da Validare",
    items: [
      "Documentazione catastale e di conformità.",
      "Riferimenti di Mercato della zona OMI.",
      "Eventuali Segnali di Zona da rivedere prima della pubblicazione.",
    ],
  };

  return sanitizeOutgoing({
    reportId: debugId,
    presentazioneProprietario: presentazione,
    dossierVenditore: dossier,
    fontiDaCollegare,
    zonaInMovimento,
    pianoEsclusiva,
    materialiDaValidare,
    updatedAt: new Date().toISOString(),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const debugId = makeDebugId();
  try {
    const blocked = enforceOriginPolicy(req, debugId);
    if (blocked) return withIdentity(blocked, "origin-blocked");

    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.pathname.endsWith("/health") || url.pathname === "/" || url.pathname === EXPECTED_BASE_PATH) {
        return withIdentity(json(req, 200, { status: "healthy", function: FUNCTION_NAME, version: CORE_VERSION, contract: CORE_CONTRACT, expectedBasePath: EXPECTED_BASE_PATH, time: new Date().toISOString() }, debugId), "health");
      }
      if (url.pathname.endsWith("/manifest")) {
        return withIdentity(json(req, 200, buildManifest({ functionName: FUNCTION_NAME, serviceKind: "civiko-owner-report", expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct" }), debugId), "manifest");
      }
      return withIdentity(fail(req, 404, "ROUTE_NOT_FOUND", `GET ${url.pathname}`, debugId), "error");
    }
    if (req.method !== "POST") return withIdentity(fail(req, 405, "METHOD_NOT_ALLOWED", "Use POST", debugId), "error");

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return withIdentity(fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId), "error"); }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return withIdentity(fail(req, 400, "INVALID_BODY", "Body must be a JSON object.", debugId), "error");
    }
    return withIdentity(json(req, 200, build(raw as RequestBody, debugId), debugId), "owner-report");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, { error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` }, debug_id: debugId }, debugId), "error");
  }
});
