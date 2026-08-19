# Civiko Source Scheduler Manifest

Authoritative schedule + automation contract for F1–F22. Mirrors
`supabase/functions/_shared/sourceScheduler.ts`. The source registry
table (`civiko_source_registry`) is kept in sync with this manifest;
`connector-status` and `core-cron-health-public` report the live state.

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
| F2   | ISTAT SDMX (demografia)             | automated         | monthly      | istat-sdmx-fetch (`istat-sdmx-monthly`)                     |
| F3   | ISTAT APR4 iscritti                 | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F4   | Comune Padova popolazione anziana   | manual_fallback   | monthly      | civiko-source-registry (CSV)                                |
| F5   | OSM cantieri                        | automated         | weekly       | connector-osm-cantieri (`connector-osm-cantieri-weekly`)    |
| F6   | ISPRA rischio                       | semi_automated    | quarterly    | istat-ispra-import (storage)                                |
| F7   | ARPAV (aria/ambiente)               | automated         | weekly       | civiko-radar-veneto/jobs/import-arpav-air-quality           |
| F8   | MIM scuole                          | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F9   | Infratel                            | manual_fallback   | quarterly    | n/a (target API)                                            |
| F10  | ANAC / open-data Veneto             | automated         | weekly       | civiko-radar-veneto/jobs/import-veneto-open-data            |
| F11  | OpenPNRR                            | automated         | weekly       | civiko-pnrr-padova (`civiko-pnrr-padova-weekly`)            |
| F12  | Borsino/FIAIP benchmark             | manual_fallback   | monthly      | civiko-source-registry (CSV)                                |
| F13  | Immobiliare quotations              | semi_automated    | monthly      | civiko-radar-veneto (listing-derived)                       |
| F14  | Catasto                             | premium_on_demand | on_demand    | civiko-restricted-report                                    |
| F15  | Conservatoria RR.II.                | premium_on_demand | on_demand    | civiko-restricted-report                                    |
| F16  | Aste giudiziarie Padova             | automated         | daily        | civiko-radar-veneto/jobs/refresh-padova-auctions            |
| F17  | Veneto APE ufficiale                | manual_fallback   | quarterly    | civiko-source-registry (CSV) — AI estimate stays separate   |
| F18  | SUE Padova                          | manual_fallback   | monthly      | civiko-source-registry (CSV, compliance_verified=true)      |
| F19  | Necrologi (aggregato)               | automated         | daily        | civiko-obituaries-aggregate (k>=3)                          |
| F20  | ISTAT APR4 mobilità                 | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F21  | Portali (Immobiliare/Idealista/…)   | automated         | daily        | civiko-radar-veneto/jobs/deep-scan-padova + portal-* crons  |
| F22  | ISTAT separazioni/divorzi           | manual_fallback   | annual       | civiko-source-registry (CSV)                                |

## Wiring schedules

Every `automated` source has a real HTTP trigger. Owner per environment:

- **Supabase `pg_cron` + `pg_net`** via `log_cron_http_invocation`, which
  sends `x-job-secret` from vault `CENTRAL_CORE_JOB_SECRET`.
  - Daily due-only orchestrator: `nightly-data-refresh-master` (02:00 UTC)
    and `civiko-scheduler-daily` (02:15 UTC) → `civiko-scheduler/run-scheduled`.
  - Weekly due-only: `civiko-scheduler-weekly` (Monday 03:30 UTC).
  - Dedicated: `istat-sdmx-monthly`, `connector-osm-cantieri-weekly`,
    `civiko-pnrr-padova-weekly`, `civiko-obituaries-aggregate-daily`.
- **GitHub Actions fallback** (`.github/workflows/cron-source-scheduler.yml`)
  curls the same URL with `CENTRAL_CORE_JOB_SECRET` from Actions secrets.
  Never hardcode the secret.
- **Cloudflare cron** with the same secret is an optional extra.

Daily / weekly / monthly cadence must respect `scheduler_frequency`. When
a job fails, the corresponding function MUST update `last_error` and
`record_count` on the registry row without crashing other jobs.
`civiko-scheduler` isolates per-source exceptions and writes `last_error`.

## Health endpoints

| Endpoint | Auth | Notes |
|----------|------|--------|
| `core-cron-health-public` | `x-diagnostic-secret` (`DIAGNOSTIC_SECRET`) | **401 without the secret is expected** (Checkpoint 1A). Not anonymously public. Returns cron job status plus `fonti_scheduler` (`last_error`, stale, never-run). Query failures appear in `diagnostics_errors`. |
| `connector-status` | Admin Bearer JWT **or** `x-job-secret` **or** `x-diagnostic-secret` | 401 without one of those is expected. Surfaces `last_error`, `failed_sources`, `sources_read_error`, and trigger coverage. |

## Cross-source corroboration

`_shared/scoringOrchestration.ts` enforces:

- ≥ 2 independent sources for **high** confidence opportunities.
- At least one non-weak source (`F19` is weak by policy).
- Aggregate-only / restricted sources never appear in PWA evidence unless
  their `compliance_visibility` allows it.
