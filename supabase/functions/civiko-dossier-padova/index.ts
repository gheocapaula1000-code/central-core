// civiko-dossier-padova — Edge Function orchestratore
// POST /functions/v1/civiko-dossier-padova
// Fan-out server-side verso tutti i moduli Padova.
// Timeout totale: 12 secondi. Promise.allSettled — nessun modulo blocca gli altri.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, handleOptions, ok, fail,
  CORE_VERSION, addIdentityHeaders, buildManifest,
} from "../_shared/http.ts";
import { sanitizeOutgoing, isPadovaCoord } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-dossier-padova";
const BASE_PATH = "/functions/v1/civiko-dossier-padova";
const MODULE_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 12000;

interface PropertyDraft {
  address?: string;
  zone?: string;
  lat?: number;
  lng?: number;
  propertyType?: string;
  sizeSqm?: number;
  rooms?: number;
  askingPrice?: number;
  ownerGoal?: string;
  ownerTiming?: string;
}

async function callModule(supabaseUrl: string, anonKey: string, authHeader: string, functionName: string, body: unknown): Promise<{ ok: boolean; data: unknown; warning?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODULE_TIMEOUT_MS);
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader, "apikey": anonKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, data: null, warning: `${functionName} ha risposto con errore ${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, data: null, warning: `${functionName} ${aborted ? "non ha risposto in tempo" : "non raggiungibile"}` };
  }
}

function generateDossierId(): string {
  return `dossier-pd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSectionStatus(moduleOk: boolean): "pronta" | "da_collegare" {
  return moduleOk ? "pronta" : "da_collegare";
}

serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const path = url.pathname.replace(BASE_PATH, "") || "/";

  if (path === "/health" && req.method === "GET") {
    return addIdentityHeaders(ok(req, { status: "ok", function: FUNCTION_NAME, version: CORE_VERSION }, [], debugId), { function: FUNCTION_NAME, route: "/health" });
  }
  if (path === "/manifest" && req.method === "GET") {
    return addIdentityHeaders(ok(req, buildManifest({
      functionName: FUNCTION_NAME,
      serviceKind: "padova-orchestrator",
      expectedBasePath: BASE_PATH,
      routes: ["GET /health", "GET /manifest", "POST /"],
    }), [], debugId), { function: FUNCTION_NAME, route: "/manifest" });
  }

  if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Usa POST", debugId);

  let body: { agencyId?: string; propertyDraft?: PropertyDraft } = {};
  try { body = await req.json(); } catch { return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId); }

  const draft = body.propertyDraft ?? {};
  const lat = draft.lat ?? 45.4064;
  const lng = draft.lng ?? 11.8768;

  if (!isPadovaCoord(lat, lng)) {
    return fail(req, 400, "OUT_OF_PADOVA", "Coordinate fuori dal Comune di Padova", debugId);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? `Bearer ${ANON_KEY}`;

  const dossierId = generateDossierId();
  const coordPayload = { lat, lng };
  const warnings: string[] = [];

  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), TOTAL_TIMEOUT_MS);

  const [tramResult, pnrrResult, omiResult, sourceResult, hyperlocalResult, zonaResult, pianoResult] = await Promise.allSettled([
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-tram-padova", coordPayload),
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-pnrr-padova", coordPayload),
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-omi-padova-zone", coordPayload),
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-property-source-profile", { propertyDraft: draft }),
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-property-hyperlocal-signals", { propertyDraft: draft }),
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-property-zona-in-movimento", { propertyDraft: draft }),
    callModule(SUPABASE_URL, ANON_KEY, authHeader, "civiko-property-piano-esclusiva", { propertyDraft: draft }),
  ]);

  clearTimeout(totalTimer);

  function unwrap(settled: PromiseSettledResult<{ ok: boolean; data: unknown; warning?: string }>) {
    if (settled.status === "rejected") return { ok: false, data: null, warning: "Modulo non raggiungibile" };
    return settled.value;
  }

  const tram = unwrap(tramResult);
  const pnrr = unwrap(pnrrResult);
  const omi = unwrap(omiResult);
  const source = unwrap(sourceResult);
  const hyperlocal = unwrap(hyperlocalResult);
  const zona = unwrap(zonaResult);
  const piano = unwrap(pianoResult);

  for (const m of [tram, pnrr, omi, source, hyperlocal, zona, piano]) {
    if (!m.ok && m.warning) warnings.push(m.warning);
  }

  const hasCore = tram.ok || omi.ok;
  const overallStatus = hasCore ? (warnings.length > 0 ? "partial" : "ok") : "unavailable";

  const result = sanitizeOutgoing({
    dossierId,
    status: overallStatus,
    immobile: {
      address: draft.address ?? null,
      zone: draft.zone ?? null,
      lat,
      lng,
      propertyType: draft.propertyType ?? null,
      sizeSqm: draft.sizeSqm ?? null,
      rooms: draft.rooms ?? null,
      askingPrice: draft.askingPrice ?? null,
      ownerGoal: draft.ownerGoal ?? null,
      ownerTiming: draft.ownerTiming ?? null,
    },
    zonaOmi: omi.ok ? omi.data : null,
    sourceProfile: source.ok ? source.data : null,
    zonaInMovimento: zona.ok ? zona.data : null,
    pianoEsclusiva: piano.ok ? piano.data : null,
    tramPadova: tram.ok ? tram.data : null,
    pnrrPadova: pnrr.ok ? pnrr.data : null,
    hyperlocalSignals: hyperlocal.ok ? hyperlocal.data : null,
    presentazioneProprietario: {
      sections: [
        { id: "immobile_reale", title: "Immobile Reale", status: "pronta", bullets: draft.address ? [`Indirizzo: ${draft.address}`, draft.sizeSqm ? `Superficie: ${draft.sizeSqm} mq` : null, draft.rooms ? `Locali: ${draft.rooms}` : null].filter(Boolean) : [] },
        { id: "zona_omi", title: "Zona OMI di riferimento", status: buildSectionStatus(omi.ok), bullets: [] },
        { id: "riferimenti_mercato", title: "Riferimenti di Mercato", status: buildSectionStatus(source.ok), bullets: [] },
        { id: "zona_in_movimento", title: "Zona in Movimento", status: buildSectionStatus(zona.ok), bullets: [] },
        { id: "tram_mobilita", title: "Tram e Mobilità in Arrivo", status: buildSectionStatus(tram.ok), bullets: [] },
        { id: "opere_pubbliche", title: "Opere Pubbliche in Zona", status: buildSectionStatus(pnrr.ok), bullets: [] },
        { id: "piano_esclusiva", title: "Piano Esclusiva", status: buildSectionStatus(piano.ok), bullets: [] },
        { id: "materiali_da_validare", title: "Materiali da Validare", status: "da_validare", bullets: [] },
      ],
    },
    moduleStatuses: {
      tramPadova: tram.ok ? "ok" : "unavailable",
      pnrrPadova: pnrr.ok ? "ok" : "unavailable",
      omiZone: omi.ok ? "ok" : "unavailable",
      sourceProfile: source.ok ? "ok" : "da_collegare",
      hyperlocalSignals: hyperlocal.ok ? "ok" : "da_collegare",
      zonaInMovimento: zona.ok ? "ok" : "da_collegare",
      pianoEsclusiva: piano.ok ? "ok" : "da_collegare",
    },
    warnings,
    sources: [
      { name: "Tram Padova", url: "https://www.trampadova.it" },
      { name: "OpenPNRR Open Data", url: "https://openpnrr.it/opendata/" },
      { name: "Agenzia delle Entrate - OMI Geopoi", url: "https://www1.agenziaentrate.gov.it/servizi/geopoi_omi/index.php" },
    ],
    updatedAt: new Date().toISOString(),
  });

  return addIdentityHeaders(ok(req, result, warnings, debugId), { function: FUNCTION_NAME, route: "/" });
});
