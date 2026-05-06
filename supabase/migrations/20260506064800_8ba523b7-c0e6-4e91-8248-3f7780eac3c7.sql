
-- 1) Add separation columns (idempotent) to all sensitive tables
ALTER TABLE public.obituaries_sources
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'sensitive_turnover',
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS standard_radar_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agency_private_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retention_days integer DEFAULT 180;

ALTER TABLE public.obituaries_seen
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'sensitive_turnover',
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS standard_radar_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agency_private_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retention_days integer DEFAULT 180;

ALTER TABLE public.inheritance_pressure_signals
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'sensitive_turnover',
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS standard_radar_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agency_private_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retention_days integer DEFAULT 180;

ALTER TABLE public.estate_turnover_zones
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'sensitive_turnover',
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS standard_radar_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agency_private_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retention_days integer DEFAULT 180;

-- 2) Backfill all existing rows
UPDATE public.obituaries_sources SET category='sensitive_turnover', requires_review=true, standard_radar_visible=false, agency_private_only=true WHERE category IS DISTINCT FROM 'sensitive_turnover';
UPDATE public.obituaries_seen SET category='sensitive_turnover', requires_review=true, standard_radar_visible=false, agency_private_only=true WHERE category IS DISTINCT FROM 'sensitive_turnover';
UPDATE public.inheritance_pressure_signals SET category='sensitive_turnover', requires_review=true, standard_radar_visible=false, agency_private_only=true WHERE category IS DISTINCT FROM 'sensitive_turnover';
UPDATE public.estate_turnover_zones SET category='sensitive_turnover', requires_review=true, standard_radar_visible=false, agency_private_only=true WHERE category IS DISTINCT FROM 'sensitive_turnover';

-- 3) Re-enable obituaries_sources (separation, not freeze)
UPDATE public.obituaries_sources SET is_active=true WHERE is_active=false;

-- 4) Extend agency_signal_preferences with sensitive turnover toggles
ALTER TABLE public.agency_signal_preferences
  ADD COLUMN IF NOT EXISTS include_sensitive_turnover boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS include_sensitive_turnover_aggregated boolean NOT NULL DEFAULT true;
