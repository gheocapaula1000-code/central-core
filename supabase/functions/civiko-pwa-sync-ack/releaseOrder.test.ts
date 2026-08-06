import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateReleaseOrder,
  type PipelineAttempt,
} from "./releaseOrder.ts";

const D = "2026-08-07";
const at = (hhmm: string) => `${D}T${hhmm}:00.000Z`;

const pipe = (
  start: string,
  finish: string | null,
  ok: boolean | null = true,
  status: number | null = 200,
): PipelineAttempt => ({
  pipeline_run_id: `run-${start}`,
  started_at: at(start),
  finished_at: finish ? at(finish) : null,
  ok,
  status,
});

// Sequenza reale corretta: 05:10 -> 05:45 -> 07:10 -> sync 07:25 -> gate 07:45
const happy = {
  p0510: pipe("05:10", "05:38"),
  p0545: pipe("05:45", "06:40"),
  p0710: pipe("07:10", "07:22"),
  ack: { started_at: at("07:25"), finished_at: at("07:26") },
  checked_at: at("07:45"),
};

Deno.test("sequenza rollout corretta => pass", () => {
  assertEquals(evaluateReleaseOrder(happy), { ok: true, reason: "OK" });
});

Deno.test("gate non richiede pipeline_run_id condiviso col 0710", () => {
  // il gate è un job separato: nessun run id in input, solo ordine temporale
  const r = evaluateReleaseOrder({ ...happy, checked_at: at("07:30") });
  assertEquals(r.ok, true);
});

Deno.test("overlap 0510/0545 => reject", () => {
  const r = evaluateReleaseOrder({ ...happy, p0510: pipe("05:10", "05:50") });
  assertEquals(r, { ok: false, reason: "OVERLAP_0510_0545" });
});

Deno.test("overlap 0545/0710 => reject", () => {
  const r = evaluateReleaseOrder({ ...happy, p0545: pipe("05:45", "07:15") });
  assertEquals(r, { ok: false, reason: "OVERLAP_0545_0710" });
});

Deno.test("ack iniziato prima della fine del 0710 => reject", () => {
  const r = evaluateReleaseOrder({
    ...happy,
    ack: { started_at: at("07:20"), finished_at: at("07:26") },
  });
  assertEquals(r, { ok: false, reason: "ACK_BEFORE_0710_END" });
});

Deno.test("finestra ack invertita => reject", () => {
  const r = evaluateReleaseOrder({
    ...happy,
    ack: { started_at: at("07:27"), finished_at: at("07:26") },
  });
  assertEquals(r, { ok: false, reason: "ACK_WINDOW_INVALID" });
});

Deno.test("ack conclusa dopo il checked_at del gate => reject", () => {
  const r = evaluateReleaseOrder({ ...happy, checked_at: at("07:25") });
  assertEquals(r, { ok: false, reason: "ACK_AFTER_CHECK" });
});

Deno.test("latest 0545 in-progress maschera successi precedenti", () => {
  const r = evaluateReleaseOrder({ ...happy, p0545: pipe("05:45", null, null, null) });
  assertEquals(r, { ok: false, reason: "PIPELINE_0545_NOT_OK" });
});

Deno.test("latest 0710 fallito maschera successi precedenti", () => {
  const r = evaluateReleaseOrder({ ...happy, p0710: pipe("07:10", "07:20", false, 500) });
  assertEquals(r, { ok: false, reason: "PIPELINE_0710_NOT_OK" });
});

Deno.test("latest 0510 fallito => reject", () => {
  const r = evaluateReleaseOrder({ ...happy, p0510: pipe("05:10", "05:20", false, 200) });
  assertEquals(r, { ok: false, reason: "PIPELINE_0510_NOT_OK" });
});

Deno.test("ack assente => reject", () => {
  const r = evaluateReleaseOrder({ ...happy, ack: null });
  assertEquals(r, { ok: false, reason: "ACK_MISSING" });
});

// ── ADDENDUM release-window: finestra interna STRETTA per ogni attempt ──
// Il solo parsing dei due timestamp non basta: serve started_at < finished_at.

const badWindows: Array<[string, string | null, string | null]> = [
  ["invertita", "05:38", "05:10"],
  ["uguale", "05:10", "05:10"],
  ["finished mancante", "05:10", null],
  ["started mancante", null, "05:38"],
  ["entrambi mancanti", null, null],
];

for (const [label, s, f] of badWindows) {
  Deno.test(`0510 finestra ${label} => reject`, () => {
    const p: PipelineAttempt = {
      pipeline_run_id: "r",
      started_at: s ? at(s) : null,
      finished_at: f ? at(f) : null,
      ok: true,
      status: 200,
    };
    const r = evaluateReleaseOrder({ ...happy, p0510: p });
    assertEquals(r.ok, false);
  });

  Deno.test(`0545 finestra ${label} => reject`, () => {
    const p: PipelineAttempt = {
      pipeline_run_id: "r",
      started_at: s ? at(s) : null,
      finished_at: f ? at(f) : null,
      ok: true,
      status: 200,
    };
    const r = evaluateReleaseOrder({ ...happy, p0545: p });
    assertEquals(r.ok, false);
  });

  Deno.test(`0710 finestra ${label} => reject`, () => {
    const p: PipelineAttempt = {
      pipeline_run_id: "r",
      started_at: s ? at(s) : null,
      finished_at: f ? at(f) : null,
      ok: true,
      status: 200,
    };
    const r = evaluateReleaseOrder({ ...happy, p0710: p });
    assertEquals(r.ok, false);
  });

  Deno.test(`ack finestra ${label} => reject`, () => {
    const r = evaluateReleaseOrder({
      ...happy,
      p0710: pipe("04:00", "04:30"),
      ack: { started_at: s ? at(s) : null, finished_at: f ? at(f) : null },
    });
    assertEquals(r.ok, false);
  });
}

Deno.test("timestamp pipeline non parsabile => reject", () => {
  const bad: PipelineAttempt = {
    pipeline_run_id: "r",
    started_at: "non-una-data",
    finished_at: at("05:38"),
    ok: true,
    status: 200,
  };
  assertEquals(evaluateReleaseOrder({ ...happy, p0545: bad }).ok, false);
  assertEquals(evaluateReleaseOrder({ ...happy, p0510: bad }).ok, false);
  assertEquals(evaluateReleaseOrder({ ...happy, p0710: bad }).ok, false);
});

Deno.test("ack con timestamp non parsabile => reject", () => {
  const r = evaluateReleaseOrder({
    ...happy,
    ack: { started_at: at("07:25"), finished_at: "07:26" },
  });
  assertEquals(r.ok, false);
});

Deno.test("checked_at mancante/invalido => reject", () => {
  for (const c of ["", "non-una-data", "NaN"]) {
    const r = evaluateReleaseOrder({ ...happy, checked_at: c });
    assertEquals(r, { ok: false, reason: "CHECKED_AT_INVALID" });
  }
});

Deno.test("checked_at uguale alla fine ack => reject (serve strettamente dopo)", () => {
  const r = evaluateReleaseOrder({ ...happy, checked_at: at("07:26") });
  assertEquals(r, { ok: false, reason: "ACK_AFTER_CHECK" });
});

Deno.test("finestre interne valide + ordine cross-run mantenuto => pass", () => {
  assertEquals(evaluateReleaseOrder(happy), { ok: true, reason: "OK" });
});
