# Civiko Source Scheduler Manifest

Authoritative schedule + automation contract for F1–F22. Mirrors
`supabase/functions/_shared/sourceScheduler.ts`. The source registry
table (`civiko_source_registry`) is kept in sync with this manifest;
`connector-status` reports the live state.

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
| F13  | Immobiliare quotations              | semi_automated    | monthly      | civiko-radar-veneto/portalScrapers (derived)                |
| F14  | Catasto                             | premium_on_demand | on_demand    | civiko-restricted-report                                    |
| F15  | Conservatoria RR.II.                | premium_on_demand | on_demand    | civiko-restricted-report                                    |
| F16  | PVP aste giudiziarie                | automated         | daily        | civiko-radar-veneto/asteGiudiziarie + auctionImport         |
| F17  | Veneto APE ufficiale                | manual_fallback   | quarterly    | civiko-source-registry (CSV) — AI estimate stays separate   |
| F18  | SUE Padova                          | manual_fallback   | monthly      | civiko-source-registry (CSV, compliance_verified=true)      |
| F19  | Necrologi (aggregato)               | automated         | daily        | civiko-source-registry/import/obituaries-aggregate (k>=3)   |
| F20  | ISTAT APR4 mobilità                 | manual_fallback   | annual       | civiko-source-registry (CSV)                                |
| F21  | Portali (Immobiliare/Idealista/…)   | automated         | daily        | civiko-radar-veneto/portalScrapers + ribassiPortali         |
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
