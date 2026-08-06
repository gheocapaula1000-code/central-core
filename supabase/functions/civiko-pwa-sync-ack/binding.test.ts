// Test statici del binding server-side ack ↔ pipeline_0710 (nessuna rete).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bindAckToPipeline, type PipelineRunRow } from "./binding.ts";

const STARTED = Date.parse("2026-08-06T07:10:00.000Z");

function run(o: Partial<PipelineRunRow>): PipelineRunRow {
  return {
    run_id: "11111111-1111-4111-8111-111111111111",
    pipeline: "pipeline_0710",
    finished_at: "2026-08-06T07:00:00.000Z",
    ok: true,
    ...o,
  };
}

Deno.test("binding: ultima 0710 ok in finestra viene legata", () => {
  const r = bindAckToPipeline([run({})], STARTED);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.pipelineRunId, "11111111-1111-4111-8111-111111111111");
});

Deno.test("binding: nessuna 0710 conclusa", () => {
  const r = bindAckToPipeline([], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_NOT_FOUND");
});

Deno.test("binding: l'ultima fallita blocca un vecchio successo", () => {
  const r = bindAckToPipeline([
    run({ run_id: "22222222-2222-4222-8222-222222222222", finished_at: "2026-08-06T05:00:00.000Z", ok: true }),
    run({ run_id: "33333333-3333-4333-8333-333333333333", finished_at: "2026-08-06T07:00:00.000Z", ok: false }),
  ], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_FAILED");
});

Deno.test("binding: 0710 più recente dello started_at è mismatch", () => {
  const r = bindAckToPipeline([run({ finished_at: "2026-08-06T07:12:00.000Z" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_SUPERSEDED");
});

Deno.test("binding: pipeline oltre 4 ore è stale", () => {
  const r = bindAckToPipeline([run({ finished_at: "2026-08-06T02:00:00.000Z" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_STALE");
});

Deno.test("binding: altre pipeline sono ignorate", () => {
  const r = bindAckToPipeline([run({ pipeline: "pipeline_0545" })], STARTED);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "PIPELINE_RUN_NOT_FOUND");
});

Deno.test("platform config: verify_jwt=false registrato per la funzione", async () => {
  const toml = await Deno.readTextFile(
    new URL("../../config.toml", import.meta.url),
  );
  const idx = toml.indexOf("[functions.civiko-pwa-sync-ack]");
  assertEquals(idx > -1, true);
  const block = toml.slice(idx, idx + 200);
  assertEquals(/verify_jwt\s*=\s*false/.test(block), true);
});

Deno.test("auth fail-closed: guard applicativa presente nella funzione", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("requireSecret"), true);
  assertEquals(src.includes("CIVIKO_SOURCE_APPS.has(sourceApp)"), true);
  // Il client non può dichiarare la pipeline: solo binding server-side.
  assertEquals(src.includes("bindAckToPipeline"), true);
  assertEquals(/b\.pipeline_run_id/.test(src), false);
});
