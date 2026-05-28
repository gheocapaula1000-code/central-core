// Centralized Apify token resolution.
//
// Canonical env var: APIFY_API_TOKEN
// Legacy fallbacks (deprecated, kept temporarily for backwards compatibility
// during the migration): APIFY_TOKEN, APIFY_API_KEY.
//
// All edge functions MUST resolve the Apify token via getApifyToken() instead
// of reading Deno.env directly, so token-naming changes happen in one place.

const CANONICAL = "APIFY_API_TOKEN";
const LEGACY_FALLBACKS = ["APIFY_TOKEN", "APIFY_API_KEY"] as const;

let warnedLegacy = false;

/** Returns the configured Apify API token, or "" if none is configured. */
export function getApifyToken(): string {
  const canonical = Deno.env.get(CANONICAL);
  if (canonical) return canonical;
  for (const name of LEGACY_FALLBACKS) {
    const v = Deno.env.get(name);
    if (v) {
      if (!warnedLegacy) {
        warnedLegacy = true;
        console.warn(
          `[apify] using legacy env var ${name}; please rename to ${CANONICAL}`,
        );
      }
      return v;
    }
  }
  return "";
}

export function isApifyTokenConfigured(): boolean {
  return getApifyToken().length > 0;
}
