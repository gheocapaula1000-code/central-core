# Central Core V3 — API Versioning & Compatibility Policy

> Last updated: 2026-03-20

---

## Version Scheme

Central Core uses **semantic versioning** (`MAJOR.MINOR.PATCH`):

| Component | Meaning | Example |
|-----------|---------|---------|
| MAJOR | Breaking contract changes | `4.0.0` |
| MINOR | Additive features, new routes, new optional fields | `3.4.0` |
| PATCH | Bug fixes, performance, internal refactors | `3.3.2` |

Current version: **3.3.5** (exposed via `X-Core-Version` header and `/health` responses).

---

## API Stability Tiers

Every route is classified into one of three tiers:

| Tier | Meaning | Breaking change policy |
|------|---------|----------------------|
| **stable** | Used by production PWAs. Contract-grade. | Never broken without MAJOR bump + 30-day deprecation notice. |
| **internal** | Used between Core functions (e.g., gateway→sottra). | May change with MINOR bump. PWAs must not depend on these. |
| **experimental** | New routes under evaluation. | May change or be removed with any release. Marked in manifest. |

### Current classification

| Route | Tier |
|-------|------|
| `ai-core-run POST (generic)` | stable |
| `ai-core-run /documents/analyze` | stable |
| `ai-core-run /web/scrape` | stable |
| `ai-core-run /tariffs/compare` | stable |
| `ai-core-run /health, /manifest` | stable |
| `ai-core-run /metrics, /diagnostics, /__diagnostics/selftest` | internal |
| `sottra /scan/*`, `sottra /forecast/*` | stable |
| `sottra /health, /manifest` | stable |
| `ecosystem-gateway /listing-enrichment` | experimental |
| `ecosystem-gateway /service-pack` | experimental |
| `ecosystem-gateway /unified-report` | experimental |
| `viral-core /generate-bundle` | stable |
| `viral-core /generate-single` | stable |
| `viral-core /policy-check` | stable |
| `viral-core /build-media-brief` | stable |
| `health /` | stable |

---

## Deprecation Policy

1. A route or field to be removed is marked `deprecated` in the manifest and changelog.
2. Deprecation notice is published at least **30 days** before removal for stable routes.
3. During deprecation, the route continues to work but returns a `warnings` entry: `"DEPRECATED: <route> will be removed in v<X>. Use <alternative>."`.
4. Removal happens only in a MAJOR version bump.

For **experimental** routes, removal can happen in any MINOR release without advance notice.

---

## Backward Compatibility Rules

1. **Additive only** — New fields in response envelopes are always optional. Clients must tolerate unknown fields.
2. **No field removal** — Existing response fields in stable routes are never removed without MAJOR bump.
3. **No type changes** — A field that returns `string` will never start returning `number`.
4. **No semantic changes** — `riskLevel: "low"` means the same thing across versions.
5. **Alias preservation** — Backward-compat aliases (e.g., `x-app-secret`) remain until MAJOR bump.

---

## How Clients Should Handle Versions

```typescript
// After every Core response, check version header
const coreVersion = response.headers.get("X-Core-Version");
// Log for monitoring — detect unexpected version mismatches
console.log(`[core] responded with v${coreVersion}`);

// Tolerate unknown fields in data
const { data, warnings } = await response.json();
if (warnings?.length) console.warn("[core] warnings:", warnings);
```

---

## Version Discovery

Every function exposes its version via:

1. **`X-Core-Version` header** — on every response
2. **`GET /health`** — `{ version: "3.3.1" }`
3. **`GET /manifest`** — `{ version: "3.3.1", contract: "central-core-v3" }`
