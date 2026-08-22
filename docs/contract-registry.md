# Central Core V3 — Contract Registry

> Canonical reference of all PWA→Core dependencies.
> Breaking any path, envelope, or shape listed here is a potential outage.
> Last updated: 2026-08-22
>
> See also: [API Versioning](./api-versioning.md) | [Client Integration Guide](./client-integration-guide.md) | [Proxy Contract](./proxy-contract.md) | [Operational Checklist](./operational-checklist.md) | [Client Compatibility Matrix](./client-compatibility-matrix.md) | [Secrets & Rotation](./secrets-and-rotation.md) | [Incident Response](./incident-response.md) | [Changelog](./changelog.md) | [Release Pipeline](./release-pipeline.md) | [OpenAPI Summary](./openapi-summary.yaml) | [Edge Function Auth Matrix](./edge-function-auth-matrix.md)

---

## Identity Headers (all functions)

Every response from Central Core V3 functions includes these non-sensitive headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Core-Version` | `3.4.4` | Core version that generated the response |
| `X-Core-Function` | `ai-core-run` / `sottra` / `health` | Which edge function responded |
| `X-Core-Route` | `health` / `manifest` / `scan/pricing` / etc. | Canonical route that handled the request |
| `X-Core-Contract` | `central-core-v3` | Contract identifier |

These headers help PWA clients and operators verify which function and version actually responded, reducing base-URL mismatch risks.

---

## Manifest Endpoint (all functions)

Each function exposes `GET /manifest` — a public, non-sensitive self-description:

```json
{
  "contract": "central-core-v3",
  "version": "3.4.4",
  "function": "ai-core-run",
  "serviceKind": "ai-router",
  "expectedBasePath": "/functions/v1/ai-core-run",
  "routes": ["GET /health", "POST /documents/analyze", ...],
  "domains": ["wyloni_bandi", "keydraft_realestate", ...],
  "callingMode": "proxy",
  "time": "ISO-8601"
}
```

| Field | Description |
|-------|-------------|
| `contract` | Always `central-core-v3` |
| `function` | Canonical edge function name |
| `serviceKind` | `ai-router` / `sottra-service` / `global-health-probe` |
| `expectedBasePath` | The path prefix the function expects (e.g. `/functions/v1/sottra`) |
| `routes` | List of supported routes |
| `domains` | AI pipeline domains (ai-core-run only) |
| `callingMode` | `proxy` (via client app) or `direct` (called directly) |

No secrets, allowlists, or infrastructure details are exposed.

---

## Authentication

| Priority | Header | Notes |
|----------|--------|-------|
| 1 | `x-internal-secret` | Preferred |
| 2 | `x-app-secret` | Legacy alias |
| 3 | `x-core-secret` | Legacy alias |
| 4 | `Authorization: Bearer <token>` | Bearer prefix stripped |

**Canonical env var:** `AI_CORE_SECRET`

---

## Standard Envelope

### Success
```json
{
  "ok": true,
  "data": { ... },
  "warnings": [],
  "debug_id": "string"
}
```

### Error
```json
{
  "ok": false,
  "data": null,
  "warnings": [],
  "debug_id": "string",
  "error": {
    "code": "UPPERCASE_SNAKE_CASE",
    "message": "Human-readable message"
  }
}
```

---

## Stability Tiers

> See [API Versioning](./api-versioning.md) for full policy.

| Tier | Meaning |
|------|---------|
| **stable** | Production PWA contract. Never broken without MAJOR bump + 30-day notice. |
| **internal** | Core-to-Core only. May change with MINOR bump. |
| **experimental** | Under evaluation. May change/remove with any release. |

---

## Wyloni

**Function:** `ai-core-run` · **Tier:** stable
**Domain:** `wyloni_bandi`
**Test file:** `src/test/wyloni-contract.test.ts`

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/health` | GET | Health probe | ✅ Active |
| `/__health` | GET | Alt health probe | ✅ Active |
| `/documents/analyze` | POST | Bill/document extraction | ✅ Active |
| `/web/scrape` | POST | Web scraping (Firecrawl) | ✅ Active |
| `/tariffs/compare` | POST | Tariff comparison | ✅ Active |
| `/metrics` | GET | Metrics endpoint | ✅ Active |
| Generic POST | POST | AI run (search_grants, deep_search, find_contacts, ai_bandi, etc.) | ✅ Active |

### Key Tasks (Perplexity web)
`search_grants`, `deep_search`, `find_contacts`, `find_company_contacts`, `ai_bandi`

### Key Tasks (Generative)
`feasibility_lab`, `viral_content`, `viral_content_bundle`, `strategic_report`, `batch_viral_content`

---

## KeyDraft

**Function:** `ai-core-run` · **Tier:** stable
**Domain:** `keydraft_realestate`
**Test file:** `src/test/keydraft-contract.test.ts`

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/health` | GET | Health probe | ✅ Active |
| `/__health` | GET | Alt health probe | ✅ Active |
| Generic POST | POST | AI run (keydraft_engine task) | ✅ Active |

### keydraft_engine Task
- **Input:** `{ domain: "keydraft_realestate", task: "keydraft_engine", input: { imageUrls, operation, price, province, comune, locality, enableRenovationEstimate } }`
- **Output:** `{ final_output, data: { title, description, highlights, rooms, condition, features, sqm_estimate, tags, photo_analysis }, debug_id }`
- **Token override:** 2500
- **Errors:** `MISSING_INPUT`, `NO_IMAGES`

### Key Tasks (Perplexity web)
`real_estate_deep`

---

## PRATICA

**Function:** `ai-core-run` · **Tier:** stable
**Domain:** `pratica_legal`
**Test file:** `src/test/pratica-contract.test.ts`

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/health` | GET | Health probe | ✅ Active |
| `/__health` | GET | Alt health probe | ✅ Active |
| `/documents/analyze` | POST | Document analysis | ✅ Active |
| `/web/scrape` | POST | Web scraping | ✅ Active |
| Generic POST | POST | AI run (legal tasks) | ✅ Active |

### Key Tasks (Generative)
`translate_objection`, `simplex`, `contratto_analisi`, `solve_problem`, `alchemist`, `loyalty_analyze`

### Key Tasks (Perplexity web)
`find_contacts`, `find_company_contacts`

---

## Sottra

**Function:** `sottra` (dedicated Edge Function) · **Tier:** stable
**Test file:** `src/test/sottra-contract.test.ts`

### Scan Endpoints (10)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/scan/identify` | POST | Photo + GPS → address + building ID | ✅ Active |
| `/scan/photo-wow` | POST | Photo + GPS official report (OMI/ISTAT/OSM) | ✅ Active |
| `/scan/cadastral` | POST | Cadastral data | ⚠️ UNAVAILABLE |
| `/scan/pricing` | POST | OMI pricing (polygon → official microzona → Padova 7-zone label; `comune_aggregate` only if unplaced) | ✅ Active |
| `/scan/listings` | POST | Real estate listings | ⚠️ UNAVAILABLE |
| `/scan/energy` | POST | Energy class (APE) | ⚠️ UNAVAILABLE |
| `/scan/condominio` | POST | Condominium data | ⚠️ UNAVAILABLE |
| `/scan/storico-transazioni` | POST | Transaction history | ⚠️ UNAVAILABLE |
| `/scan/market` | POST | Market comparables + signals | ✅ Active (env-gated) |
| `/scan/market-context` | POST | Alias backward-compat → same handler as scan/market | ✅ Active |

**OMI geometry on Core:** `omi_zone` / `omi_valori` are national tables. `omi_zone_geometry` on Core is a small sample (Padova 22 polygons). Synthetic geometry keys (`G224-B1`) are joined to official `link_zona` (`PD00000015`). Padova photoWow/pricing then labels one of Paula's 7 display zones; €/m² stay the official matched microzona (not an area average). Unplaced points stay `comune_aggregate` with no guessed letter and no city-wide min/max dump.

**photoWow / live PWA:** Sottra PWA `getPhotoWow` posts to Core `core-proxy` with `endpoint: /civiko-property-from-photo`. That alias is forwarded to `/sottra/scan/photo-wow` with `x-source-app: sottra`. Civiko One continues to call `civiko-property-from-photo` directly.

### Forecast Endpoints (8)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/forecast/moodscore` | POST | MoodScore quality index | ⚠️ UNAVAILABLE |
| `/forecast/timeview` | POST | Medium-term scenario | ✅ Active |
| `/forecast/opportunity` | POST | Opportunity index | ✅ Active |
| `/forecast/infrastrutture` | POST | Infrastructure analysis | ✅ Active |
| `/forecast/rischio-zona` | POST | Zone risk analysis | ✅ Active |
| `/forecast/trend-demografico` | POST | Demographic trend | ✅ Active |
| `/forecast/sviluppo-area` | POST | Area development | ✅ Active |
| `/forecast/convergenza-territoriale` | POST | ICTV territorial convergence | ✅ Active |

### scan/market — Market Data Adapter (Phase 3, Provider 1 Active)

**Provider 1 is now fully active** when `MARKET_PROVIDER_1_API_KEY` and `MARKET_PROVIDER_1_BASE_URL` are configured.

**Provider Contract:** POST `{BASE_URL}/search` with:
```json
{
  "lat": 45.464, "lng": 9.190,
  "comune": "MILANO", "address": "Via Roma 1, Milano",
  "street": "Via Roma", "houseNumber": "1", "provincia": "MI",
  "radiusKm": 2.0, "propertyType": "residenziale",
  "areaSqm": 85, "maxResults": 50, "maxAgeDays": 180
}
```
Expected response: `{ "listings": [...] }` (also accepts `results`, `data`, `items`, `properties`, `comparables` as array key). Listings can use Italian or English field names (e.g. `prezzo`/`price`, `superficie`/`areaSqm`, `via`/`street`).

**Retry policy:** 1 retry on HTTP 5xx/429, fail fast on 4xx. 15s timeout per attempt.

**Input:**
```json
{
  "address": "Via Roma 1, Milano",
  "comune": "MILANO",
  "lat": 45.464,
  "lng": 9.190,
  "provincia": "MI",
  "street": "Via Roma",
  "houseNumber": "1",
  "propertyType": "residenziale",
  "areaSqm": 85,
  "finalIdentityConfidence": 0.85,
  "geoMatchLevel": "house_number"
}
```

**Output:**
```json
{
  "marketContext": "available|partial|unavailable",
  "comparablesSummary": {
    "comparablesCount": 10,
    "medianPricePerSqm": 3200,
    "lowerQuartilePricePerSqm": 2800,
    "upperQuartilePricePerSqm": 3600,
    "freshnessScore": 0.75,
    "marketDepthScore": 0.67,
    "comparableCoverageLevel": "buona|parziale|scarsa|insufficiente",
    "marketDataConfidence": 0.72,
    "marketDataReason": "...",
    "count": 10,
    "q1PricePerSqm": 2800,
    "q3PricePerSqm": 3600,
    "marketDepth": "profondo|sufficiente|limitato",
    "marketFreshnessLabel": "recente|moderata|datata"
  },
  "marketSignals": { "..." },
  "marketSignalsList": [
    { "key": "priceBandLocale", "label": "Fascia prezzo locale", "value": "€2800-3600/mq", "detail": "..." }
  ],
  "marketConfidence": 0.72,
  "marketCoverageLevel": "buona",
  "sourceType": "commercial_verified|commercial_partial|elaborated|unavailable",
  "sourceLabel": "...",
  "sourcePeriod": "ultimi 6 mesi",
  "limitations": ["..."],
  "providerBreakdown": [{ "provider": "...", "available": true, "sourceClass": "..." }]
}
```

**Additive backward-compat fields (v3.3.1+):**
- `comparablesSummary.count` = alias of `comparablesCount`
- `comparablesSummary.q1PricePerSqm` = alias of `lowerQuartilePricePerSqm`
- `comparablesSummary.q3PricePerSqm` = alias of `upperQuartilePricePerSqm`
- `comparablesSummary.marketDepth` = `profondo` (≥60% depth) | `sufficiente` (≥30%) | `limitato`
- `comparablesSummary.marketFreshnessLabel` = `recente` (≥70% fresh) | `moderata` (≥40%) | `datata`
- `marketSignalsList` = flat array version of `marketSignals` keyed object

**Source Class Model:**
- `official` — Only real official sources (OMI, ISTAT)
- `commercial_verified` — ≥8 listings with ≥80% price coverage and ≥60% address-level detail
- `commercial_partial` — ≥3 listings with ≥50% price coverage but insufficient for verified
- `user_provided` — User-supplied data
- `elaborated` — Index/calculation from verified sources
- `unavailable` — Data not solid enough

**Gating Rules:**
- `finalIdentityConfidence < 50%` → market data unavailable
- `finalIdentityConfidence < 70%` or `geoMatchLevel < house_number` → no microzona comparables
- `< 3 comparables` → unavailable
- Provider price divergence > 30% → 30% confidence penalty
- Listings older than 180 days → filtered out
- SQM difference > 50% from reference → filtered out

**Env (all optional):**
- `MARKET_DATA_ENABLED` — master toggle (default: true)
- `MARKET_PROVIDER_ORDER` — comma-separated priority
- `MARKET_PROVIDER_1_API_KEY`, `MARKET_PROVIDER_1_BASE_URL`
- `MARKET_PROVIDER_2_API_KEY`, `MARKET_PROVIDER_2_BASE_URL`
- `MARKET_PROVIDER_3_API_KEY`, `MARKET_PROVIDER_3_BASE_URL`

### connectivityContext (forecast/infrastrutture, v3.3.1+)

Explicit precision marking for connectivity data. Precision: `comune` (current), `civico`/`strada` (future).

### schoolContext (forecast/sviluppo-area, v3.3.1+)

School data from MIM Open Data (`mim_schools` table). Precision: `comune`. Returns `available: false` when empty.

### UNAVAILABLE Endpoints
These endpoints are intentionally scaffolded but return `sourceType: "unavailable"` with explicit `limitations`. They do NOT invent or mock data. Future integration with real data sources will activate them.

- `scan/cadastral` — requires Sister / Agenzia Entrate integration
- `scan/listings` — requires portal feeds (Idealista, Immobiliare.it)
- `scan/energy` — requires ENEA / SIAPE integration
- `scan/condominio` — requires condominium registry access
- `scan/storico-transazioni` — requires Agenzia Entrate transaction DB
- `forecast/moodscore` — requires quality perception data sources

### Health Endpoint
- **GET** `/health` or `/` — returns `{ status: "healthy", engine: "sottra", version, routes, time }`
- No auth required

---

## EcoSystem Gateway

**Function:** `ecosystem-gateway` (dedicated Edge Function) · **Tier:** experimental
**Test file:** `src/test/ecosystem-gateway-contract.test.ts`
**Base path:** `/functions/v1/ecosystem-gateway`
**Service kind:** `ecosystem-orchestrator`
**Calling mode:** `direct`

> **Additive, optional orchestrator.** Does NOT modify existing PWA flows. Does NOT create mandatory dependencies. If any internal module fails, returns partial results with warnings.

### Public Routes (no auth)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/` | GET | Health (alias) | ✅ Active |
| `/health` | GET | Health probe | ✅ Active |
| `/__health` | GET | Alt health probe | ✅ Active |
| `/manifest` | GET | Self-description | ✅ Active |
| `/capabilities` | GET | Module catalog | ✅ Active |

### Protected Routes (AI_CORE_SECRET)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/listing-enrichment` | POST | Enrich property data via Sottra (best-effort) | ✅ Active |
| `/service-pack` | POST | Suggest Wyloni services (static catalog) | ✅ Active |
| `/unified-report` | POST | Compose unified report from sections | ✅ Active |

### listing-enrichment

**Input:** `{ source_app?, property: { address, comune, provincia, lat, lng, ... }, snapshot?, options? }`
**Best-effort deps:** `sottra/scan/market`, `sottra/forecast/sviluppo-area`
**Output:** `{ enrichment_status: "available|partial|unavailable", partial, property_snapshot, sottra_market, sottra_area_development, availability, source_apps, warnings_detail }`
**Errors:** `MISSING_PROPERTY` (400)

### service-pack

**Input:** `{ source_app?, context: { operation?, hasUtilitiesDocs?, hasContracts?, wantsArchive?, ... } }`
**Catalog:** Static Wyloni route keys only (`archivio`, `scanner`, `carica-file`, `bollette`, `dalla-tua-parte`, `controlla-contratto`, `simplex`, `money`, `guida-spid`, `autocertificazioni`)
**Output:** `{ recommended_services: [{ service_key, target_app, title, route, reason, priority, availability, deeplink }], count }`

### unified-report

**Input:** `{ keydraft?, enrichment?, servicePack?, options?: { includeExecutiveSummary? } }`
**Output:** `{ executive_summary?, technical_sheet?, territorial_context?, service_pack?, availability_flags, partial }`
**Behavior:** Normalizes and merges available sections. Missing sections are omitted or marked unavailable — never invented.

### Fail-Safe Design

- Internal Sottra calls use 12s timeout
- If Sottra is unreachable, returns `partial: true` with explicit warnings
- If internal base URL cannot be determined, returns partial with warning
- No global failure for individual module unavailability
- No new secrets required (reuses `AI_CORE_SECRET`)

---

## Standalone Health Function

**Function:** `health` · **Tier:** stable

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/` | GET | Standalone health check | ✅ Active |

---

## Viral Core

**Function:** `viral-core` (dedicated Edge Function) · **Tier:** stable
**Test file:** `src/test/viral-core-contract.test.ts`
**Base path:** `/functions/v1/viral-core`
**Service kind:** `viral-content-engine`
**Calling mode:** `proxy`

> **Private content generation engine for Viral Lab.** Centralizes multi-platform content generation, policy checking, and media brief building. Accessed only via core-proxy. No direct social media publishing, no social login, no scraping.

### Public Routes (no auth)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/` | GET | Health (alias) | ✅ Active |
| `/health` | GET | Health probe | ✅ Active |
| `/__health` | GET | Alt health probe | ✅ Active |
| `/manifest` | GET | Self-description | ✅ Active |
| `/capabilities` | GET | Module catalog | ✅ Active |

### Protected Routes (AI_CORE_SECRET)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/generate-bundle` | POST | Multi-platform content bundle (4 platforms) | ✅ Active |
| `/generate-single` | POST | Single-platform content generation | ✅ Active |
| `/policy-check` | POST | Deterministic anti-ban/anti-spam policy | ✅ Active |
| `/build-media-brief` | POST | Media brief for downstream image generation | ✅ Active |

### generate-bundle

**Input:** `{ source_app?, argomento, obiettivo?, tono?, formato?, brandProfile?, options?: { includeGoogleAdsPack?, includeVideoScript15s?, includePolicyCheck? }, historyHints? }`
**Output:** `{ contents: { tiktok, instagram, facebook, linkedin }, mediaSuggestions: { ... }, videoScript15s?, googleAdsPack?, policy: { riskLevel, publishModeRecommendation, riskFlags, notes } }`
**Errors:** `MISSING_ARGOMENTO` (400)

### generate-single

**Input:** `{ source_app?, platform, argomento, obiettivo?, tono?, formato?, brandProfile?, historyHints? }`
**Output:** `{ content, mediaSuggestion, policy: { riskLevel, publishModeRecommendation, riskFlags } }`
**Errors:** `MISSING_ARGOMENTO` (400), `INVALID_PLATFORM` (400)

### policy-check

**Input:** `{ source_app?, contents: { tiktok?, instagram?, facebook?, linkedin? }, historyHints?, scheduleHints? }`
**Output:** `{ riskLevel, publishModeRecommendation, riskFlags, normalizedSuggestions?, notes }`
**Errors:** `MISSING_CONTENTS` (400), `INVALID_PLATFORM` (400)

**Deterministic checks:** cross-platform copy similarity (Jaccard), hashtag repetition, history overlap, CTA overuse, same-day cross-post risk.

### build-media-brief

**Input:** `{ source_app?, platform, content, mediaSuggestion?, formato?, brandProfile? }`
**Output:** `{ mediaBrief: { visualConcept, style, subject, colors, mood, composition, safeRenderPrompt }, policy: { riskLevel, notes } }`
**Errors:** `MISSING_CONTENT` (400), `INVALID_PLATFORM` (400)

### Non-Goals

- No social media publishing or login
- No browser automation or scraping
- No direct PWA coupling
- No new secrets required (reuses `AI_CORE_SECRET` + `OPENAI_API_KEY`)

---

## Error Codes (all functions)

| Code | HTTP | Description |
|------|------|-------------|
| `MISSING_PROMPT` | 400 | No prompt/text in body |
| `INVALID_JSON` | 400 | Body is not valid JSON |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds size limit |
| `PROMPT_TOO_LONG` | 400 | Prompt exceeds character limit |
| `INVALID_DOMAIN` | 400 | Domain doesn't match `[a-z0-9_]+` |
| `INVALID_TASK` | 400 | Task doesn't match `[a-z0-9_]+` |
| `MISSING_INPUT` | 400 | keydraft_engine missing input object |
| `NO_IMAGES` | 400 | keydraft_engine no imageUrls |
| `MISSING_URL` | 400 | web/scrape missing url |
| `MISSING_COORDS` | 400 | Sottra missing lat/lng |
| `MISSING_ADDRESS` | 400 | Sottra missing address |
| `COMUNE_NOT_FOUND` | 400 | Cannot extract comune |
| `GEOCODE_FAILED` | 502 | Reverse geocoding failed |
| `PROVIDER_ERROR` | 502 | Upstream provider failure |
| `RATE_LIMITED` | 429 | Too many requests |
| `APP_SECRET_REQUIRED` | 401 | Missing auth header |
| `APP_SECRET_REJECTED` | 401 | Invalid secret |
| `ORIGIN_NOT_ALLOWED` | 403 | Browser origin not in allowlist |
| `CONFIG_ERROR` | 500 | Server misconfiguration |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |
| `ROUTE_NOT_FOUND` | 404 | No matching route |
| `INTERNAL_ERROR` | 500 | Unhandled server error |
| `MISSING_ARGOMENTO` | 400 | viral-core: missing argomento |
| `INVALID_PLATFORM` | 400 | viral-core: invalid platform |
| `MISSING_CONTENTS` | 400 | viral-core: missing contents |
| `MISSING_CONTENT` | 400 | viral-core: missing content |
| `MISSING_PROPERTY` | 400 | gateway: missing property |
| `VALIDATION_FAILED` | 400 | listing-bridge: payload validation failed |
| `DELIVERY_FAILED` | 502 | listing-bridge: Sottra delivery failed |
| `RETRY_DELIVERY_FAILED` | 502 | listing-bridge: retry delivery failed |
| `MISSING_TRACE_ID` | 400 | listing-bridge: missing trace_id param |
| `JOB_NOT_FOUND` | 404 | listing-bridge: no job for trace_id |
| `JOB_NOT_RETRYABLE` | 409 | listing-bridge: job not in failed state |
| `MAX_RETRIES_EXCEEDED` | 429 | listing-bridge: max retries reached |
| `DB_ERROR` | 500 | listing-bridge: database query failed |

---

## Regiads

**Function:** `viral-core` · **Tier:** stable
**Test file:** `src/test/regiads-contract.test.ts`
**Base path:** `/functions/v1/viral-core`
**Domain:** —
**Calling mode:** `proxy`

> **Content generation client for Regiads.** Uses viral-core for multi-platform content, policy checking, and media brief building. Accessed exclusively via core-proxy.

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/health` | GET | Health probe | ✅ Active |
| `/__health` | GET | Alt health probe | ✅ Active |
| `/manifest` | GET | Self-description | ✅ Active |
| `/capabilities` | GET | Module catalog | ✅ Active |
| `/generate-bundle` | POST | Multi-platform content bundle | ✅ Active |
| `/generate-single` | POST | Single-platform content | ✅ Active |
| `/policy-check` | POST | Anti-ban policy check | ✅ Active |
| `/build-media-brief` | POST | Media brief builder | ✅ Active |

### Proxy Requirements
- `ALLOWED_PATHS` must include `/viral-core`
- `x-internal-secret` must inject `AI_CORE_SECRET`
- `x-source-app: regiads`
- Timeout: 60s for generate-bundle, 45s for generate-single, 20s for policy-check and build-media-brief

---

## Cross-Reference: Documents

| Document | Purpose |
|----------|---------|
| [API Versioning](./api-versioning.md) | SemVer policy, deprecation rules |
| [Client Integration Guide](./client-integration-guide.md) | Auth, headers, envelope standard |
| [Proxy Contract](./proxy-contract.md) | Canonical core-proxy implementation |
| [Operational Checklist](./operational-checklist.md) | Deploy, smoke test, upgrade process |
| [Client Compatibility Matrix](./client-compatibility-matrix.md) | Client → endpoint dependency mapping |
| [Secrets & Rotation](./secrets-and-rotation.md) | Secret inventory and rotation procedures |
| [Incident Response](./incident-response.md) | Incident runbook |
| [Backup & Restore](./backup-restore-checklist.md) | Recovery procedures |
| [Release Acceptance](./release-acceptance-checklist.md) | Pre/post-release gate checklist |
| [Changelog](./changelog.md) | Version history |
| [OpenAPI Summary](./openapi-summary.yaml) | API surface summary |

---

## Endpoint: property-marketing-pack (white-label)

- **Path:** `POST /functions/v1/property-marketing-pack`
- **Auth:** `x-internal-secret` (per-app secret resolution via `requireSecret`)
- **Public naming:** `Studio Immobile Civiko` / `property_marketing_pack`
- **Brand isolation:** the response NEVER contains the internal pipeline brand name. A `deepScrub` pass over the payload rewrites any leaked occurrence and the contract test `src/test/property-marketing-pack-contract.test.ts` enforces this invariant.
- **Health/Manifest:** `GET /health`, `GET /manifest` (public, no secret).
- **Input:**
  ```json
  {
    "source_app": "civiko",
    "workspace_id": "...",
    "opportunity_id": "...",
    "property": {
      "title": "...", "address": "...", "comune": "...", "province": "...",
      "property_type": "...", "estimated_value": 250000,
      "rooms": 3, "bathrooms": 2, "mq": 95,
      "photos_summary": "...", "strengths": ["..."], "objections": ["..."], "urgency": "..."
    }
  }
  ```
- **Output envelope:** `{ ok, data, warnings, debug_id }` where `data` is:
  ```json
  {
    "studio_name": "Studio Immobile Civiko",
    "listing_text_long": "...",
    "listing_text_short": "...",
    "owner_message": "...",
    "social_variants": [{ "channel": "facebook|instagram|linkedin|whatsapp", "tone": "professionale|caldo|diretto", "text": "..." }],
    "highlights": ["..."],
    "objection_answers": [{ "objection": "...", "answer": "..." }],
    "next_best_action": "...",
    "confidence": "alta|media|bassa",
    "warnings": ["..."]
  }
  ```
