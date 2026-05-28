
-- 1) Automation tracking columns on the source registry.
ALTER TABLE public.civiko_source_registry
  ADD COLUMN IF NOT EXISTS automation_status     TEXT,
  ADD COLUMN IF NOT EXISTS scheduler_frequency   TEXT,
  ADD COLUMN IF NOT EXISTS next_run_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_run_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stale_after_days      INTEGER,
  ADD COLUMN IF NOT EXISTS automation_notes      TEXT;

ALTER TABLE public.civiko_source_registry
  DROP CONSTRAINT IF EXISTS civiko_source_registry_automation_status_check;
ALTER TABLE public.civiko_source_registry
  ADD  CONSTRAINT civiko_source_registry_automation_status_check
  CHECK (automation_status IS NULL OR automation_status = ANY (ARRAY[
    'automated','semi_automated','manual_fallback','premium_on_demand','disabled'
  ]));

ALTER TABLE public.civiko_source_registry
  DROP CONSTRAINT IF EXISTS civiko_source_registry_scheduler_frequency_check;
ALTER TABLE public.civiko_source_registry
  ADD  CONSTRAINT civiko_source_registry_scheduler_frequency_check
  CHECK (scheduler_frequency IS NULL OR scheduler_frequency = ANY (ARRAY[
    'daily','weekly','monthly','quarterly','semiannual','annual','on_demand'
  ]));

-- 2) Backfill grounded on real code. Only mark "automated" sources that have a real job today.
WITH plan(code, automation_status, scheduler_frequency, stale_after_days, notes) AS (VALUES
  ('F1' , 'manual_fallback'   , 'semiannual', 200, 'Target: auto download AdE export. Fallback CSV via civiko-source-registry.'),
  ('F2' , 'automated'         , 'monthly'   , 60,  'istat-sdmx-fetch edge function ingests DCIS_POPRES1.'),
  ('F3' , 'manual_fallback'   , 'annual'    , 400, 'APR4 manual CSV import. Target: monitored downloader from demo.istat.it.'),
  ('F4' , 'manual_fallback'   , 'monthly'   , 60,  'Padova elderly: manual CSV today. Target: PDF/CSV monitored parser.'),
  ('F5' , 'automated'         , 'weekly'    , 14,  'connector-osm-cantieri pulls Overpass.'),
  ('F6' , 'semi_automated'    , 'quarterly' , 120, 'istat-ispra-import reads from storage. Target: WFS auto-pull.'),
  ('F7' , 'automated'         , 'weekly'    , 14,  'civiko-radar-veneto/openData/arpavAirImporter + environmentalImporter.'),
  ('F8' , 'manual_fallback'   , 'annual'    , 400, 'MIM schools manual import. Target: open-data CSV auto.'),
  ('F9' , 'manual_fallback'   , 'quarterly' , 120, 'Infratel manual today. Target: API refresh.'),
  ('F10', 'automated'         , 'weekly'    , 14,  'CKAN importers under civiko-radar-veneto/openData.'),
  ('F11', 'automated'         , 'weekly'    , 14,  'civiko-pnrr-padova fetches OpenPNRR live.'),
  ('F12', 'manual_fallback'   , 'monthly'   , 90,  'No compliant Borsino/FIAIP API. Manual admin import.'),
  ('F13', 'semi_automated'    , 'monthly'   , 60,  'Immobiliare quotations derived via portal scrapers; benchmark labelled separately.'),
  ('F14', 'premium_on_demand' , 'on_demand' , NULL,'Catasto premium only. No mass automation.'),
  ('F15', 'premium_on_demand' , 'on_demand' , NULL,'Conservatoria premium only. No mass automation.'),
  ('F16', 'automated'         , 'daily'     , 3,   'civiko-radar-veneto/asteGiudiziarie + auctionImport pulls PVP.'),
  ('F17', 'manual_fallback'   , 'quarterly' , 180, 'APE official manual. AI estimate stays separate, never labelled official.'),
  ('F18', 'manual_fallback'   , 'monthly'   , 60,  'SUE Padova manual admin import with compliance_verified flag.'),
  ('F19', 'automated'         , 'daily'     , 7,   'obituaries_aggregate_padova import; k-anonymity>=3; visible_to_pwa=false.'),
  ('F20', 'manual_fallback'   , 'annual'    , 400, 'APR4 mobility manual. Target: same as F3.'),
  ('F21', 'automated'         , 'daily'     , 3,   'civiko-radar-veneto/portalScrapers + ribassiPortali.'),
  ('F22', 'manual_fallback'   , 'annual'    , 400, 'ISTAT separations manual. Target: SDMX auto-pull.')
)
UPDATE public.civiko_source_registry r
SET
  automation_status   = p.automation_status,
  scheduler_frequency = p.scheduler_frequency,
  stale_after_days    = COALESCE(p.stale_after_days, r.stale_after_days),
  automation_notes    = p.notes
FROM plan p
WHERE r.source_code = p.code;

-- 3) Cross-source evidence graph.
CREATE TABLE IF NOT EXISTS public.civiko_evidence (
  id BIGSERIAL PRIMARY KEY,
  entity_type            TEXT NOT NULL CHECK (entity_type IN ('property','area','microzone','comune','opportunity')),
  entity_key             TEXT NOT NULL,
  source_code            TEXT NOT NULL,
  evidence_type          TEXT NOT NULL,
  evidence_value         JSONB,
  confidence             TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  freshness_days         INTEGER,
  observed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  explanation            TEXT,
  raw_ref_id             TEXT,
  compliance_visibility  TEXT NOT NULL DEFAULT 'admin_only'
    CHECK (compliance_visibility IN ('public','admin_only','restricted','aggregate_only')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_civiko_evidence_entity
  ON public.civiko_evidence(entity_type, entity_key);
CREATE INDEX IF NOT EXISTS idx_civiko_evidence_source
  ON public.civiko_evidence(source_code, observed_at DESC);

COMMENT ON TABLE public.civiko_evidence IS
  'Cross-source evidence graph. One row per (entity, source, evidence_type). Service-role only.';

GRANT ALL ON public.civiko_evidence TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.civiko_evidence_id_seq TO service_role;

ALTER TABLE public.civiko_evidence ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies → not exposed via Data API.
