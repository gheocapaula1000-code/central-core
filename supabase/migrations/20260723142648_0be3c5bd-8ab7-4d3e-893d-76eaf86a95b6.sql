BEGIN;

REVOKE ALL ON FUNCTION public.expire_padova_agency_listings(timestamptz)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.promote_padova_collect_v2_to_listings(timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.expire_padova_agency_listings(timestamptz)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.promote_padova_collect_v2_to_listings(timestamptz)
  TO service_role;

COMMIT;