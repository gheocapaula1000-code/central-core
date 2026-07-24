
WITH labeled AS (
  SELECT l.commercial_zone_slug AS slug, g.zona AS omi_zona
  FROM public.padova_listings l
  JOIN public.omi_zone_geometry g
    ON g.comune_descrizione ILIKE 'padova'
   AND extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_MakePoint(l.lng::float8, l.lat::float8), 4326))
  WHERE l.comune = 'Padova'
    AND l.commercial_zone_slug IS NOT NULL
    AND l.lat IS NOT NULL AND l.lng IS NOT NULL
),
counts AS (
  SELECT omi_zona, slug, COUNT(*) AS c FROM labeled GROUP BY 1,2
),
mode_map AS (
  SELECT DISTINCT ON (omi_zona) omi_zona, slug FROM counts ORDER BY omi_zona, c DESC
)
UPDATE public.padova_listings l
SET commercial_zone_slug = mm.slug
FROM public.omi_zone_geometry g, mode_map mm
WHERE l.comune = 'Padova'
  AND l.expired_at IS NULL
  AND l.commercial_zone_slug IS NULL
  AND l.lat IS NOT NULL AND l.lng IS NOT NULL
  AND g.comune_descrizione ILIKE 'padova'
  AND extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_MakePoint(l.lng::float8, l.lat::float8), 4326))
  AND mm.omi_zona = g.zona;

-- refresh omi_codes on commercial zones from the same empirical map
WITH labeled AS (
  SELECT l.commercial_zone_slug AS slug, g.zona AS omi_zona
  FROM public.padova_listings l
  JOIN public.omi_zone_geometry g
    ON g.comune_descrizione ILIKE 'padova'
   AND extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_MakePoint(l.lng::float8, l.lat::float8), 4326))
  WHERE l.comune='Padova' AND l.commercial_zone_slug IS NOT NULL AND l.lat IS NOT NULL AND l.lng IS NOT NULL
),
counts AS (SELECT omi_zona, slug, COUNT(*) c FROM labeled GROUP BY 1,2),
mode_map AS (SELECT DISTINCT ON (omi_zona) omi_zona, slug FROM counts ORDER BY omi_zona, c DESC),
agg AS (SELECT slug, array_agg(omi_zona ORDER BY omi_zona) codes FROM mode_map GROUP BY slug)
UPDATE public.civiko_commercial_zones z SET omi_codes = agg.codes FROM agg WHERE z.slug = agg.slug;
