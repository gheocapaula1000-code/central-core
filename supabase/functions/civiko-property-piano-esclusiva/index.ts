// ═══════════════════════════════════════════════════════════════
// Civiko One — Piano Esclusiva
// POST /civiko/property-piano-esclusiva
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy, requireSecret,
} from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-property-piano-esclusiva";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-piano-esclusiva";
const ROUTES = ["GET  /health", "GET  /manifest", "POST /civiko/property-piano-esclusiva"];

interface PropertyDraft {
  title?: string;
  address?: string;
  zone?: string;
  propertyType?: string;
  askingPrice?: number | string;
  ownerGoal?: string;
  ownerTiming?: string;
  ownerPriority?: string;
  strengths?: string;
  knownIssues?: string;
}

interface RequestBody {
  agencyId?: string;
  propertyDraft?: PropertyDraft;
  sourceProfile?: { sourceAreas?: Array<{ id: string; status: string; title: string }> };
  hyperlocalSignals?: { matchedSignals?: Array<{ fact: { title: string; source: string; confidence: string }; commercialUse: { suggestedUse: string; useInReport: boolean } }> };
  agencyContext?: { commonObjections?: string[]; recurringWins?: string[] };
}

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function build(body: RequestBody, debugId: string) {
  const draft = body.propertyDraft ?? {};
  const collegate = (body.sourceProfile?.sourceAreas ?? []).filter((a) => a.status === "collegata").map((a) => a.title);
  const daCollegare = (body.sourceProfile?.sourceAreas ?? []).filter((a) => a.status === "da_collegare" || a.status === "da_consultare").map((a) => a.title);
  const reportableSignals = (body.hyperlocalSignals?.matchedSignals ?? []).filter((s) => s.commercialUse?.useInReport).slice(0, 6);

  const positioning = {
    summary: draft.askingPrice
      ? "Posizionamento commerciale da costruire intorno ai Riferimenti di Mercato e ai Punti di Forza inseriti dall'agenzia."
      : "Posizionamento da definire una volta condivisi con il Proprietario gli Elementi di Zona e i Riferimenti di Mercato.",
    recommendedOpening:
      "Aprire l'Appuntamento Venditore mostrando i Dati Inseriti dall'Agenzia, il Dossier Venditore e gli Elementi di Zona disponibili come supporto alla pratica.",
  };

  const mainLeverage: string[] = [];
  if (draft.strengths) mainLeverage.push("Costruire la narrazione partendo dai Punti di Forza dell'immobile inseriti dall'agenzia.");
  if (collegate.length > 0) mainLeverage.push(`Sfruttare le Verifiche di Supporto disponibili: ${collegate.join(", ")}.`);
  for (const s of reportableSignals.slice(0, 4)) {
    mainLeverage.push(`Usare il segnale "${s.fact.title}" (${s.fact.source}) come leva narrativa documentabile.`);
  }
  if (mainLeverage.length === 0) mainLeverage.push("Costruire la leva narrativa con i Riferimenti di Zona disponibili al momento del Primo Appuntamento.");

  const exclusiveArgument: string[] = [
    "Presentare il Metodo Civiko One come standard di lavoro che protegge il Proprietario.",
    "Mostrare il Piano di Valorizzazione completo e il Kit Marketing Immobiliare che attiveremo solo con l'Incarico in Esclusiva.",
    "Raccontare il Servizio Completo: Presentazione Proprietario, Dossier Venditore, Materiali da Validare e gestione delle visite.",
  ];

  const riskIfNoExclusive: string[] = [
    "Senza Incarico in Esclusiva il posizionamento iniziale può essere disperso da più agenzie e perdere coerenza.",
    "Le Verifiche di Supporto e i Materiali da Validare non vengono attivati senza esclusiva.",
    "Il follow-up con il Proprietario diventa frammentato e meno tracciabile.",
  ];

  const phrasesToUse: string[] = [
    "Le porto la Presentazione Proprietario costruita sui dati reali del Suo immobile.",
    "Le mostro le Fonti da Collegare e le Verifiche di Supporto previste dal Metodo Civiko One.",
    "L'Incarico in Esclusiva ci permette di proteggere il valore percepito del Suo immobile.",
    "Non promettiamo risultati: mostriamo il contesto documentabile e il Piano di Valorizzazione.",
  ];

  const nextActions: string[] = [
    "Confermare il Primo Appuntamento e portare la Presentazione Proprietario stampata.",
    "Preparare il Dossier Venditore con le fonti collegate e quelle ancora da collegare.",
    daCollegare.length > 0 ? `Collegare prima del Primo Appuntamento: ${daCollegare.join(", ")}.` : "Verificare che tutte le fonti previste risultino collegate o pianificate.",
    "Pianificare il follow-up entro 48 ore dal Primo Appuntamento.",
  ];

  const ownerObjections = (body.agencyContext?.commonObjections ?? []).slice(0, 6).map((o) => ({
    objection: o,
    suggestedResponse: "Rispondere con dati documentabili presi dal Dossier Venditore e dai Riferimenti di Mercato.",
  }));

  const sourceAnchors = collegate.map((label) => ({ label, role: "Verifica di Supporto" }));

  return sanitizeOutgoing({
    planId: debugId,
    title: "Piano Esclusiva",
    positioning,
    mainLeverage,
    exclusiveArgument,
    riskIfNoExclusive,
    phrasesToUse,
    nextActions,
    ownerObjections,
    sourceAnchors,
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
        return withIdentity(json(req, 200, buildManifest({ functionName: FUNCTION_NAME, serviceKind: "civiko-piano-esclusiva", expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct" }), debugId), "manifest");
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
    return withIdentity(json(req, 200, build(raw as RequestBody, debugId), debugId), "piano-esclusiva");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, { error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` }, debug_id: debugId }, debugId), "error");
  }
});
