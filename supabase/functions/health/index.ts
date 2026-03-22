// v3.3.5
// health check endpoint — Central Core V3
// Public — no auth required. Minimal response, no version leak.

import { handleOptions, ok, CORE_CONTRACT, addIdentityHeaders, buildManifest } from "../_shared/http.ts";

const FUNCTION_NAME = "health";
const EXPECTED_BASE_PATH = "/functions/v1/health";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const pathname = new URL(req.url).pathname;

  // Manifest endpoint
  if (req.method === "GET" && pathname.endsWith("/manifest")) {
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
    status: "healthy",
    contract: CORE_CONTRACT,
    function: FUNCTION_NAME,
  });
  return addIdentityHeaders(res, { function: FUNCTION_NAME, route: "health" });
});
