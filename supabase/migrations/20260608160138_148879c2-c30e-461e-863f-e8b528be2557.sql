
CREATE OR REPLACE FUNCTION public.omi_zones_by_points(p_lats double precision[], p_lngs double precision[])
RETURNS TABLE(idx integer, zona text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH pts AS (
    SELECT
      ord::integer AS idx,
      lat,
      p_lngs[ord] AS lng
    FROM unnest(p_lats) WITH ORDINALITY AS t(lat, ord)
  )
  SELECT
    p.idx,
    (
      SELECT g.zona
      FROM public.omi_zone_geometry g
      WHERE extensions.ST_Contains(g.geom, extensions.ST_SetSRID(extensions.ST_Point(p.lng, p.lat), 4326))
      LIMIT 1
    ) AS zona
  FROM pts p;
$$;
GRANT EXECUTE ON FUNCTION public.omi_zones_by_points(double precision[], double precision[]) TO service_role, authenticated;
