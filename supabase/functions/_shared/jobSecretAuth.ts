// Server-to-server job auth used by pg_cron (log_cron_http_invocation),
// the orchestrator, and commissioning. Accepts the headers actually sent
// in production. Never reads the secret from body or query string.
// JWT bearers (eyJ…) are ignored so an anon/service gateway token is not
// treated as CENTRAL_CORE_JOB_SECRET.

export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isLikelyJwt(token: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(token);
}

/** First non-empty job secret from the headers used by live Core callers. */
export function readIncomingJobSecret(headers: {
  get(name: string): string | null;
}): string {
  const job = (headers.get("x-job-secret") ?? "").trim();
  if (job) return job;
  const internal = (headers.get("x-internal-secret") ?? "").trim();
  if (internal) return internal;
  const auth = (headers.get("authorization") ?? "").trim();
  const m = auth.match(/^Bearer\s+(\S+)/i);
  if (!m) return "";
  const token = m[1].trim();
  if (!token || isLikelyJwt(token)) return "";
  return token;
}

export function jobSecretAuthorized(expected: string, incoming: string): boolean {
  if (!expected || !incoming) return false;
  return constantTimeEqual(expected, incoming);
}

export function unauthorizedJobResponse(cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export function missingJobSecretConfigResponse(cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: "CENTRAL_CORE_JOB_SECRET missing" }), {
    status: 500,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
