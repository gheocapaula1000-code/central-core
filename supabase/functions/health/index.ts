// health check endpoint — Central Core V3
// Checkpoint 1A: public but STRICTLY PASSIVE.
// - No secret names / presence, no version, no provider status.
// - No external calls, no provider key reads, no logging of secret presence.
// - Legacy provider-probe query flags are ignored (no side effects).

import { handleOptions, ok, fail, CORE_CONTRACT, addIdentityHeaders, buildManifest, makeDebugId } from "../_shared/http.ts";

const FUNCTION_NAME = "health";
const EXPECTED_BASE_PATH = "/functions/v1/health";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  if (req.method !== "GET" && req.method !== "HEAD") {
    return fail(req, 405, "METHOD_NOT_ALLOWED", "Method not allowed", makeDebugId());
  }

  const url = new URL(req.url);

  // Manifest endpoint — passive, no sensitive data.
  if (url.pathname.endsWith("/manifest")) {
    const manifest = buildManifest({
      functionName: FUNCTION_NAME,
      serviceKind: "global-health-probe",
      expectedBasePath: EXPECTED_BASE_PATH,
      routes: ["GET /", "GET /manifest"],
      callingMode: "direct",
    });
    const res = ok(req, manifest);
    return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "manifest" });
  }

  const res = ok(req, {
    ok: true,
    service: "central-core",
    status: "healthy",
    contract: CORE_CONTRACT,
    function: FUNCTION_NAME,
  });
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "health" });
});
