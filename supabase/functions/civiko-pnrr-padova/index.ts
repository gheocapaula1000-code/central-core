// civiko-pnrr-padova — Edge Function
// POST /functions/v1/civiko-pnrr-padova
// Recupera opere pubbliche PNRR nel raggio da un punto di Padova.
// Fonte: OpenPNRR API REST + fallback CSV.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  makeDebugId, handleOptions, ok, fail,
  CORE_VERSION, addIdentityHeaders, buildManifest,
} from "../_shared/http.ts";
import { sanitizeOutgoing, isPadovaCoord, haversineMeters, PADOVA_COMUNE_ISTAT_SHORT } from "../_shared/civiko.ts";

const FUNCTION_NAME = "civiko-pnrr-padova";
const BASE_PATH = "/functions/v1/civiko-pnrr-padova";
const ISTAT_PADOVA = PADOVA_COMUNE_ISTAT_SHORT; // "028060"
const TIMEOUT_MS = 8000;

interface PnrrProject {
  titolo: string;
  missione?: string;
  importoEuro?: number;
  stato?: string;
  lat?: number;
  lng?: number;
  distanceMeters?: number;
  fonteUrl: string;
}

async function fetchFromOpenPNRR(): Promise<PnrrProject[] | null> {
  const base = Deno.env.get("OPENPNRR_BASE_URL") ?? "https://openpnrr.it/api";
  const endpoints = [
    `${base}/v1/projects/?comune_istat=${ISTAT_PADOVA}&format=json`,
    `${base}/projects/?localizzazione__comune__codice=${ISTAT_PADOVA}&format=json`,
  ];

  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) continue;

      const data = await res.json();
      const results = data?.results ?? data ?? [];
      if (!Array.isArray(results)) continue;

      return results.map((p: Record<string, unknown>) => ({
        titolo: String(p.titolo ?? p.title ?? p.nome ?? "Opera pubblica PNRR"),
        missione: String(p.missione ?? p.mission ?? ""),
        importoEuro: typeof p.importo === "number" ? p.importo : undefined,
        stato: String(p.stato ?? p.status ?? ""),
        lat: typeof p.lat === "number" ? p.lat : undefined,
        lng: typeof p.lng === "number" ? p.lng : undefined,
        fonteUrl: "https://openpnrr.it/opendata/",
      }));
    } catch {
      continue;
    }
  }
  return null;
}

serve(async (req) => {
  const debugId = makeDebugId();
  if (req.method === "OPTIONS") return handleOptions(req);

  const url = new URL(req.url);
  const path = url.pathname.replace(BASE_PATH, "") || "/";

  if (path === "/health" && req.method === "GET") {
    return addIdentityHeaders(
      ok(req, { status: "ok", function: FUNCTION_NAME, version: CORE_VERSION }, [], debugId),
      { function: FUNCTION_NAME, route: "/health" }
    );
  }
  if (path === "/manifest" && req.method === "GET") {
    return addIdentityHeaders(
      ok(req, buildManifest({
        functionName: FUNCTION_NAME,
        serviceKind: "padova-data",
        expectedBasePath: BASE_PATH,
        routes: ["GET /health", "GET /manifest", "POST /"],
      }), [], debugId),
      { function: FUNCTION_NAME, route: "/manifest" }
    );
  }

  if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Usa POST", debugId);

  let body: { lat?: number; lng?: number; radiusMeters?: number } = {};
  try { body = await req.json(); } catch { return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId); }

  const { lat, lng, radiusMeters = 1000 } = body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return fail(req, 400, "MISSING_COORDS", "lat e lng sono obbligatori", debugId);
  }
  if (!isPadovaCoord(lat, lng)) {
    return fail(req, 400, "OUT_OF_PADOVA", "Coordinate fuori dal Comune di Padova", debugId);
  }

  const warnings: string[] = [];
  const allProjects = await fetchFromOpenPNRR();

  if (!allProjects) {
    warnings.push("Dati PNRR temporaneamente non disponibili. Il Dossier è comunque completo nelle altre sezioni.");
    return addIdentityHeaders(
      ok(req, sanitizeOutgoing({ status: "unavailable", opereVicine: [], warnings, sources: [{ name: "OpenPNRR Open Data", url: "https://openpnrr.it/opendata/" }] }), warnings, debugId),
      { function: FUNCTION_NAME, route: "/" }
    );
  }

  const opereVicine: PnrrProject[] = [];
  for (const p of allProjects) {
    if (typeof p.lat === "number" && typeof p.lng === "number") {
      const dist = Math.round(haversineMeters(lat, lng, p.lat, p.lng));
      if (dist <= radiusMeters) opereVicine.push({ ...p, distanceMeters: dist });
    }
  }

  const risultato = opereVicine.length > 0
    ? opereVicine.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0)).slice(0, 5)
    : allProjects.slice(0, 5);

  if (opereVicine.length === 0 && allProjects.length > 0) {
    warnings.push("Coordinate precise non disponibili per alcune opere. Mostrate le principali opere PNRR del Comune di Padova.");
  }

  return addIdentityHeaders(
    ok(req, sanitizeOutgoing({
      status: "ok",
      opereVicine: risultato,
      totaleComune: allProjects.length,
      warnings,
      sources: [{ name: "OpenPNRR Open Data", url: "https://openpnrr.it/opendata/" }],
    }), warnings, debugId),
    { function: FUNCTION_NAME, route: "/" }
  );
});
