import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Contratto statico: la view live del release gate deve imporre la finestra
// interna STRETTA su ogni latest attempt (started_at < finished_at) e un
// checked_at finito strettamente successivo a ack.finished_at.
const sql = await Deno.readTextFile(
  new URL(
    "../../migrations/20260806194900_civiko_release_gate_strict_windows.sql",
    import.meta.url,
  ),
);

const strictWindow = (alias: string) =>
  `(${alias}.started_at IS NOT NULL AND ${alias}.finished_at IS NOT NULL AND ${alias}.started_at < ${alias}.finished_at)`;

for (const alias of ["pipe0510", "pipe0545", "pipe"]) {
  Deno.test(`view: finestra interna stretta per ${alias}`, () => {
    assertEquals(sql.includes(strictWindow(alias)), true);
  });
}

Deno.test("view: finestra ack stretta e non nulla", () => {
  assertEquals(sql.includes("AND a.started_at IS NOT NULL AND a.finished_at IS NOT NULL"), true);
  assertEquals(sql.includes("AND a.finished_at > a.started_at"), true);
  assertEquals(sql.includes("AND ack.started_at < ack.finished_at"), true);
});

Deno.test("view: checked_at finito e strettamente dopo la fine ack", () => {
  assertEquals(sql.includes("AND now() IS NOT NULL AND ack.finished_at < now()"), true);
});

Deno.test("view: ordine cross-run preesistente mantenuto", () => {
  assertEquals(sql.includes("AND pipe0510.finished_at < pipe0545.started_at"), true);
  assertEquals(sql.includes("AND pipe0545.finished_at < pipe.started_at"), true);
  assertEquals(sql.includes("AND pipe.finished_at < ack.started_at"), true);
});
