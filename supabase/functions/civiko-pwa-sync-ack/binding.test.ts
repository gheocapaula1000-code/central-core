// Test statici del binding server-side ack ↔ audit canonico pipeline_0710.
// Nessuna rete, nessun provider.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ActionRunRow,
  bindAckToPipeline,
  PIPELINE_MARKER_ACTION,
} from "./binding.ts";

const STARTED = Date.parse("2026-08-06T07:30:00.000Z");
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function marker(o: Partial<ActionRunRow> = {}): ActionRunRow {
  return {
    pipeline_run_id: RUN_A,
    action: PIPELINE_MARKER_ACTION,
    pipeline: "pipeline_0710",
    started_at: "2026-08-06T07:10:00.000Z",
    finished_at: "2026-08-06T07:20:00.000Z",
    ok: true,
    status: 200,
    ...o,
  };
}

Deno.test("binding: ultimo marker 0710 ok/2xx in finestra viene legato", () => {
  const r = bindAckToPipeline([marker()], STARTED);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.pipelineRunId, RUN_A);
});

Deno.test("binding: nessun marker canonico", () => {
  const r = bindAckToPipeline([], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_NOT_FOUND");
});

Deno.test("binding: civiko_pipeline_runs non è più la fonte (solo __pipeline__)", () => {
  const r = bindAckToPipeline([marker({ action: "recompute-contendibili" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_NOT_FOUND");
});

Deno.test("binding: l'ultimo tentativo fallito maschera un vecchio successo", () => {
  const r = bindAckToPipeline([
    marker({ pipeline_run_id: RUN_A, finished_at: "2026-08-06T05:00:00.000Z", ok: true }),
    marker({ pipeline_run_id: RUN_B, finished_at: "2026-08-06T07:20:00.000Z", ok: false, status: 504 }),
  ], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_FAILED");
});

Deno.test("binding: status non 2xx rifiutato anche con ok=true", () => {
  const r = bindAckToPipeline([marker({ status: 500 })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_FAILED");
});

Deno.test("binding: tentativo ancora in corso blocca l'ack", () => {
  const r = bindAckToPipeline([
    marker({ pipeline_run_id: RUN_A, finished_at: "2026-08-06T05:00:00.000Z" }),
    marker({ pipeline_run_id: RUN_B, started_at: "2026-08-06T07:25:00.000Z", finished_at: null, ok: null, status: null }),
  ], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_IN_PROGRESS");
});

Deno.test("binding: 0710 conclusa dopo lo started_at è superata", () => {
  const r = bindAckToPipeline([marker({ finished_at: "2026-08-06T07:32:00.000Z" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_SUPERSEDED");
});

Deno.test("binding: finished_at == started_at non è strettamente precedente", () => {
  const r = bindAckToPipeline([marker({ finished_at: "2026-08-06T07:30:00.000Z" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_SUPERSEDED");
});

Deno.test("binding: oltre 4 ore è stale", () => {
  const r = bindAckToPipeline([marker({ finished_at: "2026-08-06T02:00:00.000Z" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_STALE");
});

Deno.test("binding: altre pipeline sono ignorate", () => {
  const r = bindAckToPipeline([marker({ pipeline: "pipeline_0545" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_NOT_FOUND");
});

Deno.test("platform config: verify_jwt=false registrato per la funzione", async () => {
  const toml = await Deno.readTextFile(new URL("../../config.toml", import.meta.url));
  const idx = toml.indexOf("[functions.civiko-pwa-sync-ack]");
  assertEquals(idx > -1, true);
  const block = toml.slice(idx, idx + 200);
  assertEquals(/verify_jwt\s*=\s*false/.test(block), true);
});

Deno.test("auth: guard requireCivikoCostSecret prima di body e write", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("requireCivikoCostSecret"), true);
  assertEquals(src.includes("requireSecret(req"), false);
  const guard = src.indexOf("requireCivikoCostSecret(req");
  const body = src.indexOf("await req.text()");
  const write = src.indexOf("insertAck(");
  assertEquals(guard > -1 && body > guard, true);
  assertEquals(write > guard, true);
});

Deno.test("shared auth non modificata: nessuna nuova guard in _shared/http.ts", async () => {
  const shared = await Deno.readTextFile(new URL("../_shared/http.ts", import.meta.url));
  assertEquals(shared.includes("export function requireCivikoCostSecret"), true);
  // compat CORE_INTERNAL_SECRET già presente: non va reintrodotta né duplicata
  assertEquals(shared.split("requireCivikoCostSecret").length - 1 >= 1, true);
  assertEquals(shared.includes("CORE_INTERNAL_SECRET"), true);
});

Deno.test("persistenza immutabile: nessun upsert merge-duplicates", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("merge-duplicates"), false);
  assertEquals(src.includes("on_conflict"), false);
  assertEquals(src.includes("ACK_IMMUTABLE_CONFLICT"), true);
});

Deno.test("binding non legge più civiko_pipeline_runs", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("civiko_pipeline_runs"), false);
  assertEquals(src.includes("civiko_orchestrator_action_runs"), true);
});
