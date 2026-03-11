# Central Core V3 — Contract Registry

> Canonical reference of all PWA→Core dependencies.
> Breaking any path, envelope, or shape listed here is a potential outage.
> Last updated: 2026-03-11

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

## Wyloni

**Function:** `ai-core-run`
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

**Function:** `ai-core-run`
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

**Function:** `ai-core-run`
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

**Function:** `sottra` (dedicated Edge Function)
**Test file:** `src/test/sottra-contract.test.ts`

### Scan Endpoints (7)

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/scan/identify` | POST | Photo + GPS → address + building ID | ✅ Active |
| `/scan/cadastral` | POST | Cadastral data | ⚠️ UNAVAILABLE |
| `/scan/pricing` | POST | OMI pricing data | ✅ Active |
| `/scan/listings` | POST | Real estate listings | ⚠️ UNAVAILABLE |
| `/scan/energy` | POST | Energy class (APE) | ⚠️ UNAVAILABLE |
| `/scan/condominio` | POST | Condominium data | ⚠️ UNAVAILABLE |
| `/scan/storico-transazioni` | POST | Transaction history | ⚠️ UNAVAILABLE |

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

## Standalone Health Function

**Function:** `health`

| Route | Method | Description | Status |
|-------|--------|-------------|--------|
| `/` | GET | Standalone health check | ✅ Active |

---

## Error Codes (shared across all PWAs)

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
| `CONFIG_ERROR` | 500 | Server misconfiguration |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |
| `ROUTE_NOT_FOUND` | 404 | Sottra: no matching route |
| `INTERNAL_ERROR` | 500 | Unhandled server error |
