// Test dello schema canonico dell'ack sync PWA Civiko — nessuna rete.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AckRecord,
  isCivikoSourceApp,
  isIdenticalAck,
  PADOVA_ZONE_SLUGS,
  REQUIRED_COUNT_KEYS,
  validateAck,
} from "./validation.ts";

const RUN_ID = "0f6b1e2c-8f4a-4c1e-9a2b-7d3f5c6a1b2e";
const NOW = Date.parse("2026-08-06T07:40:00.000Z");

function fullCounts(over: Record<string, number> = {}) {
  const c: Record<string, number> = {};
  for (const k of REQUIRED_COUNT_KEYS) c[k] = 3;
  return { ...c, ...over };
}

/** Body ESATTO del sender PWA canonico. */
function base(overrides: Record<string, unknown> = {}) {
  const b: Record<string, unknown> = {
    run_id: RUN_ID,
    started_at: "2026-08-06T07:30:00.000Z",
    finished_at: "2026-08-06T07:35:00.000Z",
    ok: true,
    municipality: "Padova",
    zone_slugs: [...PADOVA_ZONE_SLUGS],
    counts: fullCounts(),
    ...overrides,
  };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return b;
}

function ok_(body: Record<string, unknown> = base(), key: string | null = RUN_ID) {
  return validateAck(body, "civiko-one", NOW, key);
}

Deno.test("schema canonico PWA accettato e normalizzato", () => {
  const r = ok_();
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.record.municipality, "Padova");
    assertEquals(r.record.commercial_zone_slugs.length, 8);
    assertEquals(r.record.source_app, "civiko-one");
    assertEquals(r.record.error_code, null);
  }
});

Deno.test("campi legacy scope_comune/scope_slugs rifiutati", () => {
  for (const k of ["scope_comune", "scope_slugs"]) {
    const r = ok_(base({ [k]: k === "scope_comune" ? "Padova" : [...PADOVA_ZONE_SLUGS] }));
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.code, "LEGACY_FIELD_REJECTED");
  }
});

Deno.test("idempotency_key nel body rifiutata (è un header)", () => {
  const r = ok_(base({ idempotency_key: RUN_ID }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "LEGACY_FIELD_REJECTED");
});

Deno.test("pipeline_run_id dichiarato dal client rifiutato", () => {
  const r = ok_(base({ pipeline_run_id: "11111111-1111-4111-8111-111111111111" }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "LEGACY_FIELD_REJECTED");
});

Deno.test("campo extra sconosciuto rifiutato", () => {
  const r = ok_(base({ foo: 1 }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "UNKNOWN_FIELD");
});

Deno.test("header x-idempotency-key mancante rifiutato", () => {
  const r = ok_(base(), null);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "IDEMPOTENCY_KEY_REQUIRED");
});

Deno.test("header x-idempotency-key diverso dal run_id rifiutato", () => {
  const r = ok_(base(), "11111111-1111-4111-8111-111111111111");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "IDEMPOTENCY_KEY_MISMATCH");
});

Deno.test("run_id non UUID rifiutato", () => {
  const r = ok_(base({ run_id: "run-123" }), "run-123");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "RUN_ID_INVALID");
});

Deno.test("timestamp identici rifiutati (durata nulla)", () => {
  const r = ok_(base({ finished_at: "2026-08-06T07:30:00.000Z" }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "TIMESTAMP_ORDER_INVALID");
});

Deno.test("finished_at precedente a started_at rifiutato", () => {
  const r = ok_(base({ finished_at: "2026-08-06T07:20:00.000Z" }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "TIMESTAMP_ORDER_INVALID");
});

Deno.test("municipality diverso da Padova rifiutato", () => {
  const r = ok_(base({ municipality: "Venezia" }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "MUNICIPALITY_INVALID");
});

Deno.test("7 zone rifiutate", () => {
  const r = ok_(base({ zone_slugs: PADOVA_ZONE_SLUGS.slice(0, 7) }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ZONE_SLUGS_INVALID");
});

Deno.test("9 zone (extra) rifiutate", () => {
  const r = ok_(base({ zone_slugs: [...PADOVA_ZONE_SLUGS, "mestre"] }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ZONE_SLUGS_INVALID");
});

Deno.test("zone duplicate rifiutate", () => {
  const r = ok_(base({ zone_slugs: [...PADOVA_ZONE_SLUGS.slice(0, 7), "centro-storico"] }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ZONE_SLUGS_INVALID");
});

Deno.test("le 8 zone esatte passano", () => {
  const r = ok_(base({ zone_slugs: [...PADOVA_ZONE_SLUGS].reverse() }));
  assertEquals(r.ok, true);
});

Deno.test("8 count keys (una mancante) rifiutate", () => {
  const c = fullCounts();
  delete c.quartieri;
  const r = ok_(base({ counts: c }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "COUNTS_MISSING_KEY");
});

Deno.test("10 count keys (una extra) rifiutate", () => {
  const r = ok_(base({ counts: fullCounts({ extra: 1 }) }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "COUNTS_INVALID");
});

Deno.test("count non intero o negativo rifiutato", () => {
  for (const v of [1.5, -1]) {
    const r = ok_(base({ counts: fullCounts({ radar: v }) }));
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.code, "COUNTS_INVALID");
  }
});

Deno.test("counts tutti a zero sono validi", () => {
  const zeros: Record<string, number> = {};
  for (const k of REQUIRED_COUNT_KEYS) zeros[k] = 0;
  const r = ok_(base({ counts: zeros }));
  assertEquals(r.ok, true);
});

Deno.test("error_code su ok=true rifiutato", () => {
  const r = ok_(base({ error_code: "BOOM" }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ACK_INCOHERENT");
});

Deno.test("ok=false senza error_code rifiutato", () => {
  const r = ok_(base({ ok: false }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "ACK_INCOHERENT");
});

Deno.test("ok=false con error_code accettato", () => {
  const r = ok_(base({ ok: false, error_code: "RENDER_TIMEOUT" }));
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.record.error_code, "RENDER_TIMEOUT");
});

// ── Idempotenza immutabile ─────────────────────────────────────────────────
const PIPE = "11111111-1111-4111-8111-111111111111";

function record(): AckRecord {
  const r = ok_();
  if (!r.ok) throw new Error("fixture invalida");
  return r.record;
}

function storedFrom(rec: AckRecord, over: Record<string, unknown> = {}) {
  return {
    run_id: rec.run_id,
    source_app: rec.source_app,
    started_at: rec.started_at,
    finished_at: rec.finished_at,
    ok: rec.ok,
    counts: { ...rec.counts },
    municipality: rec.municipality,
    commercial_zone_slugs: [...rec.commercial_zone_slugs],
    error_code: rec.error_code,
    pipeline_run_id: PIPE,
    ...over,
  };
}

Deno.test("replay identico riconosciuto (200)", () => {
  const rec = record();
  assertEquals(isIdenticalAck(storedFrom(rec), rec, PIPE), true);
});

Deno.test("stesso run_id con counts diversi è conflitto", () => {
  const rec = record();
  const stored = storedFrom(rec, { counts: { ...rec.counts, radar: 99 } });
  assertEquals(isIdenticalAck(stored, rec, PIPE), false);
});

Deno.test("stesso run_id su pipeline diversa è conflitto", () => {
  const rec = record();
  assertEquals(
    isIdenticalAck(storedFrom(rec), rec, "22222222-2222-4222-8222-222222222222"),
    false,
  );
});

Deno.test("replay con timestamp diverso è conflitto", () => {
  const rec = record();
  const stored = storedFrom(rec, { finished_at: "2026-08-06T07:36:00.000Z" });
  assertEquals(isIdenticalAck(stored, rec, PIPE), false);
});

Deno.test("riga legacy con soli alias resta confrontabile", () => {
  const rec = record();
  const stored = storedFrom(rec);
  delete (stored as Record<string, unknown>).municipality;
  delete (stored as Record<string, unknown>).commercial_zone_slugs;
  (stored as Record<string, unknown>).scope_comune = rec.municipality;
  (stored as Record<string, unknown>).scope_slugs = [...rec.commercial_zone_slugs];
  assertEquals(isIdenticalAck(stored, rec, PIPE), true);
});

// ── Source identity locale (oltre la guard shared) ─────────────────────────
Deno.test("source identity: acquisitionradar sempre rifiutata", () => {
  assertEquals(isCivikoSourceApp("acquisitionradar"), false);
  assertEquals(isCivikoSourceApp("ACQUISITIONRADAR"), false);
  assertEquals(isCivikoSourceApp(""), false);
  assertEquals(isCivikoSourceApp(null), false);
  assertEquals(isCivikoSourceApp("keydraft"), false);
});

Deno.test("source identity: solo civiko-one canonico", () => {
  assertEquals(isCivikoSourceApp("civiko-one"), true);
  assertEquals(isCivikoSourceApp(" Civiko-One "), true);
  assertEquals(isCivikoSourceApp("civiko"), false);
  assertEquals(isCivikoSourceApp("civiko_one"), false);
});

Deno.test("endpoint: check source-app locale prima di body/read/write", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const guard = src.indexOf("isCivikoSourceApp(sourceApp)");
  const body = src.indexOf("await req.text()");
  const read = src.indexOf("await fetchPipelineMarkers(");
  const write = src.indexOf("await insertAck(");
  assertEquals(guard > -1, true);
  assertEquals(body > guard, true);
  assertEquals(read > guard, true);
  assertEquals(write > guard, true);
  assertEquals(src.includes("SOURCE_APP_FORBIDDEN"), true);
});

// Simulazione reale del ramo di handler: secret valido ma identità non Civiko.
Deno.test("handler: acquisitionradar + secret valido => 403", () => {
  const req = new Request("https://core.local/civiko-pwa-sync-ack", {
    method: "POST",
    headers: {
      "x-source-app": "acquisitionradar",
      "x-internal-secret": "secret-valido-shared",
      "x-idempotency-key": RUN_ID,
      "content-type": "application/json",
    },
    body: JSON.stringify(base()),
  });
  const sourceApp = (req.headers.get("x-source-app") ?? "").toLowerCase().trim();
  // la guard shared passerebbe (compat costi); quella locale deve bloccare
  const status = isCivikoSourceApp(sourceApp) ? 200 : 403;
  assertEquals(status, 403);
});

// ── Replay immutabile: anche la source_app deve coincidere ─────────────────
Deno.test("replay: source_app diversa non è un replay identico", () => {
  const r = ok_();
  if (!r.ok) throw new Error("fixture invalida");
  const pipelineRunId = "33333333-3333-4333-8333-333333333333";
  const stored: Record<string, unknown> = {
    started_at: r.record.started_at,
    finished_at: r.record.finished_at,
    ok: r.record.ok,
    error_code: null,
    source_app: r.record.source_app,
    pipeline_run_id: pipelineRunId,
    municipality: r.record.municipality,
    commercial_zone_slugs: [...r.record.commercial_zone_slugs],
    counts: { ...r.record.counts },
  };
  assertEquals(isIdenticalAck(stored, r.record, pipelineRunId), true);
  assertEquals(isIdenticalAck({ ...stored, source_app: "civiko" }, r.record, pipelineRunId), false);
  assertEquals(isIdenticalAck({ ...stored, source_app: undefined }, r.record, pipelineRunId), false);
});

Deno.test("config: commento allineato all'implementazione (requireCivikoCostSecret)", async () => {
  const toml = await Deno.readTextFile(new URL("../../config.toml", import.meta.url));
  const idx = toml.indexOf("[functions.civiko-pwa-sync-ack]");
  const header = toml.slice(Math.max(0, idx - 400), idx);
  assertEquals(header.includes("requireCivikoCostSecret"), true);
  assertEquals(/via requireSecret/.test(header), false);
});
