# Central Core V3 — Client Compatibility Matrix

> Canonical mapping of PWA clients → Core dependencies.
> Breaking any dependency listed here requires a MAJOR version bump + 30-day notice.
> Last updated: 2026-03-20

---

## Active Clients

| Client | Core Function(s) | Domain | Min Version | Proxy Required | Last Verified |
|--------|------------------|--------|-------------|----------------|---------------|
| **Wyloni** | ai-core-run, viral-core | wyloni_bandi, pratica_legal | 3.3.1 | Yes (core-proxy) | 2026-03-21 |
| **KeyDraft** | ai-core-run, listing-bridge | keydraft_realestate | 3.0.0 | Yes (core-proxy) | 2026-03-21 |
| **Sottra** | sottra | — | 3.3.1 | Yes (core-proxy) | 2026-03-21 |
| **PRATICA** | ai-core-run | pratica_legal | 3.0.0 | Yes (core-proxy) | 2026-03-21 |
| **Regiads** | viral-core | — | 3.3.1 | Yes (core-proxy) | Pending |

---

## Endpoint Dependencies per Client

### Wyloni
| Endpoint | Method | Required | Notes |
|----------|--------|----------|-------|
| `/ai-core-run/health` | GET | ✅ | Health probe |
| `/ai-core-run/__health` | GET | ✅ | Alt health probe |
| `/ai-core-run/documents/analyze` | POST | ✅ | Bill extraction |
| `/ai-core-run/web/scrape` | POST | ✅ | Firecrawl scraping |
| `/ai-core-run/tariffs/compare` | POST | ✅ | Tariff comparison |
| `/ai-core-run/metrics` | GET | Optional | Diagnostic (needs DIAGNOSTIC_SECRET) |
| `/ai-core-run` (generic POST) | POST | ✅ | AI tasks: search_grants, deep_search, feasibility_lab, etc. |
| `/viral-core/generate-bundle` | POST | Optional | Content generation |
| `/viral-core/generate-single` | POST | Optional | Single-platform content |
| `/viral-core/policy-check` | POST | Optional | Anti-ban check |

### KeyDraft
| Endpoint | Method | Required | Notes |
|----------|--------|----------|-------|
| `/ai-core-run/health` | GET | ✅ | Health probe |
| `/ai-core-run` (generic POST) | POST | ✅ | task=keydraft_engine |

### Sottra (PWA)
| Endpoint | Method | Required | Notes |
|----------|--------|----------|-------|
| `/sottra/health` | GET | ✅ | Health probe |
| `/sottra/scan/identify` | POST | ✅ | Photo → address |
| `/sottra/scan/photo-wow` | POST | ✅ | Photo+GPS official report (also via core-proxy `/civiko-property-from-photo`) |
| `/sottra/scan/pricing` | POST | ✅ | OMI pricing |
| `/sottra/scan/poi-enrichment` | POST | ✅ | OSM Overpass named POIs, Nominatim fallback (also via core-proxy) |
| `/sottra/scan/market` | POST | ✅ | Market comparables |
| `/sottra/forecast/*` | POST | ✅ | All forecast endpoints (neighborhood via core-proxy) |

### PRATICA
| Endpoint | Method | Required | Notes |
|----------|--------|----------|-------|
| `/ai-core-run/health` | GET | ✅ | Health probe |
| `/ai-core-run/documents/analyze` | POST | ✅ | Document analysis |
| `/ai-core-run/web/scrape` | POST | ✅ | Web scraping |
| `/ai-core-run` (generic POST) | POST | ✅ | Legal tasks: translate_objection, simplex, contratto_analisi |

### Regiads
| Endpoint | Method | Required | Notes |
|----------|--------|----------|-------|
| `/viral-core/health` | GET | ✅ | Health probe |
| `/viral-core/generate-bundle` | POST | ✅ | Multi-platform content |
| `/viral-core/generate-single` | POST | ✅ | Single-platform content |
| `/viral-core/policy-check` | POST | ✅ | Policy check |
| `/viral-core/build-media-brief` | POST | Optional | Media brief |

---

## Shared Secrets

| Secret | Used By | Purpose |
|--------|---------|---------|
| `AI_CORE_SECRET` | All PWAs | Authentication for POST endpoints |
| `DIAGNOSTIC_SECRET` | Core admin only | Diagnostics/metrics access |

---

## Proxy Requirements (per Client)

Each PWA must have a `core-proxy` Edge Function with:

| Config | Value |
|--------|-------|
| `ALLOWED_PATHS` | Must include all endpoints the PWA uses |
| `x-internal-secret` header | Must inject `AI_CORE_SECRET` |
| `x-source-app` header | Must identify the calling PWA |
| Timeout matrix | Per docs/proxy-contract.md |

---

## Breaking Change Impact

| Change Type | Affected Clients | Required Notice |
|-------------|------------------|-----------------|
| Remove `/ai-core-run/health` | Wyloni, KeyDraft, PRATICA | 30 days + MAJOR bump |
| Change envelope shape | ALL | 30 days + MAJOR bump |
| Add new optional field | None (additive) | MINOR bump, no notice |
| New endpoint | None (additive) | MINOR bump, PWAs opt-in |
| Rename error code | ALL | 30 days + MAJOR bump |
| Change auth header priority | ALL | 30 days + MAJOR bump |
