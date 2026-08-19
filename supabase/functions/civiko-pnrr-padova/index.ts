// civiko-pnrr-padova — Edge Function
// POST /functions/v1/civiko-pnrr-padova
// Recupera opere pubbliche PNRR nel raggio da un punto di Padova.
// Fonte: OpenPNRR API REST + fallback CSV.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  makeDebugId, handleOptions, ok, fail,
  CORE_VERSION, addIdentityHeaders, buildManifest,
  isJobSecretAuthorized,
} from "../_shared/http.ts";
import { sanitizeOutgoing, isPadovaCoord, haversineMeters, PADOVA_COMUNE_ISTAT_SHORT } from "../_shared/civiko.ts";
import {
  writeSourceRegistryStatus,
  PADOVA_CRON_COORDS,
  PADOVA_CRON_RADIUS_M,
} from "../_shared/sourceRegistryStatus.ts";
import { buildEvidenceRow, upsertEvidenceRows } from "../_shared/evidenceLedger.ts";

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

  const jobOk = isJobSecretAuthorized(req);
  let body: { lat?: number; lng?: number; radiusMeters?: number; triggered_by?: string } = {};
  try { body = await req.json(); } catch {
    if (!jobOk) return fail(req, 400, "INVALID_JSON", "Body JSON non valido", debugId);
    body = {};
  }

  const lat = typeof body.lat === "number" ? body.lat : (jobOk ? PADOVA_CRON_COORDS.lat : undefined);
  const lng = typeof body.lng === "number" ? body.lng : (jobOk ? PADOVA_CRON_COORDS.lng : undefined);
  const radiusMeters = typeof body.radiusMeters === "number"
    ? body.radiusMeters
    : (jobOk ? PADOVA_CRON_RADIUS_M : 1000);
  if (typeof lat !== "number" || typeof lng !== "number") {
    return fail(req, 400, "MISSING_COORDS", "lat e lng sono obbligatori", debugId);
  }
  if (!isPadovaCoord(lat, lng)) {
    return fail(req, 400, "OUT_OF_PADOVA", "Coordinate fuori dal Comune di Padova", debugId);
  }

  const warnings: string[] = [];
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

  let allProjects: PnrrProject[] | null = null;
  try {
    allProjects = await fetchFromOpenPNRR();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (supabase) {
      await writeSourceRegistryStatus(supabase, "F11", { ok: false, records: 0, error: msg.slice(0, 500) });
    }
    warnings.push("Dati PNRR temporaneamente non disponibili. Il Dossier è comunque completo nelle altre sezioni.");
    return addIdentityHeaders(
      ok(req, sanitizeOutgoing({ status: "unavailable", opereVicine: [], records_processed: 0, warnings, sources: [{ name: "OpenPNRR Open Data", url: "https://openpnrr.it/opendata/" }] }), warnings, debugId),
      { function: FUNCTION_NAME, route: "/" }
    );
  }

  if (!allProjects) {
    if (supabase) {
      await writeSourceRegistryStatus(supabase, "F11", {
        ok: false,
        records: 0,
        error: "openpnrr_unavailable",
      });
    }
    warnings.push("Dati PNRR temporaneamente non disponibili. Il Dossier è comunque completo nelle altre sezioni.");
    return addIdentityHeaders(
      ok(req, sanitizeOutgoing({ status: "unavailable", opereVicine: [], records_processed: 0, warnings, sources: [{ name: "OpenPNRR Open Data", url: "https://openpnrr.it/opendata/" }] }), warnings, debugId),
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

  if (supabase) {
    try {
      const row = buildEvidenceRow({
        entity_type: "comune",
        entity_key: "comune:padova",
        source_code: "F11",
        evidence_type: "pnrr_projects",
        evidence_value: {
          totaleComune: allProjects.length,
          nearby: opereVicine.length,
          titles: allProjects.slice(0, 20).map((p) => p.titolo).filter(Boolean),
        },
        confidence: allProjects.length >= 3 ? "medium" : "low",
        freshness_days: 14,
        explanation: `OpenPNRR: ${allProjects.length} opere nel Comune di Padova.`,
      });
      await upsertEvidenceRows(supabase, [row]);
    } catch (e) {
      console.warn("[civiko-pnrr-padova] evidence write failed", (e as Error).message);
    }
    await writeSourceRegistryStatus(supabase, "F11", {
      ok: true,
      records: allProjects.length,
    });
  }

  return addIdentityHeaders(
    ok(req, sanitizeOutgoing({
      status: "ok",
      opereVicine: risultato,
      totaleComune: allProjects.length,
      records_processed: allProjects.length,
      warnings,
      sources: [{ name: "OpenPNRR Open Data", url: "https://openpnrr.it/opendata/" }],
    }), warnings, debugId),
    { function: FUNCTION_NAME, route: "/" }
  );
});
