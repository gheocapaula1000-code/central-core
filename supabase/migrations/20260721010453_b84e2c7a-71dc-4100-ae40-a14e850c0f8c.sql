CREATE OR REPLACE VIEW public.padova_contendibili_by_zone_v AS
SELECT
  pc.*,
  public.civiko_resolve_commercial_zone_slug(pc.quartiere) AS commercial_zone_slug
FROM public.padova_contendibili AS pc;

REVOKE ALL ON public.padova_contendibili_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM anon;
REVOKE ALL ON public.padova_contendibili_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_contendibili_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_contendibili_by_zone_v IS
  'Server-only. Contendibili con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Accesso: service_role.';