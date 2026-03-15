// v3.3.1
// health check endpoint — Central Core V3
// Public — no auth required

import { handleOptions, ok, CORE_VERSION } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  return ok(req, {
    status: "healthy",
    version: CORE_VERSION,
    time: new Date().toISOString(),
  });
});
