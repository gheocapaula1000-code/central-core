-- Add automation governance columns: job name, endpoint, cross-check flag, automation TODO.
ALTER TABLE public.civiko_source_registry
  ADD COLUMN IF NOT EXISTS scheduler_job_name TEXT,
  ADD COLUMN IF NOT EXISTS ingestion_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS cross_check_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automation_todo TEXT;

-- Backfill grounded on real ingestion paths in this repo.
WITH plan(code, job, endpoint, cross_check, todo) AS (VALUES
  ('F1' , NULL                                            , '/civiko-source-registry/import/omi'                       , true , 'Automate AdE OMI semiannual download (or ondata GitHub mirror).'),
  ('F2' , 'istat-sdmx-fetch'                              , '/istat-sdmx-fetch'                                        , true , NULL),
  ('F3' , NULL                                            , '/civiko-source-registry/import/apr4'                      , true , 'Add monitored downloader for ISTAT APR4 (demo.istat.it) when stable URL is available.'),
  ('F4' , NULL                                            , '/civiko-source-registry/import/padova-elderly'            , true , 'Add validated PDF/CSV parser for Comune di Padova elderly stats.'),
  ('F5' , 'connector-osm-cantieri'                        , '/connector-osm-cantieri'                                  , true , NULL),
  ('F6' , 'istat-ispra-import'                            , '/istat-ispra-import'                                      , true , 'Switch from storage import to live WFS pull.'),
  ('F7' , 'civiko-radar-veneto'                           , '/civiko-radar-veneto/jobs/import-arpav-air-quality'       , true , 'Add automated noise dataset path when public source is identified.'),
  ('F8' , NULL                                            , '/civiko-source-registry/import/mim-schools'               , true , 'Wire MIM open-data CSV downloader (annual).'),
  ('F9' , NULL                                            , '/civiko-source-registry/import/infratel'                  , true , 'Wire Infratel BUL API refresh.'),
  ('F10', 'civiko-radar-veneto'                           , '/civiko-radar-veneto/jobs/anac-ckan'                      , true , NULL),
  ('F11', 'civiko-pnrr-padova'                            , '/civiko-pnrr-padova'                                      , true , NULL),
  ('F12', NULL                                            , '/civiko-source-registry/import/market-benchmark'          , true , 'No compliant Borsino/FIAIP machine endpoint. Keep admin-only manual import.'),
  ('F13', 'civiko-radar-veneto'                           , '/civiko-radar-veneto/portalScrapers/quotations'           , true , 'Label as listing-derived; flag clearly vs F1 official OMI.'),
  ('F14', NULL                                            , '/civiko-premium-catasto'                                  , false, NULL),
  ('F15', NULL                                            , '/civiko-premium-conservatoria'                            , false, NULL),
  ('F16', 'civiko-radar-veneto'                           , '/civiko-radar-veneto/asteGiudiziarie'                     , true , NULL),
  ('F17', NULL                                            , '/civiko-source-registry/import/ape-veneto'                , true , 'Confirm Regione Veneto APE official endpoint and wire downloader. AI estimate stays separate.'),
  ('F18', NULL                                            , '/civiko-source-registry/import/sue-padova'                , false, 'No stable public SUE endpoint; admin manual import only.'),
  ('F19', 'civiko-source-registry'                        , '/civiko-source-registry/import/obituaries-aggregate'      , false, NULL),
  ('F20', NULL                                            , '/civiko-source-registry/import/apr4-mobility'             , true , 'Share downloader with F3 once stable APR4 source is wired.'),
  ('F21', 'civiko-radar-veneto'                           , '/civiko-radar-veneto/portalScrapers'                      , true , NULL),
  ('F22', NULL                                            , '/civiko-source-registry/import/istat-separations'         , true , 'Switch to ISTAT SDMX once dataset id is confirmed.')
)
UPDATE public.civiko_source_registry r
SET
  scheduler_job_name  = p.job,
  ingestion_endpoint  = p.endpoint,
  cross_check_enabled = p.cross_check,
  automation_todo     = p.todo
FROM plan p
WHERE r.source_code = p.code;

-- Honesty constraint: automated/semi_automated sources must declare a real path.
ALTER TABLE public.civiko_source_registry
  DROP CONSTRAINT IF EXISTS civiko_source_registry_automation_honesty_check;
ALTER TABLE public.civiko_source_registry
  ADD  CONSTRAINT civiko_source_registry_automation_honesty_check
  CHECK (
    automation_status IS NULL
    OR automation_status NOT IN ('automated','semi_automated')
    OR scheduler_job_name IS NOT NULL
    OR ingestion_endpoint IS NOT NULL
  );

-- manual_fallback sources must carry an automation TODO so we never lose the target state.
ALTER TABLE public.civiko_source_registry
  DROP CONSTRAINT IF EXISTS civiko_source_registry_manual_todo_check;
ALTER TABLE public.civiko_source_registry
  ADD  CONSTRAINT civiko_source_registry_manual_todo_check
  CHECK (
    automation_status IS DISTINCT FROM 'manual_fallback'
    OR automation_todo IS NOT NULL
    OR automation_notes IS NOT NULL
  );

COMMENT ON COLUMN public.civiko_source_registry.scheduler_job_name IS
  'Name of the edge function / module that owns ingestion. NULL means no scheduled job (manual or premium_on_demand).';
COMMENT ON COLUMN public.civiko_source_registry.ingestion_endpoint IS
  'Logical endpoint path used to trigger ingestion (admin import or scheduled job).';
COMMENT ON COLUMN public.civiko_source_registry.cross_check_enabled IS
  'True when this source participates in the cross-source evidence graph for scoring.';
COMMENT ON COLUMN public.civiko_source_registry.automation_todo IS
  'Concrete automation TODO for manual_fallback sources. NULL when source is already automated or premium.';
