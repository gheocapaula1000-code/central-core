CREATE OR REPLACE FUNCTION public.st_zone_geojson_by_descr(p_descr text)
RETURNS TABLE(geojson text, lat double precision, lng double precision)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    extensions.ST_AsGeoJSON(g.geom) AS geojson,
    extensions.ST_Y(extensions.ST_Centroid(g.geom)) AS lat,
    extensions.ST_X(extensions.ST_Centroid(g.geom)) AS lng
  FROM public.omi_zone_geometry g
  WHERE g.comune_descrizione ILIKE 'padova'
    AND g.zona_descr ILIKE p_descr
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.st_zone_geojson_by_descr(text) TO service_role, authenticated;