CREATE OR REPLACE VIEW public.padova_multi_portale_by_zone_v AS
SELECT mp.*, public.civiko_resolve_commercial_zone_slug(mp.quartiere) AS commercial_zone_slug
FROM public.padova_multi_portale AS mp;

REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM anon;
REVOKE ALL ON public.padova_multi_portale_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_multi_portale_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_multi_portale_by_zone_v IS
  'Server-only. Multi-portale con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Accesso: service_role.';

CREATE OR REPLACE VIEW public.padova_collect_v2_items_by_zone_v AS
SELECT ci.*, public.civiko_resolve_commercial_zone_slug(ci.quartiere) AS commercial_zone_slug
FROM public.padova_collect_v2_items AS ci;

REVOKE ALL ON public.padova_collect_v2_items_by_zone_v FROM PUBLIC;
REVOKE ALL ON public.padova_collect_v2_items_by_zone_v FROM anon;
REVOKE ALL ON public.padova_collect_v2_items_by_zone_v FROM authenticated;
GRANT SELECT ON public.padova_collect_v2_items_by_zone_v TO service_role;

COMMENT ON VIEW public.padova_collect_v2_items_by_zone_v IS
  'Server-only. Collect v2 items con commercial_zone_slug derivato SOLO da civiko_resolve_commercial_zone_slug(quartiere). Accesso: service_role.';

CREATE OR REPLACE FUNCTION public.get_padova_verified_price_drops_by_zone(
  p_commercial_zone_slug text,
  p_limit integer DEFAULT 500,
  p_min_drop_pct numeric DEFAULT 5,
  p_max_age_days integer DEFAULT 14
)
RETURNS TABLE (
  source_id text, listing_id text, source text, url text, title text, mq numeric,
  lat double precision, lng double precision,
  initial_price_eur numeric, current_price_eur numeric, total_drop_pct numeric,
  drops_count integer, observations_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz,
  comune text, omi_zone text, commercial_zone_slug text,
  zone_match_method text, zone_match_confidence numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    d.source_id, d.listing_id, d.source, d.url, d.title, d.mq,
    d.lat, d.lng,
    d.initial_price_eur, d.current_price_eur, d.total_drop_pct,
    d.drops_count, d.observations_count,
    d.first_seen_at, d.last_seen_at,
    d.comune, d.omi_zone, d.commercial_zone_slug,
    d.zone_match_method, d.zone_match_confidence
  FROM public.get_padova_verified_price_drops(p_limit, p_min_drop_pct, p_max_age_days) AS d
  WHERE p_commercial_zone_slug IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.civiko_commercial_zones z
      WHERE z.slug = p_commercial_zone_slug
    )
    AND d.commercial_zone_slug = p_commercial_zone_slug;
$$;

REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) TO service_role;

COMMENT ON FUNCTION public.get_padova_verified_price_drops_by_zone(text, integer, numeric, integer) IS
  'Server-only wrapper di get_padova_verified_price_drops con filtro OBBLIGATORIO su commercial_zone_slug. Accesso: service_role.';