REVOKE ALL ON FUNCTION public.civiko_is_admin_agency(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_is_admin_agency(uuid) TO service_role;