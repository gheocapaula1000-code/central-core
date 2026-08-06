// Civiko One / Padova — audit fail-closed della sincronizzazione PWA.
//
// La PWA Civiko conferma qui l'esito reale del proprio sync. Il release gate
// legge SOLO questa tabella: nessuna prova indiretta, nessuna deduzione da
// altri job. Contratto di autenticazione già esistente:
//   x-source-app: civiko | civiko-one | civiko_one
//   x-internal-secret: AI_CORE_SECRET_CIVIKO (nessuna nuova secret)
//
// Isolato: non tocca civiko-one-signals-feed, auth condivisa, cron o provider.

import {
  enforceOriginPolicy,
  fail,
  handleOptions,
  makeDebugId,
  ok,
  requireSecret,
} from "../_shared/http.ts";
import {
  type AckRecord,
  CIVIKO_SOURCE_APPS,
  validateAck,
} from "./validation.ts";
import {
  bindAckToPipeline,
  PIPELINE_ACK,
  PIPELINE_MAX_AGE_MS,
  type PipelineRunRow,
} from "./binding.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BODY_BYTES = 16_384;

/** Le esecuzioni pipeline candidate al binding: mai fornite dal client. */
async function fetchPipelineRuns(startedAtMs: number): Promise<PipelineRunRow[] | null> {
  const since = new Date(startedAtMs - PIPELINE_MAX_AGE_MS - 60_000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/civiko_pipeline_runs` +
    `?select=run_id,pipeline,finished_at,ok&pipeline=eq.${PIPELINE_ACK}` +
    `&finished_at=not.is.null&finished_at=gte.${encodeURIComponent(since)}` +
    `&order=finished_at.desc&limit=20`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) {
    console.error(`[civiko-pwa-sync-ack] pipeline read failed status=${res.status}`);
    await res.body?.cancel();
    return null;
  }
  return await res.json() as PipelineRunRow[];
}

async function upsertAck(
  record: AckRecord & { pipeline_run_id: string },
): Promise<{ ok: boolean; code?: string }> {

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/civiko_pwa_sync_acks?on_conflict=run_id`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([record]),
    },
  );
  if (!res.ok) {
    // Telemetria sanificata: mai il corpo del provider, mai secret.
    console.error(`[civiko-pwa-sync-ack] write failed status=${res.status}`);
    await res.body?.cancel();
    return { ok: false, code: res.status === 409 ? "ACK_CONFLICT" : "ACK_WRITE_FAILED" };
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

  // Auth PRIMA di qualsiasi write: identità applicativa + app secret Civiko.
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();
  if (!CIVIKO_SOURCE_APPS.has(sourceApp)) {
    return fail(req, 401, "APP_SECRET_REQUIRED", "Missing or invalid application identity", debugId);
  }
  const authBlock = requireSecret(req, debugId);
  if (authBlock) return authBlock;

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

  const validation = validateAck(parsed, sourceApp, Date.now());
  if (!validation.ok) {
    return fail(req, 400, validation.code, validation.message, debugId);
  }

  // Binding server-side: la PWA non dichiara la pipeline, la deriva il Core.
  const runs = await fetchPipelineRuns(Date.parse(validation.record.started_at));
  if (runs === null) {
    return fail(req, 502, "PIPELINE_LOOKUP_FAILED", "Pipeline audit not readable", debugId);
  }
  const binding = bindAckToPipeline(runs, Date.parse(validation.record.started_at));
  if (!binding.ok) {
    return fail(req, 409, binding.code, binding.message, debugId);
  }

  const written = await upsertAck({
    ...validation.record,
    pipeline_run_id: binding.pipelineRunId,
  });
  if (!written.ok) {
    return fail(req, 502, written.code ?? "ACK_WRITE_FAILED", "Ack not persisted", debugId);
  }

  return ok(req, {
    run_id: validation.record.run_id,
    idempotency_key: validation.record.idempotency_key,
    pipeline_run_id: binding.pipelineRunId,
    pipeline_finished_at: binding.pipelineFinishedAt,
    ok: validation.record.ok,
    finished_at: validation.record.finished_at,
    scope_comune: validation.record.scope_comune,
    zones: validation.record.scope_slugs.length,
  }, [], debugId);

});
