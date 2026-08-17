# Civiko Source Scheduler Manifest

Authoritative schedule + automation contract for F1–F22 plus the official
`CIVICI` job. Mirrors `supabase/functions/_shared/sourceScheduler.ts`.
The source registry table (`civiko_source_registry`) is kept in sync with
this manifest; `connector-status` reports the live state.

## Two pipelines (do not mix)

| Class | Meaning | Cron | Failure mode |
|-------|---------|------|--------------|
| **C portals** | Immobiliare / Idealista / Subito / Casa.it | Separate `portal-*-padova` jobs → existing `cron-apify-*-nightly` | Fail-closed. Empty source (Casa.it historically 0/120) is logged, not pretended as success. Writes `padova_listings` when the source responds. |
| **A official** | ISTAT, civici, OSM (and other public sources already in this repo) | Separate `official-*` jobs → existing functions | Isolated per source. Not mixed into the portal runner. |
| **premium** | Catasto (F14), Conservatoria (F15) | None | On-demand paid. Never cron. |

The mixed `nightly-data-refresh-master` job (→ missing `civiko-scheduler`)
is unscheduled. `civiko-scheduler` remains an admin/manual Class A runner
only; it is not a pg_cron target.

Live Core project ref: `jpunnzgixcghuydstdlt`. Do not point these jobs at
`egjvullvkwpzyyworeml`.

### Portal jobs — schedule and write tables

Cron times are UTC. Europe/Rome is UTC+1 in winter, UTC+2 in summer.
Auth: `x-job-secret` = vault `CENTRAL_CORE_JOB_SECRET` via
`public.log_cron_http_invocation`.

| Cron job | UTC | Function | Writes |
|----------|-----|----------|--------|
| `portal-immobiliare-padova` | `0 2 * * *` | `cron-apify-immobiliare-nightly` → `padova-apify-immobiliare-collect` | `padova_listings` |
| `portal-idealista-padova` | `10 2 * * *` | `cron-apify-idealista-nightly` → `padova-apify-idealista-collect` | `padova_listings` |
| `portal-subito-padova` | `20 2 * * *` | `cron-apify-subito-nightly` → `padova-apify-subito-collect` | `padova_listings` |
| `portal-casa-padova` | `30 2 * * *` | `cron-apify-casa-nightly` → `padova-apify-casa-collect` | `padova_listings` (empty = fail) |
| `portal-collect-pending` | `45 2 * * *` | `cron-apify-collect-pending` | promotes Apify runs → `padova_listings` |
| `padova-listings-contendibili-recompute` | `15 3 * * *` | SQL `recompute_padova_listings_contendibili()` | `padova_contendibili` |

### Official jobs — schedule and write tables

| Cron job | UTC | Function | Writes |
|----------|-----|----------|--------|
| `official-istat-sdmx` | `0 4 1 * *` (monthly) | `istat-sdmx-fetch` | `istat_comuni` |
| `official-civici-ingest` | `0 4 * * 1` (Mon) | `padova-civici-ingest?action=ingest` | `padova_civici` |
| `official-civici-resolve-omi` | `30 4 * * 1` (Mon) | `padova-civici-ingest?action=resolve_omi` | `padova_civici` |
| `official-osm-cantieri` | `0 5 * * 1` (Mon) | `connector-osm-cantieri` | `raw_sources_ingest` |

Matcher rules are unchanged: via+civico, 40 m grid, pHash, auctions out;
2+ agencies = contendibile; 3+ = caldo/HOT display.

## Automation states

| state               | meaning                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `automated`         | Real edge function or scheduled job pulls live data with no human step. |
| `semi_automated`    | Real importer exists but needs an admin trigger or upload.              |
| `manual_fallback`   | Only manual/CSV import available today; automation is a target.         |
| `premium_on_demand` | Pulled only on explicit paid workflow. No mass scheduling.              |
| `disabled`          | Not active for compliance or legal reasons.                             |

## Catalog

| Code | Source                              | Status            | Frequency    | Owner job / module                                          |
|------|-------------------------------------|-------------------|--------------|-------------------------------------------------------------|
| F1   | OMI quotazioni AdE                  | manual_fallback   | semiannual   | civiko-source-registry (CSV)                                |
| F2   | ISTAT SDMX (demografia)             | automated         | monthly      | istat-sdmx-fetch                                            |
| F3   | ISTAT APR4 iscritti                 | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F4   | Comune Padova popolazione anziana   | manual_fallback   | monthly      | civiko-source-registry (CSV)                                |
| F5   | OSM cantieri                        | automated         | weekly       | connector-osm-cantieri                                      |
| F6   | ISPRA rischio                       | semi_automated    | quarterly    | istat-ispra-import (storage)                                |
| F7   | ARPAV (aria/ambiente)               | automated         | weekly       | civiko-radar-veneto/openData/arpavAirImporter               |
| F8   | MIM scuole                          | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F9   | Infratel                            | manual_fallback   | quarterly    | n/a (target API)                                            |
| F10  | ANAC open-data                      | automated         | weekly       | civiko-radar-veneto/openData/ckanImporter                   |
| F11  | OpenPNRR                            | automated         | weekly       | civiko-pnrr-padova                                          |
| F12  | Borsino/FIAIP benchmark             | manual_fallback   | monthly      | civiko-source-registry (CSV)                                |
| F13  | Immobiliare quotations              | semi_automated    | monthly      | listing-derived; labelled separately from F1 OMI            |
| F14  | Catasto                             | premium_on_demand | on_demand    | civiko-restricted-report                                    |
| F15  | Conservatoria RR.II.                | premium_on_demand | on_demand    | civiko-restricted-report                                    |
| F16  | PVP aste giudiziarie                | automated         | daily        | civiko-radar-veneto/asteGiudiziarie + auctionImport         |
| F17  | Veneto APE ufficiale                | manual_fallback   | quarterly    | civiko-source-registry (CSV) — official register only       |
| F18  | SUE Padova                          | manual_fallback   | monthly      | civiko-source-registry (CSV, compliance_verified=true)      |
| F19  | Necrologi (aggregato)               | automated         | daily        | civiko-source-registry/import/obituaries-aggregate (k>=3)   |
| F20  | ISTAT APR4 mobilità                 | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F21  | Portali (Immobiliare/Idealista/…)   | automated         | daily        | cron-apify-*-nightly + portal-collect-pending               |
| F22  | ISTAT separazioni/divorzi           | manual_fallback   | annual       | civiko-source-registry (CSV)                                |

## Wiring schedules

Trigger options (one of, owner decides per environment):

- **Supabase `pg_cron` + `pg_net`** invoking the function URL with `CENTRAL_CORE_JOB_SECRET`.
- **GitHub Actions** scheduled workflows running `curl` against the function URL.
- **Cloudflare cron** with the same secret.

Daily / weekly / monthly cadence must respect `scheduler_frequency`. When
a job fails, the corresponding function MUST update `last_error` and
`record_count` on the registry row without crashing other jobs.

## Cross-source corroboration

`_shared/scoringOrchestration.ts` enforces:

- ≥ 2 independent sources for **high** confidence opportunities.
- At least one non-weak source (`F19` is weak by policy).
- Aggregate-only / restricted sources never appear in PWA evidence unless
  their `compliance_visibility` allows it.
