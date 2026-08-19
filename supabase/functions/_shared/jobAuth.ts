// Shared job-secret auth for Core cron / edge-to-edge calls.
// Accepts the headers actually used in production:
//   - x-job-secret            (pg_cron log_cron_http_invocation, nightly wrappers)
//   - x-internal-secret       (canonical internal header used by other Core jobs)
//   - Authorization: Bearer   (when the bearer is CENTRAL_CORE_JOB_SECRET, not a JWT)
//
// Never logs secret values. Comparison is constant-time.

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull candidate secrets from a request. JWTs are ignored (they are not the job secret). */
export function extractJobSecretCandidates(headers: Headers): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null) => {
    const v = (raw ?? "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  push(headers.get("x-job-secret"));
  push(headers.get("x-internal-secret"));
  const auth = headers.get("authorization") ?? headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)/i);
  if (m?.[1] && !m[1].startsWith("eyJ")) push(m[1]);
  return out;
}

export function isJobSecretAuthorized(headers: Headers, expected: string): boolean {
  if (!expected) return false;
  let matched = false;
  for (const incoming of extractJobSecretCandidates(headers)) {
    if (constantTimeEqual(incoming, expected)) matched = true;
  }
  return matched;
}

export function jobAuthFailure(expectedConfigured: boolean): { status: number; error: string } {
  if (!expectedConfigured) {
    return { status: 500, error: "CENTRAL_CORE_JOB_SECRET missing" };
  }
  return { status: 401, error: "unauthorized" };
}

export function jobAuthHeaders(secret: string, apikey = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-job-secret": secret,
    "x-internal-secret": secret,
  };
  if (apikey) {
    headers.apikey = apikey;
    headers.Authorization = `Bearer ${apikey}`;
  }
  return headers;
}
