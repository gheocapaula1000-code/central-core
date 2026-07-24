UPDATE public.civiko_commercial_zones
SET status = 'disponibile',
    trial_agency_id = NULL,
    trial_reserved_until = NULL
WHERE trial_agency_id = '6e046679-f3de-4daf-8924-50a767bfeb60'
  AND slug <> 'centro-storico';