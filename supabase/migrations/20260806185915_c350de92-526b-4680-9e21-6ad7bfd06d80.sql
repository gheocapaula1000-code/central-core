CREATE OR REPLACE VIEW public.padova_cambi_agenzia_by_zone_v
WITH (security_invoker = true) AS
SELECT
  c.*,
  public.civiko_resolve_commercial_zone_slug(c.quartiere) AS commercial_zone_slug
FROM public.padova_cambi_agenzia c;

REVOKE ALL ON public.padova_cambi_agenzia_by_zone_v FROM PUBLIC;
GRANT SELECT ON public.padova_cambi_agenzia_by_zone_v TO service_role;