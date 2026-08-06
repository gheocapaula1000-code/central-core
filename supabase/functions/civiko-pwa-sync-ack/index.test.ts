// Test della validazione ack sync PWA Civiko — nessuna rete, nessun provider.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PADOVA_ZONE_SLUGS,
  REQUIRED_COUNT_KEYS,
  validateAck,
} from "./validation.ts";

function fullCounts(over: Record<string, number> = {}) {
  const c: Record<string, number> = {};
  for (const k of REQUIRED_COUNT_KEYS) c[k] = 3;
  return { ...c, ...over };
}

const NOW = Date.parse("2026-08-06T07:20:00.000Z");

function base(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "0f6b1e2c-8f4a-4c1e-9a2b-7d3f5c6a1b2e",
    started_at: "2026-08-06T07:10:00.000Z",
    finished_at: "2026-08-06T07:15:00.000Z",
    ok: true,
    counts: fullCounts(),
    scope_comune: "Padova",
    scope_slugs: [...PADOVA_ZONE_SLUGS],
    ...overrides,
  };
}

Deno.test("ack valido viene normalizzato", () => {
  const r = validateAck(base(), "civiko", NOW);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.record.scope_comune, "Padova");
    assertEquals(r.record.scope_slugs.length, 8);
    assertEquals(r.record.source_app, "civiko");
    assertEquals(r.record.idempotency_key, "0f6b1e2c-8f4a-4c1e-9a2b-7d3f5c6a1b2e");
    assertEquals(r.record.error_code, null);
  }
});

Deno.test("run_id non UUID rifiutato", () => {
  const r = validateAck(base({ run_id: "run-123" }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "RUN_ID_INVALID");
});

Deno.test("ok non booleano rifiutato", () => {
  const r = validateAck(base({ ok: "true" }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "OK_INVALID");
});

Deno.test("comune diverso da Padova rifiutato", () => {
  const r = validateAck(base({ scope_comune: "Venezia" }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SCOPE_COMUNE_INVALID");
});

Deno.test("slug fuori dalle 8 zone rifiutato", () => {
  const bad = [...PADOVA_ZONE_SLUGS.slice(0, 7), "mestre"];
  const r = validateAck(base({ scope_slugs: bad }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SCOPE_SLUGS_INVALID");
});

Deno.test("slug duplicati rifiutati", () => {
  const r = validateAck(
    base({ scope_slugs: [...PADOVA_ZONE_SLUGS.slice(0, 7), "centro-storico"] }),
    "civiko",
    NOW,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SCOPE_SLUGS_INVALID");
});

Deno.test("timestamp nel futuro oltre tolleranza rifiutato", () => {
  const r = validateAck(
    base({ started_at: "2026-08-06T09:00:00.000Z", finished_at: "2026-08-06T09:10:00.000Z" }),
    "civiko",
    NOW,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "TIMESTAMP_WINDOW_INVALID");
});

Deno.test("timestamp troppo vecchio rifiutato", () => {
  const r = validateAck(
    base({ started_at: "2026-08-01T07:00:00.000Z", finished_at: "2026-08-01T07:05:00.000Z" }),
    "civiko",
    NOW,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "TIMESTAMP_WINDOW_INVALID");
});

Deno.test("finished precedente a started rifiutato", () => {
  const r = validateAck(
    base({ started_at: "2026-08-06T07:15:00.000Z", finished_at: "2026-08-06T07:10:00.000Z" }),
    "civiko",
    NOW,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "TIMESTAMP_ORDER_INVALID");
});

Deno.test("ok=false richiede error_code", () => {
  const r = validateAck(base({ ok: false }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ACK_INCOHERENT");
});

Deno.test("ok=true con error_code rifiutato", () => {
  const r = validateAck(base({ error_code: "SYNC_FAILED" }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ACK_INCOHERENT");
});

Deno.test("ack fallito con error_code valido accettato", () => {
  const r = validateAck(base({ ok: false, error_code: "SYNC_FAILED" }), "civiko-one", NOW);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.record.ok, false);
    assertEquals(r.record.error_code, "SYNC_FAILED");
  }
});

Deno.test("campi extra rifiutati", () => {
  const r = validateAck(base({ zone_slug: "centro-storico" }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "UNKNOWN_FIELD");
});

Deno.test("counts non interi rifiutati", () => {
  const r = validateAck(base({ counts: fullCounts({ privati: -1 }) }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "COUNTS_INVALID");
});

Deno.test("counts con chiave mancante rifiutati", () => {
  const c = fullCounts();
  delete (c as Record<string, number>).quartieri;
  const r = validateAck(base({ counts: c }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "COUNTS_MISSING_KEY");
});

Deno.test("counts assenti rifiutati", () => {
  const b = base();
  delete (b as Record<string, unknown>).counts;
  const r = validateAck(b, "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "COUNTS_INVALID");
});

Deno.test("counts tutti a zero ammessi", () => {
  const zero: Record<string, number> = {};
  for (const k of REQUIRED_COUNT_KEYS) zero[k] = 0;
  const r = validateAck(base({ counts: zero }), "civiko", NOW);
  assertEquals(r.ok, true);
});

Deno.test("counts con chiave sconosciuta rifiutati", () => {
  const r = validateAck(base({ counts: fullCounts({ aste: 1 }) }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "COUNTS_INVALID");
});

Deno.test("7 zone su 9 rifiutate: servono esattamente le 8 ufficiali", () => {
  const r = validateAck(base({ scope_slugs: PADOVA_ZONE_SLUGS.slice(0, 7) }), "civiko", NOW);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SCOPE_SLUGS_INVALID");
});

Deno.test("pipeline_run_id inviato dalla PWA rifiutato", () => {
  const r = validateAck(
    base({ pipeline_run_id: "11111111-1111-4111-8111-111111111111" }),
    "civiko",
    NOW,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "UNKNOWN_FIELD");
});

Deno.test("idempotenza: stesso payload produce lo stesso record", () => {
  const a = validateAck(base(), "civiko", NOW);
  const b = validateAck(base(), "civiko", NOW);
  assertEquals(a.ok && b.ok, true);
  if (a.ok && b.ok) assertEquals(JSON.stringify(a.record), JSON.stringify(b.record));
});

Deno.test("idempotency_key esplicita conservata", () => {
  const r = validateAck(base({ idempotency_key: "pipeline_0710:2026-08-06" }), "civiko", NOW);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.record.idempotency_key, "pipeline_0710:2026-08-06");
});

Deno.test("payload non oggetto rifiutato", () => {
  assertEquals(validateAck(null, "civiko", NOW).ok, false);
  assertEquals(validateAck([], "civiko", NOW).ok, false);
});
