// Civiko One / Padova — audit fail-closed della sincronizzazione PWA.
//
// La PWA Civiko conferma qui l'esito reale del proprio sync. Il release gate
// legge SOLO questa tabella: nessuna prova indiretta, nessuna deduzione da
// altri job. Contratto di autenticazione (già esistente, invariato):
//   x-source-app: civiko-one (o civiko / civiko_one)
//   x-internal-secret: AI_CORE_SECRET_CIVIKO (o CORE_INTERNAL_SECRET compat)
//   x-idempotency-key: uguale a run_id
//
// Isolato: non tocca _shared/http.ts, civiko-one-signals-feed, cron o provider.

import {
  enforceOriginPolicy,
  fail,
  handleOptions,
  makeDebugId,
  ok,
  requireCivikoCostSecret,
} from "../_shared/http.ts";
import {
  type AckRecord,
  CIVIKO_SOURCE_APPS,
  isIdenticalAck,
  validateAck,
} from "./validation.ts";
import {
  type ActionRunRow,
  bindAckToPipeline,
  PIPELINE_ACK,
  PIPELINE_MARKER_ACTION,
  PIPELINE_MAX_AGE_MS,
} from "./binding.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 16_384;

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...extra,
  };
}

/**
 * Marker di pipeline dall'audit canonico: mai forniti dal client.
 * Non si filtra su ok/status qui: il latest-wins deve poter vedere anche i
 * tentativi falliti o ancora aperti.
 */
async function fetchPipelineMarkers(startedAtMs: number): Promise<ActionRunRow[] | null> {
  const since = new Date(startedAtMs - PIPELINE_MAX_AGE_MS - 60 * 60_000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/civiko_orchestrator_action_runs` +
    `?select=pipeline_run_id,action,pipeline,started_at,finished_at,ok,status` +
    `&action=eq.${PIPELINE_MARKER_ACTION}&pipeline=eq.${PIPELINE_ACK}` +
    `&started_at=gte.${encodeURIComponent(since)}` +
    `&order=started_at.desc&limit=50`;
  const res = await fetch(url, { headers: restHeaders() });
  if (!res.ok) {
    console.error(`[civiko-pwa-sync-ack] pipeline audit read failed status=${res.status}`);
    await res.body?.cancel();
    return null;
  }
  return await res.json() as ActionRunRow[];
}

async function readExistingAck(runId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/civiko_pwa_sync_acks?select=*&run_id=eq.${runId}&limit=1`,
    { headers: restHeaders() },
  );
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const rows = await res.json() as Record<string, unknown>[];
  return rows.length > 0 ? rows[0] : null;
}

/** Insert IMMUTABILE: nessun upsert, nessuna sovrascrittura di una ricevuta. */
async function insertAck(
  record: AckRecord & { pipeline_run_id: string },
): Promise<{ ok: boolean; conflict?: boolean; code?: string }> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/civiko_pwa_sync_acks`,
    {
      method: "POST",
      headers: restHeaders({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify([record]),
    },
  );
  if (!res.ok) {
    // Telemetria sanificata: mai il corpo del provider, mai secret.
    console.error(`[civiko-pwa-sync-ack] write failed status=${res.status}`);
    await res.body?.cancel();
    if (res.status === 409) return { ok: false, conflict: true, code: "ACK_CONFLICT" };
    return { ok: false, code: "ACK_WRITE_FAILED" };
  }
  await res.body?.cancel();
  return { ok: true };
}

Deno.serve(async (req) => {
  const debugId = makeDebugId();

  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Only POST is accepted", debugId);
  }

  const originBlock = enforceOriginPolicy(req, debugId);
  if (originBlock) return originBlock;

  // Auth PRIMA di leggere il body e di qualsiasi read/write.
  const authBlock = requireCivikoCostSecret(req, debugId);
  if (authBlock) return authBlock;
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();
  // La guard shared accetta anche identità non-Civiko (compat acquisitionradar):
  // qui si esige l'identità canonica del contratto PWA Civiko One, PRIMA di
  // leggere il body e di qualunque read/write. Fail-closed, nessun alias extra.
  if (!CIVIKO_SOURCE_APPS.has(sourceApp)) {
    console.warn(`[civiko-pwa-sync-ack] source app rejected debug_id=${debugId}`);
    return fail(req, 403, "SOURCE_APP_FORBIDDEN", "Source app not allowed for this endpoint", debugId);
  }


  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("[civiko-pwa-sync-ack] misconfigured");
    return fail(req, 500, "CONFIG_ERROR", "Storage not configured", debugId);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return fail(req, 413, "PAYLOAD_TOO_LARGE", "Body too large", debugId);
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return fail(req, 400, "INVALID_JSON", "Body is not valid JSON", debugId);
  }

  const validation = validateAck(
    parsed,
    sourceApp,
    Date.now(),
    req.headers.get("x-idempotency-key"),
  );
  if (!validation.ok) {
    return fail(req, 400, validation.code, validation.message, debugId);
  }

  // Binding server-side: la PWA non dichiara la pipeline, la deriva il Core.
  const startedMs = Date.parse(validation.record.started_at);
  const markers = await fetchPipelineMarkers(startedMs);
  if (markers === null) {
    return fail(req, 502, "PIPELINE_LOOKUP_FAILED", "Pipeline audit not readable", debugId);
  }
  const binding = bindAckToPipeline(markers, startedMs);
  if (!binding.ok) {
    return fail(req, 409, binding.code, binding.message, debugId);
  }

  const payload = { ...validation.record, pipeline_run_id: binding.pipelineRunId };
  const written = await insertAck(payload);

  if (!written.ok) {
    if (!written.conflict) {
      return fail(req, 502, written.code ?? "ACK_WRITE_FAILED", "Ack not persisted", debugId);
    }
    // Replay: 200 solo se la ricevuta esistente è identica in ogni campo.
    const existing = await readExistingAck(validation.record.run_id);
    if (existing && isIdenticalAck(existing, validation.record, binding.pipelineRunId)) {
      return ok(req, {
        run_id: validation.record.run_id,
        idempotency_key: validation.record.run_id,
        pipeline_run_id: binding.pipelineRunId,
        pipeline_finished_at: binding.pipelineFinishedAt,
        ok: validation.record.ok,
        finished_at: validation.record.finished_at,
        municipality: validation.record.municipality,
        zones: validation.record.commercial_zone_slugs.length,
        replay: true,
      }, [], debugId);
    }
    return fail(
      req,
      409,
      "ACK_IMMUTABLE_CONFLICT",
      "An ack already exists for this run_id or pipeline with a different payload",
      debugId,
    );
  }

  return ok(req, {
    run_id: validation.record.run_id,
    idempotency_key: validation.record.run_id,
    pipeline_run_id: binding.pipelineRunId,
    pipeline_finished_at: binding.pipelineFinishedAt,
    ok: validation.record.ok,
    finished_at: validation.record.finished_at,
    municipality: validation.record.municipality,
    zones: validation.record.commercial_zone_slugs.length,
    replay: false,
  }, [], debugId);
});
