// v3.3.0
// health check endpoint — Central Core v3
// Uses shared CORS whitelist from _shared/http.ts
// redeploy sottra-cors

import { handleOptions, ok, CORE_VERSION } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  return ok(req, {
    status: "healthy",
    version: CORE_VERSION,
    time: new Date().toISOString(),
  });
});
