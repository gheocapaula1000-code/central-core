-- Drop FK to auth.users on agency_memberships and agencies-side defaults
-- because the user_id may originate from a different Supabase project (Civiko One auth).
ALTER TABLE public.agency_memberships
  DROP CONSTRAINT IF EXISTS agency_memberships_user_id_fkey;

-- Optional: also drop FK on agency_operating_areas.created_by if it exists
ALTER TABLE public.agency_operating_areas
  DROP CONSTRAINT IF EXISTS agency_operating_areas_created_by_fkey;

ALTER TABLE public.agency_signal_preferences
  DROP CONSTRAINT IF EXISTS agency_signal_preferences_created_by_fkey;