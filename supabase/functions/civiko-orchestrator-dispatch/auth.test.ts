import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAuthorized } from "./auth.ts";

const DISPATCH = "dispatch-secret-value";
const JOB = "job-secret-value";

const h = (init: Record<string, string>) => new Headers(init);

Deno.test("bearer esistente resta valido", () => {
  assertEquals(
    isAuthorized(h({ Authorization: `Bearer ${DISPATCH}` }), DISPATCH, JOB),
    true,
  );
});

Deno.test("x-job-secret valido è accettato", () => {
  assertEquals(isAuthorized(h({ "x-job-secret": JOB }), DISPATCH, JOB), true);
});

Deno.test("header assente => non autorizzato", () => {
  assertEquals(isAuthorized(h({}), DISPATCH, JOB), false);
});

Deno.test("header errati => non autorizzato", () => {
  assertEquals(
    isAuthorized(h({ Authorization: "Bearer wrong", "x-job-secret": "wrong" }), DISPATCH, JOB),
    false,
  );
});

Deno.test("secret server vuoti non aprono bypass", () => {
  assertEquals(isAuthorized(h({ "x-job-secret": "" }), DISPATCH, ""), false);
  assertEquals(isAuthorized(h({ Authorization: "Bearer " }), "", JOB), false);
});
