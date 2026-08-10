// Auth puro e testabile per civiko-orchestrator-dispatch.
// Nessun log, nessuna esposizione del valore dei secret.

export function ctEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function isAuthorized(
  headers: Headers,
  dispatchSecret: string,
  jobSecret: string,
): boolean {
  const auth = headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const bearerOk = dispatchSecret.length > 0 && bearer.length > 0 &&
    ctEqual(bearer, dispatchSecret);
  const jobHeader = headers.get("x-job-secret") ?? "";
  const jobOk = jobSecret.length > 0 && jobHeader.length > 0 &&
    ctEqual(jobHeader, jobSecret);
  return bearerOk || jobOk;
}
