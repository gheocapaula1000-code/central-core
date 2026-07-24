
-- 1) Free every commercial zone
UPDATE public.civiko_commercial_zones
SET status = 'disponibile',
    trial_agency_id = NULL,
    trial_reserved_until = NULL,
    occupied_agency_id = NULL,
    occupied_since = NULL;

-- 2) Admin recognition RPC
CREATE OR REPLACE FUNCTION public.civiko_is_admin_agency(_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agency_memberships am
    JOIN public.user_roles ur
      ON ur.user_id = am.user_id
     AND ur.role = 'admin'
    WHERE am.agency_id = _agency_id
  );
$$;
REVOKE ALL ON FUNCTION public.civiko_is_admin_agency(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.civiko_is_admin_agency(uuid) TO service_role, authenticated;

-- 3) Empirical OMI -> commercial slug map, then backfill listings with GPS
WITH labeled AS (
  SELECT l.commercial_zone_slug AS slug, g.zona AS omi_zona
  FROM public.padova_listings l
  JOIN public.omi_zone_geometry g
    ON g.comune_descrizione ILIKE 'padova'
   AND ST_Contains(g.geom, ST_SetSRID(ST_MakePoint(l.lng::double precision, l.lat::double precision), 4326))
  WHERE l.comune = 'Padova'
    AND l.commercial_zone_slug IS NOT NULL
    AND l.lat IS NOT NULL AND l.lng IS NOT NULL
),
counts AS (
  SELECT omi_zona, slug, COUNT(*) AS c
  FROM labeled
  GROUP BY 1, 2
),
mode_map AS (
  SELECT DISTINCT ON (omi_zona) omi_zona, slug
  FROM counts
  ORDER BY omi_zona, c DESC
)
UPDATE public.padova_listings l
SET commercial_zone_slug = mm.slug
FROM public.omi_zone_geometry g,
     mode_map mm
WHERE l.comune = 'Padova'
  AND l.expired_at IS NULL
  AND l.commercial_zone_slug IS NULL
  AND l.lat IS NOT NULL AND l.lng IS NOT NULL
  AND g.comune_descrizione ILIKE 'padova'
  AND ST_Contains(g.geom, ST_SetSRID(ST_MakePoint(l.lng::double precision, l.lat::double precision), 4326))
  AND mm.omi_zona = g.zona;

-- 4) Populate omi_codes on civiko_commercial_zones from the same empirical map
WITH labeled AS (
  SELECT l.commercial_zone_slug AS slug, g.zona AS omi_zona
  FROM public.padova_listings l
  JOIN public.omi_zone_geometry g
    ON g.comune_descrizione ILIKE 'padova'
   AND ST_Contains(g.geom, ST_SetSRID(ST_MakePoint(l.lng::double precision, l.lat::double precision), 4326))
  WHERE l.comune = 'Padova'
    AND l.commercial_zone_slug IS NOT NULL
    AND l.lat IS NOT NULL AND l.lng IS NOT NULL
),
counts AS (
  SELECT omi_zona, slug, COUNT(*) AS c
  FROM labeled
  GROUP BY 1, 2
),
mode_map AS (
  SELECT DISTINCT ON (omi_zona) omi_zona, slug
  FROM counts
  ORDER BY omi_zona, c DESC
),
agg AS (
  SELECT slug, array_agg(omi_zona ORDER BY omi_zona) AS codes
  FROM mode_map
  GROUP BY slug
)
UPDATE public.civiko_commercial_zones z
SET omi_codes = agg.codes
FROM agg
WHERE z.slug = agg.slug;
