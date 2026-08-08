import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCollectPendingBody,
  extractCollectScope,
} from "../_shared/civikoCollectScope.ts";
import {
  evaluatePhotoPerimeter,
  PHOTO_BATCH_MAX_INVOCATIONS,
  PHOTO_ROUTINE_PERIMETER,
} from "../_shared/civikoPhotoPerimeter.ts";

const CAPPED_LAUNCH_RESULT = {
  ok: true,
  started_count: 4,
  per_portal_estimates: [{}, {}, {}, {}],
  runs: [
    { portal: "immobiliare", run_id: "RUN_IMMO_NEW", dataset_id: "DS1" },
    { portal: "idealista", run_id: "RUN_IDEA_NEW", dataset_id: "DS2" },
    { portal: "subito_full", run_id: "RUN_SUB_NEW", dataset_id: "DS3" },
  ],
};

Deno.test("scope: estrae gli esatti run_id del 05:10 corrente", () => {
  const scope = extractCollectScope(CAPPED_LAUNCH_RESULT, "2026-08-08T05:10:00.000Z");
  assertEquals(scope.run_ids.sort(), ["RUN_IDEA_NEW", "RUN_IMMO_NEW", "RUN_SUB_NEW"]);
  assertEquals(scope.by_portal.subito, ["RUN_SUB_NEW"]);
  assert(scope.complete);
});

Deno.test("anti-starvation: i run storici non entrano nel perimetro corrente", () => {
  const scope = extractCollectScope(CAPPED_LAUNCH_RESULT, "2026-08-08T05:10:00.000Z");
  const body = buildCollectPendingBody({ max_runs: 10 }, scope) as Record<string, unknown>;
  const runIds = body.run_ids as string[];
  // Nessuno dei residui storici globali (i piu' vecchi per started_at) puo'
  // essere selezionato: la Edge riceve run_id espliciti.
  for (const historical of ["OLD_RUN_1", "OLD_RUN_2", "OLD_RUN_3"]) {
    assert(!runIds.includes(historical));
  }
  assertEquals(runIds.length, 3);
  assertEquals(body.quarantine_stale, true);
  assertEquals(body.scope_started_after, "2026-08-08T05:10:00.000Z");
  assertEquals(body.max_runs, 10);
});

Deno.test("scope incompleto: nessuna invenzione di run_id", () => {
  const scope = extractCollectScope({ ok: true, runs: [] }, null);
  assertEquals(scope.run_ids, []);
  assertEquals(scope.complete, false);
  const body = buildCollectPendingBody({}, scope) as Record<string, unknown>;
  assertEquals(body.run_ids, undefined);
  assertEquals(body.scope_complete, false);
  assertEquals(body.quarantine_stale, true);
});

Deno.test("foto: il perimetro di routine e' 24 elementi, non l'intera coda", () => {
  assertEquals(PHOTO_ROUTINE_PERIMETER, 24);
  const batches = Array.from({ length: PHOTO_BATCH_MAX_INVOCATIONS }, () => ({
    ok: true,
    processed: 4,
    remaining: 707,
    remaining_exact: true,
    queue_complete: false,
  }));
  const state = evaluatePhotoPerimeter(batches);
  assert(state.perimeter_complete, "il perimetro corrente deve risultare coperto");
  assertEquals(state.processed, 24);
  assertEquals(state.backlog_remaining, 707);
  assertEquals(state.backlog_status, "in_progress");
  assert(state.backlog_progress_pct !== null && state.backlog_progress_pct < 100);
});

Deno.test("foto: coda svuotata => backlog vuoto e progresso 100", () => {
  const state = evaluatePhotoPerimeter([
    { ok: true, processed: 4, remaining: 0, remaining_exact: true, queue_complete: true },
  ]);
  assert(state.perimeter_complete);
  assertEquals(state.backlog_remaining, 0);
  assertEquals(state.backlog_status, "empty");
  assertEquals(state.backlog_progress_pct, 100);
});

Deno.test("foto: un batch fallito non puo' certificare il perimetro", () => {
  const state = evaluatePhotoPerimeter([
    { ok: true, processed: 4, remaining: 700, remaining_exact: true, queue_complete: false },
    { ok: false, processed: 0, remaining: 700, remaining_exact: true, queue_complete: false },
  ]);
  assertEquals(state.perimeter_complete, false);
});

Deno.test("foto: nessun batch eseguito => nessun falso verde", () => {
  const state = evaluatePhotoPerimeter([]);
  assertEquals(state.perimeter_complete, false);
  assertEquals(state.backlog_status, "unknown");
});

Deno.test("foto: residuo non esatto resta backlog sconosciuto, mai vuoto", () => {
  const state = evaluatePhotoPerimeter(
    Array.from({ length: PHOTO_BATCH_MAX_INVOCATIONS }, () => ({
      ok: true,
      processed: 4,
      remaining: 500,
      remaining_exact: false,
      queue_complete: false,
    })),
  );
  assert(state.perimeter_complete);
  assertEquals(state.backlog_status, "unknown");
});
