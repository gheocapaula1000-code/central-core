UPDATE public.civiko_commercial_zones
SET status = 'disponibile', trial_agency_id = NULL, trial_reserved_until = NULL
WHERE trial_agency_id = 'aaaa0000-0000-4000-8000-0000000000a1'::uuid;

DELETE FROM public.agency_memberships
WHERE agency_id IN (
  'aaaa0000-0000-4000-8000-0000000000a1'::uuid,
  'bbbb0000-0000-4000-8000-0000000000b1'::uuid
);

DELETE FROM public.agencies
WHERE id IN (
  'aaaa0000-0000-4000-8000-0000000000a1'::uuid,
  'bbbb0000-0000-4000-8000-0000000000b1'::uuid
)
AND billing_email LIKE 'qa-4a-%@qa.invalid';