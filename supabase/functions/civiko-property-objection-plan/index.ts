// ═══════════════════════════════════════════════════════════════
// Civiko One — Owner Objection Plan
// POST /civiko/property-objection-plan
// ═══════════════════════════════════════════════════════════════

import {
  makeDebugId, handleOptions, json, fail,
  CORE_VERSION, CORE_CONTRACT, addIdentityHeaders,
  buildManifest, enforceOriginPolicy,
} from "../_shared/http.ts";
import { sanitizeOutgoing } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-property-objection-plan";
const EXPECTED_BASE_PATH = "/functions/v1/civiko-property-objection-plan";
const ROUTES = ["GET  /health", "GET  /manifest", "POST /civiko/property-objection-plan"];

const OBJECTION_TYPES = [
  "commission","price_expectation","timing","trust","competition",
  "documentation","visibility","previous_bad_experience","other",
] as const;
type ObjectionType = typeof OBJECTION_TYPES[number];

interface RequestBody {
  agencyId?: string;
  propertyDraft?: { address?: string; zone?: string };
  ownerObjection?: { type?: ObjectionType; text?: string };
  agencyContext?: { recurringWins?: string[] };
  sourceProfile?: { sourceAreas?: Array<{ title: string; status: string }> };
  hyperlocalSignals?: { matchedSignals?: Array<{ fact: { title: string; source: string }; commercialUse: { suggestedUse: string; useInReport: boolean } }> };
}

function classify(text: string): ObjectionType {
  const t = text.toLowerCase();
  if (/(provvigione|commissione|costo|tariffa)/.test(t)) return "commission";
  if (/(prezzo|valore|valuto|aspettativa|più alto|piu alto)/.test(t)) return "price_expectation";
  if (/(tempo|fretta|urgenza|aspetto|aspettare)/.test(t)) return "timing";
  if (/(fiducia|affidabil|garanzi)/.test(t)) return "trust";
  if (/(altra agenzia|altre agenzie|concorrente|concorrenza)/.test(t)) return "competition";
  if (/(documenti|catastal|certificat|documentazione)/.test(t)) return "documentation";
  if (/(visibilit|annuncio|portale|portali)/.test(t)) return "visibility";
  if (/(brutta esperienza|delusione|già provato|gia provato)/.test(t)) return "previous_bad_experience";
  return "other";
}

const RESPONSES: Record<ObjectionType, { response: string; phrase: string; followUp: string }> = {
  commission: {
    response: "Spiegare cosa comprende il Servizio Completo e il Kit Marketing Immobiliare attivati con l'Incarico in Esclusiva.",
    phrase: "La provvigione è legata al Servizio Completo: Presentazione Proprietario, Dossier Venditore e Piano di Valorizzazione.",
    followUp: "Inviare il dettaglio del Servizio Completo entro 24 ore.",
  },
  price_expectation: {
    response: "Riportare il discorso ai Riferimenti di Mercato e ai Materiali da Validare. Non promettere risultati.",
    phrase: "Le mostro i Riferimenti di Mercato disponibili e definiamo insieme un posizionamento sostenibile.",
    followUp: "Condividere il Dossier Venditore con i Riferimenti di Mercato.",
  },
  timing: {
    response: "Allineare le tempistiche del Proprietario con il Piano di Valorizzazione realistico per la zona.",
    phrase: "Definiamo un Piano di Valorizzazione coerente con le Sue tempistiche.",
    followUp: "Pianificare un secondo appuntamento entro 7 giorni.",
  },
  trust: {
    response: "Mostrare il Metodo Civiko One e le Verifiche di Supporto già collegate.",
    phrase: "Le porto le Fonti Collegate del Suo immobile come prova del nostro metodo.",
    followUp: "Condividere il Dossier Venditore aggiornato.",
  },
  competition: {
    response: "Differenziare la Presentazione Proprietario rispetto alle proposte non strutturate.",
    phrase: "Le mostro la differenza fra una Presentazione Proprietario e una semplice valutazione verbale.",
    followUp: "Inviare la Presentazione Proprietario stampata.",
  },
  documentation: {
    response: "Indicare quali Materiali da Validare seguiremo prima della pubblicazione.",
    phrase: "I Materiali da Validare li gestiamo insieme prima della pubblicazione.",
    followUp: "Inviare la lista documenti al Proprietario.",
  },
  visibility: {
    response: "Mostrare il Kit Marketing Immobiliare e il Piano di Valorizzazione.",
    phrase: "Con l'Incarico in Esclusiva attiviamo il Kit Marketing Immobiliare completo.",
    followUp: "Inviare un esempio di Kit Marketing per immobili simili dell'agenzia.",
  },
  previous_bad_experience: {
    response: "Ascoltare l'esperienza precedente e mostrare come il Metodo Civiko One protegge il Proprietario.",
    phrase: "Il Metodo Civiko One nasce per evitare proprio quel tipo di esperienza.",
    followUp: "Pianificare un secondo appuntamento di verifica.",
  },
  other: {
    response: "Approfondire l'obiezione con domande aperte e portarla nel Dossier Venditore.",
    phrase: "Mi aiuti a capire meglio: lo riportiamo nel Dossier Venditore così lavoriamo su dati reali.",
    followUp: "Aggiornare il Dossier Venditore e ripianificare.",
  },
};

function withIdentity(res: Response, route: string) {
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route });
}

function build(body: RequestBody, debugId: string) {
  const objText = body.ownerObjection?.text ?? "";
  const type = body.ownerObjection?.type && OBJECTION_TYPES.includes(body.ownerObjection.type)
    ? body.ownerObjection.type
    : classify(objText);
  const r = RESPONSES[type];
  const supporting = (body.hyperlocalSignals?.matchedSignals ?? [])
    .filter((s) => s.commercialUse?.useInReport)
    .slice(0, 3)
    .map((s) => ({ title: s.fact.title, source: s.fact.source, suggestedUse: s.commercialUse.suggestedUse }));

  return sanitizeOutgoing({
    planId: debugId,
    objectionType: type,
    objectionText: objText,
    recommendedResponse: r.response,
    supportingSignals: supporting,
    phraseToUse: r.phrase,
    followUpAction: r.followUp,
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
        return withIdentity(json(req, 200, buildManifest({ functionName: FUNCTION_NAME, serviceKind: "civiko-objection-plan", expectedBasePath: EXPECTED_BASE_PATH, routes: ROUTES, callingMode: "direct" }), debugId), "manifest");
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
    return withIdentity(json(req, 200, build(raw as RequestBody, debugId), debugId), "objection-plan");
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error debug_id=${debugId}: ${err instanceof Error ? err.message : String(err)}`);
    return withIdentity(json(req, 500, { error: { code: "INTERNAL_ERROR", message: `An internal error occurred. Reference: ${debugId}` }, debug_id: debugId }, debugId), "error");
  }
});
