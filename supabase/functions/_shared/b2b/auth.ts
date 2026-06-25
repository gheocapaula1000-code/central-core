// b2b-finder dedicated auth helper.
// Constant-time comparison of x-internal-secret against B2B_FINDER_SECRET.

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: string };

export function authorizeB2BFinder(req: Request): AuthResult {
  const sourceApp = req.headers.get("x-source-app");
  if (sourceApp !== "b2b-finder") {
    return { ok: false, reason: "invalid x-source-app" };
  }
  const provided = req.headers.get("x-internal-secret") ?? "";
  const expected = Deno.env.get("B2B_FINDER_SECRET") ?? "";
  if (!expected) return { ok: false, reason: "server secret missing" };
  if (!provided) return { ok: false, reason: "missing x-internal-secret" };
  if (!constantTimeEqual(provided, expected)) {
    return { ok: false, reason: "bad secret" };
  }
  return { ok: true };
}
