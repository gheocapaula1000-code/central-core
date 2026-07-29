// secret-fingerprint — NEUTRALIZED (Checkpoint 1A tombstone).
//
// This endpoint previously exposed secret presence, length, prefix and suffix
// (including a full anon key) behind a hard-coded token. It is permanently
// disabled. No secret is read, no fingerprint is produced, no secret name is
// returned. Do not recreate equivalent functionality anywhere else.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  return new Response(JSON.stringify({ ok: false, error: { code: "GONE", message: "Endpoint removed" } }), {
    status: 410,
    headers: { ...CORS, "content-type": "application/json" },
  });
});
