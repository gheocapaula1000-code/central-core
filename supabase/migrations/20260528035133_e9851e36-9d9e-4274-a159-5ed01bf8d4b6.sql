ALTER TABLE public.civiko_source_registry
  ADD COLUMN IF NOT EXISTS activation_mode TEXT,
  ADD COLUMN IF NOT EXISTS freshness_days INTEGER;

ALTER TABLE public.civiko_source_registry
  DROP CONSTRAINT IF EXISTS civiko_source_registry_activation_mode_check;

ALTER TABLE public.civiko_source_registry
  ADD CONSTRAINT civiko_source_registry_activation_mode_check
  CHECK (activation_mode IS NULL OR activation_mode = ANY (ARRAY[
    'live_api','crawler','manual_import','premium_on_demand','aggregate_only','disabled'
  ]));